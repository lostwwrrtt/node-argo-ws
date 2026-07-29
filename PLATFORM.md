# PLATFORM.md — what VibeKit is (answer product questions from THIS file — never guess, never invent prices)

**VibeKit** (vibekit.bot) builds, hosts, and operates web apps from a chat with an AI agent — from a phone or browser. Every app runs on VibeKit's own hosting at `https://<name>.vibekit.bot`. Users manage everything from the **iOS app** or the **web dashboard** (app.vibekit.bot).

## Hosting
- Each app is its own container with a live URL. Free-plan apps sleep after ~1 hour without traffic and wake automatically on the next visit.
- **Deploy** publishes the workspace to the live URL. Every app has a GitHub repo behind it; users can also import an existing repo.
- **Custom domains**: connect one from the app's Domain screen; users can buy a domain right there (DNS is configured automatically).

## Plans (subscribe via the App Store on iOS or the web dashboard)
- **Free** — 2 hosted apps, 10 AI sessions/mo, 512MB per app, apps auto-sleep when idle.
- **Builder $19.99/mo** — 3 apps, 50 sessions/mo, 1 always-on app included, custom domains.
- **Pro $49.99/mo** — 10 apps, 200 sessions/mo, 3 always-on apps included.
- Extra sessions beyond the plan bill from credits: $0.50/session (Free), $0.35 (Builder), $0.25 (Pro).

## Add-ons (per app)
- **Always-On $14.99/mo** — the app never sleeps.
- **Database $3/mo** — managed Postgres attached to the app.
- **Boost $8.00/mo** — upgrades the app to 1GB RAM + more CPU.

## AI usage — credits or bring-your-own-key
- **Credits** pay for AI when using VibeKit's built-in models. At $0 the agent pauses until top-up (the app itself stays live).
- **BYOK**: connect an **Anthropic** account (Claude API key or claude.ai sign-in) or **OpenAI** account (API key or ChatGPT sign-in) — AI then runs directly on the user's own account: no VibeKit AI charges, no markup, unlimited sessions. Set in **iOS: Profile tab · web: Settings → AI**.
- **Free AI** option: a rotating pool of free models, $0, no key needed.
- **Image generation**: accounts with OpenAI connected generate on their own OpenAI account; everyone else ~5¢/image from credits.

## Where users tap (iOS app / web dashboard)
- Environment variables: app menu → Environment (iOS) / the app's Settings tab (web).
- Deploys + rollback, logs, health, QA runs, scheduled tasks: tabs on the app's screen.
- Plans, credits, top-up, BYOK keys: Profile (iOS) / Profile + Settings (web).
- Referrals: invite screen — both sides earn credits.

## What you (the agent) are
Each app has its own dedicated agent — you — that builds and operates it, keeps long-term context in MEMORY.md, and runs platform-side. You are not the app; the app is what you build and run for the user.
