#!/usr/bin/env node
/**
 * cf-tunnel.js — Pure Node.js Cloudflare Tunnel Client
 *
 * Translates the Python cloudflared-equivalent (app.py) to Node.js using
 * a self-implemented HTTP/2 frame layer (no built-in http2 module) plus the
 * hpack npm package for HPACK header compression.
 *
 * Usage:
 *   export CF_TUNNEL_TOKEN="eyJhIjo..."
 *   export TARGET_PORT=3000
 *   node cf-tunnel.js
 */

const tls = require('tls');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require("path");
const url = require("url");
const fs = require("fs");
const { Buffer } = require('buffer');
const util = require('util');

let HPACK, uuidParse, uuidStringify;
try {
  HPACK = require('hpack');
} catch {
  console.error('Missing dependency: run "npm install hpack"');
  process.exit(1);
}
try {
  uuidParse = require('uuid').parse;
  uuidStringify = require('uuid').stringify;
} catch {
  console.error('Missing dependency: run "npm install uuid"');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// Configuration (from environment)
// ────────────────────────────────────────────────────────────────
const CF_TUNNEL_TOKEN = process.env.CF_TUNNEL_TOKEN || 'xxx';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || process.env.PORT || '3000', 10);
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const EDGE_HOSTS = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'];
const EDGE_PORT = 7844;
const NUM_CONNECTIONS = 4;
const REGISTRATION_SERVER_ID = 0xf71695ec7fe85497n;
const VERSION = '2024.10.0';
const FEATURES = ['serialized_headers', 'ha-connections'];

function randomBytes(n) { return crypto.randomBytes(n); }

// ────────────────────────────────────────────────────────────────
// Cap'n Proto Message Builder
//
// Assembles Cap'n Proto serialized messages by manually constructing
// 64-bit words.  Matches the Python CapnpMessage class exactly.
// ────────────────────────────────────────────────────────────────
class CapnpMessage {
  constructor() {
    this.words = []; // bigint[]
  }

  allocate(wordCount) {
    const offset = this.words.length;
    for (let i = 0; i < wordCount; i++) this.words.push(0n);
    return offset;
  }

  setStructPointer(ptrOff, targetOff, dataWords, pointerWords) {
    const offset = BigInt(targetOff - ptrOff - 1);
    const low = (offset << 2n) & 0xfffffffen;
    const hi = (BigInt(dataWords) & 0xffffn) | ((BigInt(pointerWords) & 0xffffn) << 16n);
    this.words[ptrOff] = low | (hi << 32n);
  }

  setUint8(wo, bi, v) {
    const m = ~(0xffn << BigInt(bi * 8)) & 0xffffffffffffffffn;
    this.words[wo] = (this.words[wo] & m) | (BigInt(v & 0xff) << BigInt(bi * 8));
  }

  setUint16(wo, bi, v) {
    const m = ~(0xffffn << BigInt(bi * 8)) & 0xffffffffffffffffn;
    this.words[wo] = (this.words[wo] & m) | (BigInt(v & 0xffff) << BigInt(bi * 8));
  }

  setUint32(wo, bi, v) {
    const m = ~(0xffffffffn << BigInt(bi * 8)) & 0xffffffffffffffffn;
    this.words[wo] = (this.words[wo] & m) | (BigInt(v >>> 0) << BigInt(bi * 8));
  }

  setUint64(wo, v) {
    this.words[wo] = BigInt(v) & 0xffffffffffffffffn;
  }

  setUint8AtWord(wo, byteOff, val) {
    this.setUint8(wo, byteOff, val);
  }

  /** Write null-terminated text. Returns content word offset. */
  writeText(ptrOff, text) {
    const utf8 = Buffer.from(text, 'utf-8');
    const byteCount = utf8.length + 1;
    const wc = Math.ceil(byteCount / 8);
    const co = this.allocate(wc);
    for (let i = 0; i < utf8.length; i++)
      this.setUint8(co + Math.floor(i / 8), i % 8, utf8[i]);
    const off = co - ptrOff - 1;
    this.words[ptrOff] =
      ((BigInt(off << 2) | 1n) & 0xffffffffn) |
      ((2n | ((BigInt(byteCount) & 0x1fffffffn) << 3n)) << 32n);
    return co;
  }

  /** Write raw binary data. */
  writeData(ptrOff, data) {
    const bc = data.length;
    const wc = Math.ceil(bc / 8);
    const co = this.allocate(wc);
    for (let i = 0; i < data.length; i++)
      this.setUint8(co + Math.floor(i / 8), i % 8, data[i]);
    const off = co - ptrOff - 1;
    this.words[ptrOff] =
      ((BigInt(off << 2) | 1n) & 0xffffffffn) |
      ((2n | ((BigInt(bc) & 0x1fffffffn) << 3n)) << 32n);
    return co;
  }

