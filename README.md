# Laxorq Reception — AI Receptionist

One AI receptionist, many clients. It reads inbound enquiries when the owner is busy,
holds a real conversation, captures and books leads, escalates the hot ones to a human, and
follows up to re-confirm interest. Works across **Web chat (live now)**, **WhatsApp Business**,
**Email**, and **Voice** — one brain across chat *and* phone. Captured leads are pushed into
the existing **Laxorq Automate** dashboard so clients see updates where they already look.

Zero npm dependencies — `node:http` + `node:sqlite` + global `fetch` (+ `node:tls` for SMTP).

## Run it

```
start-reception.bat
```
or
```
"C:\Program Files\nodejs\node.exe" server.js
```

- Admin dashboard: http://localhost:4100
- Customer test chat (simulator): http://localhost:4100/chat

First run seeds a sample receptionist ("Bright Minds Tuition") so you can try it immediately.

## First-time setup (5 minutes, gets the brain live)

1. Open the dashboard → **Settings** → paste your **Anthropic API key** → Save.
2. **Receptionist** tab → fill in the business info (about, services, hours, pricing rules,
   FAQ, booking step, tone). This *is* the brain — the AI only knows what you put here, and it
   never invents prices or facts.
3. **Channels** tab → (optional but recommended) set the **Automate base URL + client form
   token** so captured leads flow into the Automate dashboard.
4. Open **/chat**, pick the client, and talk to it like a customer.

## How it works

```
inbound (web / WhatsApp / email / voice)
   → normalize  (lib/channels/*)
   → load conversation + history  (SQLite)
   → AI brain with tools  (lib/brain.js)
        capture_lead · request_booking · escalate_to_human
        · mark_not_interested · schedule_followup
   → execute tool effects + reply on same channel
   → log everything + push lead → Automate  (lib/automate.js)
```

- **Take over**: in any conversation, hit *Take over* to pause the AI and reply yourself; *Resume AI* hands it back.
- **Follow-ups**: scheduled by the AI; the scheduler composes a fresh, on-brand re-check and
  delivers it on channels that support push (WhatsApp/email). Web-chat follow-ups are drafted
  and shown in the dashboard (a browser session can't be pushed to).

## Channel rollout (what needs *your* accounts)

| Channel | Status | What you provide |
|---|---|---|
| Web chat | **Live now** | nothing |
| Automate link | Live now | Automate URL + client form token |
| WhatsApp Business | Phase 1 | Meta Cloud API: phone number ID, token, your verify token. Webhook → `/wh/whatsapp` (needs a public HTTPS host) |
| Email | Phase 2 | A receptionist address + an inbound-parse webhook → `/wh/email`; SMTP in Settings for sending |
| Voice | Phase 3 | A Vapi/Retell/Twilio number; provider posts each turn → `/wh/voice` |

## Deploying (for WhatsApp/email/voice webhooks)

Webhooks need a public HTTPS URL. This is a **stateful** server (SQLite + live conversations),
so a long-running host fits better than serverless:
- Quick test: `cloudflared tunnel --url http://localhost:4100`
- Production: Render / Railway / Fly / a small VPS.

Set `ADMIN_KEY` in `.env` before exposing it — it locks the admin API + dashboard.

## Files

- `server.js` — engine: DB schema, conversation handling, webhooks, admin API, scheduler.
- `lib/brain.js` — the AI: per-tenant system prompt + tool-use loop.
- `lib/channels/{whatsapp,email,voice}.js` — channel adapters.
- `lib/automate.js` — pushes leads into Laxorq Automate.
- `lib/smtp.js` — SMTP sender (shared with Automate).
- `public/app.html` — admin dashboard. `public/chat.html` — customer test chat.
