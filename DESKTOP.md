# Laxorq Reception — Desktop app, updates & distribution

This is the **desktop (Electron) build** of Reception, so you and your colleague can install
it like normal software and run it for clients. The same zero-dependency Node server runs
*inside* the desktop app; the window just shows the dashboard.

## Why it won't break when you improve it (the safety layer)

Every time the app starts it:
- **Backs up the database** to `data/backups/` (keeps the last 10 timestamped copies) *before*
  opening it — so a bad change or update can never lose a client's leads.
- Runs **schema migrations** safely (new tables auto-create; add a column via `ensureColumn()`
  in `server.js` and bump `SCHEMA_VERSION` — old databases upgrade in place, no data loss).
- Has **crash guards** (`uncaughtException` / `unhandledRejection`) so one bad request can't
  take the whole app down.
- Exposes **`/api/health`** with the running version + schema version.

The database lives in a per-user folder (not in the program folder), so updating the app never
touches client data:
`%APPDATA%\Laxorq Reception\data\` (open it from the menu: Reception → Open data folder).

## Run / build (on your machine)

```
npm install            # once (downloads Electron)
npm start              # plain server only, http://localhost:4100 (no window)
npm run app            # the desktop app (window + server inside)
npm run dist           # build the Windows installer into dist\  (no publishing)
```

`npm run dist` produces `dist\Laxorq Reception Setup <version>.exe` — that installer is the file
you send your colleague. They double-click it, and it installs like any app with a desktop
shortcut.

## One-click auto-updates via GitHub (set up once)

When you improve the app and publish a new version, your colleague's installed copy updates
itself (it checks GitHub Releases on launch, downloads in the background, and offers a restart —
their data is backed up first).

### First-time setup
1. Create a **GitHub repo** named `laxorq-reception` (private is fine).
2. In `package.json`, set `build.publish.owner` to your GitHub username (replace
   `REPLACE_WITH_GITHUB_USERNAME`).
3. Create a GitHub **Personal Access Token** (classic, scope `repo`) and set it in your shell:
   - PowerShell: `$env:GH_TOKEN="ghp_xxx"`
4. Push the code (see below).

### Each time you ship an improvement
1. Bump the `version` in `package.json` (e.g. `0.1.0` → `0.1.1`).
2. `npm run publish` — this builds the installer **and** uploads it to a GitHub Release.
3. That's it. Installed copies pick it up on their next launch.

> Note: the app is **unsigned**, so the first install shows a Windows SmartScreen warning
> ("More info → Run anyway"). Auto-updates after that are silent. Code signing (a paid cert)
> removes the warning later if you want it.

## Push the code to GitHub (no `gh` CLI on this machine, so plain git)

```
git init
git add .
git commit -m "Laxorq Reception"
git branch -M main
git remote add origin https://github.com/<your-username>/laxorq-reception.git
git push -u origin main
```

Git will prompt for your GitHub login on first push (use the PAT as the password).

`data/`, `node_modules/`, `dist/` and `.env` are git-ignored, so no client data or secrets are
ever committed.

## Where the desktop app keeps its data

The installed/desktop app stores its database **per-user**, separate from the dev `data/` folder:

```
%APPDATA%\laxorq-reception\data\reception.db        (clients, conversations, settings/API key)
%APPDATA%\laxorq-reception\data\backups\            (auto-backups, last 10)
```

Open it any time from the app menu: **Reception → Open data folder**.

- **Preseeded for the demo:** this build's data folder has been loaded with **Crystal Math SG**
  (and the Anthropic key), so the desktop app opens straight into it.
- **Start a client fresh / reset:** close the app and delete `reception.db` in that folder
  (a backup is kept in `backups\`). Next launch reseeds a clean sample.
- **Move a setup between machines:** copy `reception.db` into the same folder on the other
  machine. (Each colleague normally runs their own copy with their own clients.)

## WhatsApp vs web chat — why it asks (or doesn't) for a number

- **WhatsApp / email:** the customer is messaging *from* their number/address, so the system
  already has it. The AI **never asks** for contact details and captures them automatically.
- **Web chat (the test chat):** a website visitor has no number attached, so the AI gently asks
  for a name + WhatsApp/email so the lead can be followed up if the chat drops. This is why the
  simulator asks — it is the one channel where we genuinely don't know who they are.

## Connecting a client's WhatsApp (the real onboarding)

There is no way to "just type a number and connect" — WhatsApp (Meta) does not allow plugging
into someone's existing personal/Business-app number from outside. The supported path is the
**WhatsApp Cloud API**, set up once per client:

1. The client's number is registered to a **Meta WhatsApp Business Account** and enabled for the
   Cloud API. (Tip: many businesses dedicate a number to this, because a number moved to the API
   can no longer be used in the normal WhatsApp app.)
2. In the client's **Channels** tab, paste the **Phone number ID**, **access token**, and a
   **verify token** you choose.
3. Point the Meta webhook at `https://<your-host>/wh/whatsapp` (needs the app reachable on a
   public HTTPS URL — your cloudflared tunnel or a host like Render).

After that one-time setup it is exactly the experience you described: every message to the
client's WhatsApp is answered automatically, and only the ones that truly need a human get handed
off to the client.