  /** Write a list of text strings (list-of-pointers). */
  writeTextList(ptrOff, texts) {
    if (!texts || texts.length === 0) { this.words[ptrOff] = 0n; return -1; }
    const lo = this.allocate(texts.length);
    const off = lo - ptrOff - 1;
    this.words[ptrOff] =
      ((BigInt(off << 2) | 1n) & 0xffffffffn) |
      ((6n | ((BigInt(texts.length) & 0x1fffffffn) << 3n)) << 32n);
    for (let i = 0; i < texts.length; i++) this.writeText(lo + i, texts[i]);
    return lo;
  }

  toBytes() {
    const buf = Buffer.alloc(8 + this.words.length * 8);
    buf.writeUInt32LE(0, 0);           // segmentCount - 1 = 0
    buf.writeUInt32LE(this.words.length, 4); // segmentSize
    for (let i = 0; i < this.words.length; i++)
      buf.writeBigUInt64LE(this.words[i], 8 + i * 8);
    return buf;
  }
}

// ────────────────────────────────────────────────────────────────
// Cap'n Proto RPC Message Constructors
// ────────────────────────────────────────────────────────────────
class CapnpRpc {
  static get MSG_BOOTSTRAP() { return 8; }
  static get MSG_CALL() { return 2; }
  static get REG_SERVER_ID() { return 0xf71695ec7fe85497n; }

  static bootstrap(qid) {
    const msg = new CapnpMessage();
    const rp = msg.allocate(1), md = msg.allocate(1), mp = msg.allocate(1);
    msg.setStructPointer(rp, md, 1, 1);
    msg.setUint16(md, 0, CapnpRpc.MSG_BOOTSTRAP);
    const bd = msg.allocate(1); msg.allocate(1);
    msg.setStructPointer(mp, bd, 1, 1);
    msg.setUint32(bd, 0, qid);
    return msg.toBytes();
  }

  static callRegisterConnection(qid, bsqid, accountTag, tunnelSecret,
    tunnelIdBytes, connIdx, clientId, version, arch, features) {
    const msg = new CapnpMessage();
    const rp = msg.allocate(1), md = msg.allocate(1), mp = msg.allocate(1);
    msg.setStructPointer(rp, md, 1, 1);
    msg.setUint16(md, 0, CapnpRpc.MSG_CALL);

    const cd0 = msg.allocate(1), cd1 = msg.allocate(1), cd2 = msg.allocate(1);
    const cp0 = msg.allocate(1), cp1 = msg.allocate(1), cp2 = msg.allocate(1);
    msg.setStructPointer(mp, cd0, 3, 3);
    msg.setUint32(cd0, 0, qid);
    msg.setUint16(cd0, 4, 0); msg.setUint16(cd0, 6, 0);
    msg.setUint64(cd1, CapnpRpc.REG_SERVER_ID);

    const mtd = msg.allocate(1), mtp = msg.allocate(1);
    msg.setStructPointer(cp0, mtd, 1, 1);
    msg.setUint16(mtd, 4, 1);
    const pad = msg.allocate(1); msg.allocate(1);
    msg.setStructPointer(mtp, pad, 1, 1);
    msg.setUint32(pad, 0, bsqid);

    const pp0 = msg.allocate(1), pp1 = msg.allocate(1);
    msg.setStructPointer(cp1, pp0, 0, 2);
    const pmd = msg.allocate(1), pmp0 = msg.allocate(1), pmp1 = msg.allocate(1), pmp2 = msg.allocate(1);
    msg.setStructPointer(pp0, pmd, 1, 3);
    msg.setUint8(pmd, 0, connIdx);

    const ap0 = msg.allocate(1), ap1 = msg.allocate(1);
    msg.setStructPointer(pmp0, ap0, 0, 2);
    msg.writeText(ap0, accountTag);
    msg.writeData(ap1, tunnelSecret);
    msg.writeData(pmp1, tunnelIdBytes);

    const od = msg.allocate(1), op0 = msg.allocate(1), op1 = msg.allocate(1);
    msg.setStructPointer(pmp2, od, 1, 2);
    const ci0 = msg.allocate(1), ci1 = msg.allocate(1), ci2 = msg.allocate(1), ci3 = msg.allocate(1);
    msg.setStructPointer(op0, ci0, 0, 4);
    msg.writeData(ci0, clientId);
    if (features) msg.writeTextList(ci1, features);
    msg.writeText(ci2, version);
    msg.writeText(ci3, arch);
    return msg.toBytes();
  }
}

