# TOOLS.md — sherry

## What you have
- Shell: node, npm, git, curl (sandboxed — no docker/aws/ssh)
- File read/write on your workspace (which IS the live app code)
- web_fetch, web_search, browser, sub-agents, image analysis
- VibeKit API via the preset `VIBEKIT_*` env vars (see AGENTS.md for endpoints)

## Deploy — ONLY when the user's own message asks for it
Never deploy on your own initiative — "tap **Deploy**" stays the default close.
When the user's message explicitly says deploy/publish/ship/make-it-live:
commit your changes first, then:

```bash
curl -s -X POST "$VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/deploy-workspace?async=1" \
  -H "Authorization: Bearer $VIBEKIT_API_KEY"
# → { "jobId": "…" } — poll every ~5s until status is done|error:
curl -s "$VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/deploy-workspace/jobs/<jobId>" \
  -H "Authorization: Bearer $VIBEKIT_API_KEY"
```
`done` → confirm with the live URL. `error` → report the failing log line and
stop (one deploy attempt per ask — never retry-loop a broken build).

App logs: `GET $VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_SUBDOMAIN/logs`

## Image generation — real assets (logos, heroes, icons, illustrations)
**If `image_generate` is in your tool list, use IT — not this API.** It runs on
the user's own OpenAI account (their key/subscription, nothing billed to
VibeKit credits), and for those accounts the API below refuses with a 409. No
`image_generate` tool → use the API below.
Synchronous and fast (~5–15s): the image is written into your workspace before
the call returns. **Run the curl in the FOREGROUND and wait for the JSON** — if
the shell backgrounds it anyway, poll that process to completion BEFORE ending
your turn. Nothing runs after your turn ends: a backgrounded call you don't
wait for dies orphaned, no image ever lands, and "generating — I'll confirm
when it finishes" is a broken promise. Confirm only from the actual `{"ok":true}`
response. Billed to the user's credits (~4¢/image), so generate with intent —
one good asset, not a gallery of variants.

```bash
curl -s -X POST "$VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/agent/generate-image" \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"minimal flat logo, coffee cup, warm orange on cream","path":"public/images/logo.png"}'
# → { "ok": true, "path": "public/images/logo.png", ... } — reference that path in the app
```