// ────────────────────────────────────────────────────────────────
// HTTP/2 Constants
// ────────────────────────────────────────────────────────────────
const H2 = {
  TYPE_DATA: 0x0, TYPE_HEADERS: 0x1, TYPE_PRIORITY: 0x2,
  TYPE_RST_STREAM: 0x3, TYPE_SETTINGS: 0x4, TYPE_PUSH_PROMISE: 0x5,
  TYPE_PING: 0x6, TYPE_GOAWAY: 0x7, TYPE_WINDOW_UPDATE: 0x8,
  TYPE_CONTINUATION: 0x9,

  FLAG_END_STREAM: 0x1, FLAG_END_HEADERS: 0x4,
  FLAG_PADDED: 0x8, FLAG_PRIORITY: 0x20, FLAG_SETTINGS_ACK: 0x1,

  SETTINGS_HEADER_TABLE_SIZE: 0x1, SETTINGS_ENABLE_PUSH: 0x2,
  SETTINGS_MAX_CONCURRENT_STREAMS: 0x3, SETTINGS_INITIAL_WINDOW_SIZE: 0x4,
  SETTINGS_MAX_FRAME_SIZE: 0x5, SETTINGS_MAX_HEADER_LIST_SIZE: 0x6,

  NO_ERROR: 0x0, PROTOCOL_ERROR: 0x1, INTERNAL_ERROR: 0x2,
  FLOW_CONTROL_ERROR: 0x3, CANCEL: 0x8,

  DEFAULT_WINDOW_SIZE: 65535, DEFAULT_MAX_FRAME_SIZE: 16384,
  CLIENT_PREFACE: 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n',
};

// ────────────────────────────────────────────────────────────────
// HTTP/2 Frame I/O — Builder + Parser
// ────────────────────────────────────────────────────────────────
const H2Frame = {
  /** Parse the 9-byte frame header */
  parseHeader(buf) {
    const length = (buf[0] << 16) | (buf[1] << 8) | buf[2];
    return {
      length,
      type: buf[3],
      flags: buf[4],
      streamId: buf.readUInt32BE(5) & 0x7fffffff,
      total: 9 + length,
    };
  },

  build(type, flags, streamId, payload) {
    const pay = payload || Buffer.alloc(0);
    const h = Buffer.alloc(9);
    h[0] = (pay.length >> 16) & 0xff;
    h[1] = (pay.length >> 8) & 0xff;
    h[2] = pay.length & 0xff;
    h[3] = type & 0xff;
    h[4] = flags & 0xff;
    h.writeUInt32BE(streamId & 0x7fffffff, 5);
    return pay.length ? Buffer.concat([h, pay]) : h;
  },

  settings(entries, ack) {
    if (ack) return H2Frame.build(H2.TYPE_SETTINGS, H2.FLAG_SETTINGS_ACK, 0);
    const p = Buffer.alloc(entries.length * 6);
    for (let i = 0; i < entries.length; i++) {
      p.writeUInt16BE(entries[i][0], i * 6);
      p.writeUInt32BE(entries[i][1], i * 6 + 2);
    }
    return H2Frame.build(H2.TYPE_SETTINGS, 0, 0, p);
  },

  settingsAck() { return H2Frame.settings([], true); },

  headers(streamId, hpackData, endStream) {
    let f = H2.FLAG_END_HEADERS;
    if (endStream) f |= H2.FLAG_END_STREAM;
    return H2Frame.build(H2.TYPE_HEADERS, f, streamId, hpackData);
  },

  dataFrame(streamId, data, endStream) {
    return H2Frame.build(H2.TYPE_DATA, endStream ? H2.FLAG_END_STREAM : 0, streamId, data);
  },

  ping(opaque8, ack) {
    return H2Frame.build(H2.TYPE_PING, ack ? H2.FLAG_SETTINGS_ACK : 0, 0, opaque8);
  },

  windowUpdate(streamId, increment) {
    const p = Buffer.alloc(4);
    p.writeUInt32BE(increment & 0x7fffffff, 0);
    return H2Frame.build(H2.TYPE_WINDOW_UPDATE, 0, streamId, p);
  },

  goaway(lastStreamId, errCode) {
    const p = Buffer.alloc(8);
    p.writeUInt32BE(lastStreamId & 0x7fffffff, 0);
    p.writeUInt32BE(errCode, 4);
    return H2Frame.build(H2.TYPE_GOAWAY, 0, 0, p);
  },

  rstStream(streamId, errCode) {
    const p = Buffer.alloc(4);
    p.writeUInt32BE(errCode, 0);
    return H2Frame.build(H2.TYPE_RST_STREAM, 0, streamId, p);
  },
};

// ────────────────────────────────────────────────────────────────
// Buffered Frame Reader
// Accumulates partial data and emits complete frames.
// ────────────────────────────────────────────────────────────────
class FrameReader {
  constructor() { this.buf = null; }

  /**
   * @param {Buffer} data
   * @param {(type:number, flags:number, streamId:number, payload:Buffer)=>void} onFrame
   */
  feed(data, onFrame) {
    this.buf = this.buf ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    while (this.buf && this.buf.length >= 9) {
      const { length, type, flags, streamId, total } = H2Frame.parseHeader(this.buf);
      if (this.buf.length < total) break;
      const payload = this.buf.subarray(9, 9 + length);
      this.buf = this.buf.subarray(total);
      if (this.buf.length === 0) this.buf = null;
      try { onFrame(type, flags, streamId, payload); } catch (e) {
        console.error('Frame handler error:', e.message);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// HTTP/2 Connection State Machine
// ────────────────────────────────────────────────────────────────
class H2Connection {
  /**
   * @param {import('tls').TLSSocket} socket
   * @param {object} cb
   * @param {function} cb.onRequest - (streamId, headers, endStream) => void
   * @param {function} cb.onData - (streamId, data) => void
   * @param {function} cb.onStreamEnd - (streamId) => void
   */
  constructor(socket, cb) {
    this.socket = socket;
    this.cb = cb;
    this.reader = new FrameReader();
    this.hpackEnc = new HPACK();
    this.hpackDec = new HPACK();

    this.localSettings = {
      [H2.SETTINGS_HEADER_TABLE_SIZE]: 4096,
      [H2.SETTINGS_ENABLE_PUSH]: 0,
      [H2.SETTINGS_MAX_CONCURRENT_STREAMS]: 256,
      [H2.SETTINGS_INITIAL_WINDOW_SIZE]: 65535,
      [H2.SETTINGS_MAX_FRAME_SIZE]: 16384,
    };
    this.remoteSettings = Object.assign({}, this.localSettings);
    this.remoteSettings[H2.SETTINGS_ENABLE_PUSH] = 1;

    this.localWindow = 65535;
    this.remoteWindow = 65535;
    /** @type {Map<number, {window:number, dataWindow:number, headersReceived:boolean, ended:boolean}>} */
    this.streams = new Map();

    // For "server" role: we haven't seen the client preface yet
    this.prefaceSeen = false;
    this.outBuf = Buffer.alloc(0);
    this._flushing = false;
  }

  /** Feed received bytes into the H/2 state machine. */
  receive(data) {
    // Handle client preface (24-byte magic string)
    if (!this.prefaceSeen) {
      const needed = Buffer.byteLength(H2.CLIENT_PREFACE);
      if (data.length < needed) {
        // Partial preface — wait for more
        // For simplicity, assume it arrives in one chunk from Cloudflare
        return;
      }
      if (data.toString('utf-8', 0, needed) !== H2.CLIENT_PREFACE) {
        console.error('Bad HTTP/2 client preface, closing');
        this.socket.destroy();
        return;
      }
      this.prefaceSeen = true;
      data = data.subarray(needed);
      // As server, send our SETTINGS now
      this._write(H2Frame.settings(
        Object.entries(this.localSettings).map(([k, v]) => [parseInt(k), v]), false
      ));
    }

    if (data.length > 0) {
      this.reader.feed(data, (t, f, sid, p) => this._handleFrame(t, f, sid, p));
    }
  }

  /** Queue outgoing data. */
  _write(buf) {
    this.outBuf = this.outBuf.length ? Buffer.concat([this.outBuf, buf]) : buf;
    this._flush();
  }

  _flush() {
    if (this._flushing || !this.outBuf.length) return;
    this._flushing = true;
    try {
      this.socket.write(this.outBuf);
      this.outBuf = Buffer.alloc(0);
    } catch (e) {
      console.error('H2 write error:', e.message);
    }
    this._flushing = false;
  }

  sendHeaders(streamId, headers, endStream) {
    const list = headers.map(([k, v]) => [k, String(v)]);
    const enc = this.hpackEnc.encode(list);
    this._write(H2Frame.headers(streamId, enc, endStream));
  }

  sendData(streamId, data, endStream) {
    const maxSize = this.remoteSettings[H2.SETTINGS_MAX_FRAME_SIZE] || 16384;
    let offset = 0;
    while (offset < data.length) {
      const chunk = data.subarray(offset, offset + maxSize);
      offset += chunk.length;
      const last = endStream && offset >= data.length;
      this._write(H2Frame.dataFrame(streamId, chunk, last));
      this.remoteWindow -= chunk.length;
      const s = this.streams.get(streamId);
      if (s) s.window = (s.window || 0) - chunk.length;
      if (last) break;
    }
    if (endStream && data.length === 0) {
      this._write(H2Frame.dataFrame(streamId, Buffer.alloc(0), true));
    }
  }

  sendWindowUpdate(streamId, increment) {
    this._write(H2Frame.windowUpdate(streamId, increment));
  }

  sendPing() {
    this._write(H2Frame.ping(randomBytes(8), false));
  }

  close(errCode) {
    try { this._write(H2Frame.goaway(0, errCode || H2.NO_ERROR)); } catch {}
  }

  // ── Frame Handlers ──

  _handleFrame(type, flags, streamId, payload) {
    switch (type) {
      case H2.TYPE_SETTINGS:
        this._onSettings(flags, payload); break;
      case H2.TYPE_HEADERS:
        this._onHeaders(streamId, flags, payload); break;
      case H2.TYPE_DATA:
        this._onData(streamId, flags, payload); break;
      case H2.TYPE_PING:
        this._onPing(flags, payload); break;
      case H2.TYPE_WINDOW_UPDATE:
        this._onWindowUpdate(streamId, payload); break;
      case H2.TYPE_GOAWAY:
        break;
        if (this.cb.onGoaway) this.cb.onGoaway();
        break;
      case H2.TYPE_RST_STREAM:
        this.streams.delete(streamId);
        break;
      case H2.TYPE_PRIORITY:
        break; // safe to ignore
      default:
        break;
    }
  }

  _onSettings(flags, payload) {
    if (flags & H2.FLAG_SETTINGS_ACK) return;
    for (let i = 0; i + 6 <= payload.length; i += 6) {
      const id = payload.readUInt16BE(i);
      const val = payload.readUInt32BE(i + 2);
      this.remoteSettings[id] = val;
      if (id === H2.SETTINGS_INITIAL_WINDOW_SIZE) {
        const delta = val - 65535;
        this.remoteWindow += delta;
        for (const [, s] of this.streams) s.window += delta;
      }
    }
    this._write(H2Frame.settingsAck());
  }

  _onHeaders(streamId, flags, payload) {
    let off = 0;
    if (flags & H2.FLAG_PADDED) off = 1 + payload[0];
    if (flags & H2.FLAG_PRIORITY) off += 5;
    const hpackData = payload.subarray(off);
    let decoded;
    try { decoded = this.hpackDec.decode(hpackData); } catch (e) {
      console.error(`HPACK decode error on stream ${streamId}:`, e.message);
      decoded = [];
    }
    const endStream = !!(flags & H2.FLAG_END_STREAM);

    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, {
        window: this.remoteSettings[H2.SETTINGS_INITIAL_WINDOW_SIZE] || 65535,
        dataWindow: this.remoteSettings[H2.SETTINGS_INITIAL_WINDOW_SIZE] || 65535,
        ended: endStream,
      });
    } else {
      this.streams.get(streamId).ended = endStream;
    }

    if (this.cb.onRequest) this.cb.onRequest(streamId, decoded, endStream);
    if (endStream && this.cb.onStreamEnd) this.cb.onStreamEnd(streamId);
  }

  _onData(streamId, flags, payload) {
    const endStream = !!(flags & H2.FLAG_END_STREAM);

    // Connection-level flow control
    this.localWindow -= payload.length;
    if (this.localWindow < 32768) {
      const inc = 65535 - this.localWindow;
      this.sendWindowUpdate(0, inc);
      this.localWindow += inc;
    }

    // Per-stream flow control
    const s = this.streams.get(streamId);
    if (s) {
      s.dataWindow -= payload.length;
      if (s.dataWindow < 32768) {
        const inc = 65535 - s.dataWindow;
        this.sendWindowUpdate(streamId, inc);
        s.dataWindow += inc;
      }
      if (endStream) s.ended = true;
    }

    if (this.cb.onData) this.cb.onData(streamId, payload);
    if (endStream && this.cb.onStreamEnd) this.cb.onStreamEnd(streamId);
  }

  _onPing(flags, payload) {
    if (!(flags & H2.FLAG_SETTINGS_ACK))
      this._write(H2Frame.ping(payload, true));
  }

  _onWindowUpdate(streamId, payload) {
    const inc = payload.readUInt32BE(0) & 0x7fffffff;
    if (streamId === 0) this.remoteWindow += inc;
    else {
      const s = this.streams.get(streamId);
      if (s) s.window += inc;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Cloudflare Tunnel Client
// ────────────────────────────────────────────────────────────────
class CfTunnelClient {
  constructor(tokenJson, targetPort, targetHost) {
    this.targetPort = targetPort;
    this.targetHost = targetHost || '127.0.0.1';
    this.stopped = false;
    this._tunnelReady = false;

    // Parse token
    try {
      const tok = JSON.parse(Buffer.from(tokenJson, 'base64').toString('utf-8'));
      this.accountTag = tok.a;
      this.tunnelSecret = Buffer.from(tok.s, 'base64');
      this.tunnelIdBytes = uuidParse(tok.t);
      this.tunnelIdStr = tok.t;
    } catch (e) {
      console.error('Invalid CF Tunnel token:', e.message);
      throw e;
    }

    // Per-connection stream data buffers
    // Map: streamId -> { headers, chunks: Buffer[], wsSocket, ended }
    this.streamStates = new Map();
  }

  run() {
    for (let i = 0; i < NUM_CONNECTIONS; i++)
      this._connectLoop(i);
  }

  stop() {
    this.stopped = true;
    // connections are self-managed via auto-reconnect
  }

  // ── Connection Loop ──

  _connectLoop(idx) {
    if (this.stopped) return;

    const host = EDGE_HOSTS[idx % EDGE_HOSTS.length];

    const sock = tls.connect({
      host,
      port: EDGE_PORT,
      ALPNProtocols: ['h2'],
      servername: 'h2.cftunnel.com',
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    }, () => {
      this._onConnected(idx, sock);
    });

    sock.on('error', (e) => {
      console.error(`[${idx}] connect error:`, e.message);
      setTimeout(() => this._connectLoop(idx), 2000);
    });
  }

  _onConnected(idx, sock) {
    const h2 = new H2Connection(sock, {
      onRequest: (sid, headers, endStream) =>
        this._onRequest(idx, h2, sock, sid, headers, endStream),
      onData: (sid, data) =>
        this._onData(idx, h2, sock, sid, data),
      onStreamEnd: (sid) =>
        this._onStreamEnd(idx, h2, sock, sid),
      onGoaway: () => sock.destroy(),
    });

    sock.on('data', (data) => {
      try { h2.receive(data); } catch (e) {
        console.error(`[${idx}] H2 error:`, e.message);
        console.error(e.stack.split('\n').slice(0, 4).join('\n'));
      }
    });

    sock.on('close', () => {
      this._cleanupConnection(sock);
      setTimeout(() => this._connectLoop(idx), 2000);
    });

    sock.on('error', (e) => {
      // Errors after connection are handled by 'close'
    });
  }

  _cleanupConnection(sock) {
    // Clean up any stream states tied to this connection
    // (We can't easily map stream states to connections without a tracking structure,
    //  but they'll be garbage collected since we replace the Map on each new connection)
    sock.destroy();
  }

  // ── H2 Event Handlers ──

  /** Track a stream's incoming data. */
  _ensureStream(sid) {
    if (!this.streamStates.has(sid)) {
      this.streamStates.set(sid, { headers: null, chunks: [], wsSocket: null, ended: false });
    }
    return this.streamStates.get(sid);
  }

  _onRequest(idx, h2, sock, sid, headers, endStream) {
    const st = this._ensureStream(sid);
    st.headers = headers;

    const isControl = headers.some(
      ([k, v]) => k === 'cf-cloudflared-proxy-connection-upgrade' && v === 'control-stream'
    );

    if (isControl) {
      this._handleControlStream(idx, h2, sock, sid);
      return;
    }

    const isWs = headers.some(
      ([k, v]) => k.toLowerCase() === 'upgrade' && v.toLowerCase() === 'websocket'
    ) || headers.some(([k]) => k.toLowerCase() === 'sec-websocket-key');

    if (isWs) {
      this._handleWebSocket(idx, h2, sock, sid, headers);
      return;
    }

    // Regular HTTP: if endStream, handle immediately; otherwise wait for data
    if (endStream) {
      this._handleHttp(idx, h2, sid, headers, Buffer.concat(st.chunks), true);
      st.ended = true;
    }
    // else: wait for DATA frames + END_STREAM
  }

  _onData(idx, h2, sock, sid, data) {
    const st = this._ensureStream(sid);

    // If this stream has a WebSocket local socket, route data there directly
    if (st.wsSocket) {
      try { st.wsSocket.write(data); } catch (e) {
        console.error(`[${idx}] WS->local error:`, e.message);
      }
      return;
    }

    // Buffer for regular HTTP
    st.chunks.push(data);
  }

  _onStreamEnd(idx, h2, sock, sid) {
    const st = this.streamStates.get(sid);
    if (!st) return;
    st.ended = true;

    // Close WS socket if any
    if (st.wsSocket) {
      try { st.wsSocket.destroy(); } catch {}
      this.streamStates.delete(sid);
      return;
    }

    // Regular HTTP: now make the proxy request
    if (st.headers && !st.headers.some(([k]) => k === ':status')) {
      this._handleHttp(idx, h2, sid, st.headers, Buffer.concat(st.chunks), true);
    }

    this.streamStates.delete(sid);
  }

  // ── Control Stream ──

  _handleControlStream(idx, h2, sock, sid) {
    // Send 200 OK on the control stream
    h2.sendHeaders(sid, [[':status', '200']], false);

    // Bootstrap message as DATA frame
    const bsMsg = CapnpRpc.bootstrap(0);
    h2.sendData(sid, bsMsg, false);

    // RegisterConnection message as DATA frame
    const regMsg = CapnpRpc.callRegisterConnection(
      1, 0,
      this.accountTag, this.tunnelSecret, this.tunnelIdBytes,
      idx, randomBytes(16), VERSION, 'nodejs', FEATURES
    );
    h2.sendData(sid, regMsg, false);

    if (!this._tunnelReady) {
      this._tunnelReady = true;
      console.log('  √ server success');
    }
  }

  // ── HTTP Proxy ──

  _handleHttp(idx, h2, sid, headers, body, endStream) {
    const headerObj = {};
    for (const [k, v] of headers) {
      if (!k.startsWith(':')) headerObj[k] = v;
    }

    const method = this._getHeader(headers, ':method') || 'GET';
    const path = this._getHeader(headers, ':path') || '/';
    if (!headerObj.host) headerObj.host = this._getHeader(headers, ':authority') ||
      `${this.targetHost}:${this.targetPort}`;

    const opts = {
      hostname: this.targetHost,
      port: this.targetPort,
      path,
      method,
      headers: headerObj,
      timeout: 30000,
    };

    const proxyReq = http.request(opts, (proxyRes) => {
      const rh = [[':status', String(proxyRes.statusCode)]];
      const hopByHop = new Set([
        'connection','keep-alive','transfer-encoding','upgrade',
        'proxy-authenticate','proxy-authorization','te','trailer',
      ]);
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!hopByHop.has(k.toLowerCase()))
          rh.push([k, Array.isArray(v) ? v.join(', ') : v]);
      }
      h2.sendHeaders(sid, rh, false);

      proxyRes.on('data', (c) => h2.sendData(sid, c, false));
      proxyRes.on('end', () => h2.sendData(sid, Buffer.alloc(0), true));
    });

    proxyReq.on('error', (e) => {
      console.error(`[${idx}] HTTP proxy error:`, e.message);
      try {
        h2.sendHeaders(sid, [[':status', '502']], false);
        h2.sendData(sid, Buffer.from(`502 Bad Gateway: ${e.message}`), true);
      } catch {}
    });

    proxyReq.on('timeout', () => { proxyReq.destroy(new Error('timeout')); });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  }

  // ── WebSocket Proxy ──

  _handleWebSocket(idx, h2, sock, sid, headers) {
    const path = this._getHeader(headers, ':path') || '/';
    const authority = this._getHeader(headers, ':authority') ||
      `${this.targetHost}:${this.targetPort}`;

    const local = new net.Socket();
    const st = this._ensureStream(sid);

    local.connect(this.targetPort, this.targetHost, () => {
      // Build HTTP/1.1 Upgrade request
      let req = `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\n`;
      for (const [k, v] of headers) {
        if (k.startsWith(':')) continue;
        const kl = k.toLowerCase();
        if (kl === 'host' || kl === 'connection' || kl === 'upgrade' ||
            kl === 'transfer-encoding' || kl === 'keep-alive') continue;
        req += `${k}: ${v}\r\n`;
      }
      req += 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
      local.write(req);

      // Read response headers
      let respBuf = Buffer.alloc(0);
      const onLocalHead = (chunk) => {
        respBuf = Buffer.concat([respBuf, chunk]);
        const end = respBuf.indexOf('\r\n\r\n');
        if (end === -1) return;

        const headStr = respBuf.toString('utf-8', 0, end);
        const lines = headStr.split('\r\n');
        const statusCode = parseInt(lines[0].split(' ')[1], 10) || 502;
        const h2Status = statusCode === 101 ? 200 : statusCode;

        const rh = [[':status', String(h2Status)]];
        const hopByHop = new Set(['connection','keep-alive','transfer-encoding','upgrade']);
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i]) continue;
          const ci = lines[i].indexOf(':');
          if (ci === -1) continue;
          const k = lines[i].substring(0, ci).trim().toLowerCase();
          const v = lines[i].substring(ci + 1).trim();
          if (!hopByHop.has(k)) rh.push([k, v]);
        }

        h2.sendHeaders(sid, rh, false);

        // If upgrade failed
        if (statusCode !== 101) {
          const body = respBuf.subarray(end + 4);
          if (body.length) h2.sendData(sid, body, true);
          else h2.sendData(sid, Buffer.alloc(0), true);
          local.destroy();
          local.removeListener('data', onLocalHead);
          return;
        }

        // Send any data that came after headers
        const extra = respBuf.subarray(end + 4);
        if (extra.length) {
          // This should be forwarded via the H2 stream
          // But at this point we don't have a way to push it back
          // It's very unlikely to happen for WS upgrades
        }

        st.wsSocket = local;
        local.removeListener('data', onLocalHead);

        // Local -> H2 pump
        local.on('data', (d) => {
          try { h2.sendData(sid, d, false); } catch {}
        });
        local.on('close', () => {
          try { h2.sendData(sid, Buffer.alloc(0), true); } catch {}
          if (this.streamStates.get(sid) === st) this.streamStates.delete(sid);
        });
      };

      local.on('data', onLocalHead);
    });

    local.on('error', (e) => {
      console.error(`[${idx}] WS local error:`, e.message);
      try {
        h2.sendHeaders(sid, [[':status', '502']], false);
        h2.sendData(sid, Buffer.from(`502: ${e.message}`), true);
      } catch {}
    });
  }