The image is shown to the user in the chat automatically the instant it's
generated — you do NOT attach or send it yourself (you can't). Just say what you
made and where it went; don't promise to "send it over" or "show it below."

**When the user asks to SEE or SHARE an image that already exists** in the
workspace (one you made earlier, or any image file in the app), do NOT paste a
`https://…/images/x.png` link — that link 404s until the app is deployed and
never shows inline. Call `show-image` with the file's workspace path; it renders
the image in the chat immediately. Then say one short line ("here's the moon
image") — nothing else.

```bash
curl -s -X POST "$VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/agent/show-image" \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"path":"public/images/moon.png"}'
# → { "ok": true, "path": "public/images/moon.png", "bytes": 12345 }
```

`path` = where YOUR app serves static files from (public/, static/, assets/…).
Optional: `"aspect_ratio":"16:9"` (hero) · `"model":"openai/gpt-image-1"` (only
when the image must contain readable TEXT — wordmarks/banners; default model is
faster + cheaper and best for everything else). 402 = user out of credits: tell
them plainly and use a CSS/SVG placeholder instead.

## Stock photos & video — FREE, for real imagery
Generic imagery (heroes, backgrounds, product/demo shots, gallery fillers) →
search Pexels through the platform proxy and hotlink the returned CDN URLs.
$0, never burns credits. Division of labor: **stock-media for pictures of the
world · generate-image for BESPOKE assets (logos, icons, custom art) · icon
library for UI glyphs · emoji for none of them.**

```bash
curl -s "$VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/agent/stock-media?query=coffee%20shop&type=photo&count=4" \
  -H "Authorization: Bearer $VIBEKIT_API_KEY"
# → { "ok":true, "photos":[ { "url":"…large", "medium":"…", "small":"…", "alt":"…", "credit":"Photo by X on Pexels" } ] }
# type=video → { "ok":true, "videos":[ { "url":"….mp4", "poster":"…", "duration":12, "credit":"…" } ] }
```

- `medium` for cards/grids, `url` for heroes; always set real `alt` text.
- Videos: use `poster` + `<video muted loop playsinline>` for backgrounds.
- On pages using stock media, add a small footer credit linking to pexels.com.
- Proxy down / no results / 429? Keyless fallbacks — topical:
  `https://loremflickr.com/800/600/coffee` · neutral: `https://picsum.photos/800/600`.
  Never fall back to emoji-as-imagery.

**To hand the user a DOCUMENT** (PDF, CSV, export, .zip, .docx, log, any
non-image file in the workspace), call `send-file` with its workspace path — it
appears in chat as a downloadable attachment instantly (tap to open on mobile,
download on web). Same rule as images: do NOT paste a `https://…` link (404s
until deploy) and never promise to "send it later" — nothing runs after your
turn. Just call it, then say one short line ("here's the CSV export").

```bash
curl -s -X POST "$VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/agent/send-file" \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"path":"reports/q3-export.csv"}'
# → { "ok": true, "path": "reports/q3-export.csv", "name": "q3-export.csv", "mime": "text/csv", "size": 8421 }
```

`send-file` is for any file the user should be able to open/keep; `show-image` is
image-only (renders inline). Max 25MB. 404 = create the file first.

## Boot test (only after dep/server changes — see AGENTS.md §Ship working code)
ONE quiet boot on a random high port, never 3000/3010 or 4000–4999. ALWAYS
background it and capture output to a log, then SHOW the log if it didn't come
up. NEVER run a bare foreground `node server.js`: it blocks until it's killed
and the exec surfaces as an opaque "Exec failed" with no error text, so neither
you nor the user can see WHY it broke — you'd be relaying a dead end.

```bash
P=$((18000+RANDOM%2000)); PORT=$P node server.js > /tmp/boot.log 2>&1 & S=$!
up=; for i in 1 2 3 4 5; do sleep 1; curl -sf -o /dev/null localhost:$P && { up=1; echo "boot OK"; break; }; done
kill $S 2>/dev/null
[ -z "$up" ] && { echo "--- boot FAILED, real error: ---"; tail -40 /tmp/boot.log; }
```

If the log shows the error, FIX it before you report back — never hand the user
a bare "Exec failed"; give them the actual error (or the fix).

## Parallel sub-agents — worktree isolation
When you fan work out to multiple sub-agents that touch DIFFERENT files, give
each its own git worktree (isolated branch + dir) so they never clobber each
other, then merge back. Gated by the app's **Worktree Isolation** / **Auto
Merge** settings — if disabled the create call returns 403, so just work
serially on main. Workflow:

```bash
# 1) Before spawning a sub-agent for a task, make its worktree:
curl -s -X POST $VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/worktree/create \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"taskId":"auth-refactor"}'
# → { "worktreePath": ".worktrees/auth-refactor", "branchName": "agent/task-auth-refactor" }
# 2) Tell that sub-agent to cd into worktreePath and do ALL its edits there.
# 3) When it finishes, merge back (auto-resolves conflicts — prefers newer
#    changes unless code was deleted; if Auto Merge is off, conflicting files
#    come back for you to resolve on the branch, main stays clean):
curl -s -X POST $VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/worktree/merge \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"taskId":"auth-refactor"}'
# List active: GET …/worktrees · Clean up stragglers: POST …/worktree/cleanup
```
Use this only for genuinely parallel, file-disjoint work — for serial edits just
work on main.

## Webhooks
- Users manage webhooks from the dashboard Webhooks tab
- When triggered, you receive the payload in `<webhook_payload>` tags
- Auto-verified: GitHub (X-Hub-Signature-256), Stripe (Stripe-Signature)
- Rate limit: 10/min per app

## Notes
_(Add app-specific notes here: API keys needed, quirks, architecture decisions)_