  // ── Helpers ──

  _getHeader(headers, name) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  }
}


const { Server: WebSocketServer, createWebSocketStream } = require("ws");

// ────────────────────────────────────────────────────────────────
// VLESS+WS 配置
// ────────────────────────────────────────────────────────────────
const UUID = (process.env.UUID || "ee1feada-4e2f-4dc3-aaa6-f97aeed0286b").replaceAll("-", "");
const WSPATH = process.env.WSPATH || "/ray10086";
const PORT = parseInt(process.env.PORT || "3000", 10);
const DOMAIN = process.env.DOMAIN || "";

// 1. HTTP 服务器 (用于页面 + WS 升级)
const server = http.createServer((req, res) => {
  // 订阅链接 /getsub
  if (req.method === "GET" && req.url === "/getsub") {
    const subdomain = DOMAIN || req.headers.host?.split(":")[0] || "";
    if (!subdomain) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No domain available. Access via tunnel or set DOMAIN env var.\n");
      return;
    }
    const vlessLink = "vless://" + UUID + "@" + subdomain + ":443?path=" + encodeURIComponent(WSPATH) + "&encryption=none&type=ws&host=" + subdomain + "#" + subdomain;
    const b64 = Buffer.from(vlessLink).toString("base64");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Subscription-Userinfo": "upload=0; download=0; total=0; expire=0"
    });
    res.end(b64 + "\n");
    return;
  }


  if (req.method === 'GET' && req.url === '/') {
    // 尝试读取 index.html, 否则返回默认页面
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('VLESS+WS Proxy is running\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// 2. WebSocket upgrade
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  if (pathname === WSPATH) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 3. VLESS 协议处理
wss.on('connection', (ws) => {
  ws.once('message', (msg) => {
    // --- VLESS 协议解析 ---
    // msg[0]: 协议版本 (VERSION)
    // msg[1..16]: UUID (16 bytes)
    // msg[17]: 附加长度 (addon)
    // msg[18..18+addon]: 附加数据
    // 然后: port(2) + atyp(1) + address(Variable)
    const VERSION = msg[0];
    const id = msg.slice(1, 17);

    // 验证 UUID
    for (let i = 0; i < 16; i++) {
      if (id[i] !== parseInt(UUID.substr(i * 2, 2), 16)) return;
    }

    // 解析目标地址
    let i = msg[17] + 19; // 跳过 VERSION + UUID + addonLen + addon
    const port = msg.readUInt16BE(i); i += 2;
    const ATYP = msg[i]; i += 1;

    let host;
    if (ATYP === 1) {
      // IPv4
      host = msg.slice(i, i + 4).join('.');
      i += 4;
    } else if (ATYP === 2) {
      // 域名
      const len = msg[i]; i += 1;
      host = new TextDecoder().decode(msg.slice(i, i + len));
      i += len;
    } else if (ATYP === 3) {
      // IPv6
      const parts = [];
      for (let j = 0; j < 8; j++) {
        parts.push(msg.readUInt16BE(i + j * 2).toString(16));
      }
      host = parts.join(':');
      i += 16;
    } else {
      return;
    }

    console.log('VLESS conn:', host, port);

    // 回复 VERSION + 0 (成功)
    ws.send(new Uint8Array([VERSION, 0]));

    // 建立 TCP 隧道
    const duplex = createWebSocketStream(ws);
    const target = net.connect({ host, port }, function () {
      // 发送剩余数据
      if (i < msg.length) {
        this.write(msg.slice(i));
      }
      // 双向管道
      duplex
        .on('error', (e) => console.error('VLESS duplex error:', e.message))
        .pipe(this)
        .on('error', (e) => console.error('VLESS target error:', e.message))
        .pipe(duplex);
    });

    target.on('error', (e) => {
      console.error(`VLESS conn error ${host}:${port} -`, e.message);
    });

  }).on('error', (e) => {
    console.error('VLESS message error:', e.message);
  });
});

// ────────────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────────────

// 启动 VLESS+WS 服务器
server.listen(PORT, () => {
  console.log(`\n  √ server started on port ${PORT}\n`);
});

// 启动 CF Tunnel (如果配置了 Token)
if (CF_TUNNEL_TOKEN) {
  const targetPort = parseInt(process.env.TARGET_PORT || String(PORT), 10);
  const targetHost = process.env.TARGET_HOST || "127.0.0.1";

  const tunnel = new CfTunnelClient(CF_TUNNEL_TOKEN, targetPort, targetHost);
  tunnel.run();
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  process.exit(0);
});
