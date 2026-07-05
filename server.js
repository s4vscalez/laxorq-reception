'use strict';
// Laxorq Reception — multi-tenant AI receptionist engine.
// Zero npm dependencies: node:http + node:sqlite + global fetch (+ node:tls via lib/smtp).
//
// Inbound (web chat / WhatsApp / email / voice) -> normalize -> load conversation
// -> run the AI brain (with tools) -> execute tool effects -> reply on same channel
// -> log everything -> push leads/bookings/escalations into Laxorq Automate.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const brain = require('./lib/brain');
const automate = require('./lib/automate');
const icsLib = require('./lib/ics');
const { sendEmail } = require('./lib/smtp');
const waCh = require('./lib/channels/whatsapp');
const emailCh = require('./lib/channels/email');
const voiceCh = require('./lib/channels/voice');

const VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
const SCHEMA_VERSION = 1; // bump when you add a migration below

// Resilience: a bug in one request or a stray rejection must never take the whole app down.
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

// Load .env (simple parser, no dependency) if present.
(() => {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env, fine */ }
})();

const PORT = process.env.PORT || 4100;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// Data dir is overridable so the desktop build can store the DB in a writable
// per-user location (Electron sets RECEPTION_DATA_DIR to app userData).
const DATA_DIR = process.env.RECEPTION_DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(DATA_DIR, 'reception.db');

// ---------------------------------------------------------------- DATABASE
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Auto-backup the database before we open it, so improving/migrating the app can
// never lose a client's leads. Keeps the last 10 timestamped copies.
function backupDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_PATH, path.join(dir, `reception-${stamp}.db`));
    const keep = 10;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch (e) { console.error('backupDb:', e.message); }
}
backupDb();

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    niche TEXT DEFAULT '',
    config_json TEXT DEFAULT '{}',     -- about, services, hours, location, pricing, booking, faq, tone, greeting
    channels_json TEXT DEFAULT '{}',   -- whatsapp / email / voice per-tenant creds
    automate_url TEXT DEFAULT '',
    automate_token TEXT DEFAULT '',
    owner_email TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    channel TEXT NOT NULL,             -- webchat | whatsapp | email | voice
    contact TEXT DEFAULT '',           -- phone / email / session id
    contact_name TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    status TEXT DEFAULT 'active',       -- active | escalated | booked | not_interested | closed
    urgency TEXT DEFAULT '',           -- hot | warm | cold
    ai_paused INTEGER DEFAULT 0,       -- 1 = a human took over
    lead_pushed INTEGER DEFAULT 0,
    last_inbound_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,                -- user | assistant | human | system
    text TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    conversation_id INTEGER,
    type TEXT NOT NULL,                -- lead | booking | escalation | followup | message | system
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    due_at TEXT NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'scheduled',   -- scheduled | sent | cancelled
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    conversation_id INTEGER,
    title TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    customer_email TEXT DEFAULT '',
    start_at TEXT,                     -- ISO UTC; NULL = time not pinned yet
    end_at TEXT,
    preferred_text TEXT DEFAULT '',    -- customer's own words when no concrete time
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',     -- pending (team to confirm) | confirmed | cancelled
    invite_sent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---- Safe schema evolution ----------------------------------------------------
// New TABLES are handled by CREATE TABLE IF NOT EXISTS above. For new COLUMNS on
// existing tables, add an ensureColumn() call inside the matching migration step
// and bump SCHEMA_VERSION. Backups already ran, so this is non-destructive.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
const MIGRATIONS = {
  // Example for the future — uncomment + bump SCHEMA_VERSION to 2:
  // 2: () => ensureColumn('tenants', 'plan', "TEXT DEFAULT 'free'"),
};
function runMigrations() {
  let current = db.prepare('PRAGMA user_version').get().user_version || 0;
  if (current === 0 && db.prepare("SELECT COUNT(*) AS c FROM tenants").get().c >= 0) {
    // existing or fresh DB on first versioned run → baseline at SCHEMA_VERSION
    current = SCHEMA_VERSION;
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    if (MIGRATIONS[v]) { console.log('Running migration', v); MIGRATIONS[v](); }
    db.exec(`PRAGMA user_version = ${v}`);
  }
}
runMigrations();

const now = () => new Date().toISOString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
}
function apiKey() { return getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY || ''; }
function chatModel() { return getSetting('chat_model') || process.env.CHAT_MODEL || 'claude-sonnet-4-6'; }
function smtpCfg() {
  const cfg = {
    host: getSetting('smtp_host'), port: Number(getSetting('smtp_port', '465')),
    user: getSetting('smtp_user'), pass: getSetting('smtp_pass'),
    from: getSetting('smtp_from') || getSetting('smtp_user'),
  };
  return cfg.host && cfg.user && cfg.pass ? cfg : null;
}

function addEvent(tenantId, convoId, type, text) {
  db.prepare('INSERT INTO events (tenant_id, conversation_id, type, text, created_at) VALUES (?,?,?,?,?)')
    .run(tenantId, convoId, type, text, now());
}
function tenantById(id) { return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id); }
function convoById(id) { return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id); }

// ---------------------------------------------------------------- SEED
const SAMPLE_CONFIG = {
  about: 'Bright Minds is a friendly neighbourhood tuition centre helping primary and secondary students build confidence in Math and Science.',
  services: 'Primary Math and Science (P3 to P6), Secondary Math (Sec 1 to 4), small group classes of up to 6 students, plus one to one slots.',
  hours: 'Tuesday to Friday 3pm to 9pm, Saturday 9am to 5pm. Closed Sunday and Monday.',
  location: 'Tampines Central, two minutes from Tampines MRT.',
  pricing: 'Primary group classes are around 280 to 320 SGD a month. One to one is higher. Always offer a free trial class before quoting exact fees, and let the team confirm the final price.',
  booking: 'The next step is a free trial class. Collect the student level and a parent contact, then the team confirms a trial slot.',
  faq: 'Q: Do you offer a trial? A: Yes, the first trial class is free.\nQ: How big are classes? A: Up to 6 students.\nQ: Do you cover the latest syllabus? A: Yes, all materials follow the current MOE syllabus.',
  tone: 'Reassuring and parent friendly. Many parents are anxious about their child falling behind.',
  greeting: 'Hi, thanks for reaching out to Bright Minds. How can I help with your child\'s learning today?',
};
if (!db.prepare('SELECT COUNT(*) AS c FROM tenants').get().c) {
  db.prepare('INSERT INTO tenants (name, niche, config_json, channels_json, automate_url, automate_token, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('Bright Minds Tuition', 'tuition centre', JSON.stringify(SAMPLE_CONFIG), '{}', '', '', now());
  addEvent(1, null, 'system', 'Sample receptionist "Bright Minds Tuition" created. Edit it or add your own client.');
}

// ---------------------------------------------------------------- ENGINE
const HOUR = 3600 * 1000;

function history(convoId, limit = 40) {
  const rows = db.prepare('SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(convoId, limit).reverse();
  // map our roles to Anthropic roles: user stays user; assistant + human -> assistant; drop system
  return rows
    .filter(r => r.role !== 'system' && r.text)
    .map(r => ({ role: r.role === 'user' ? 'user' : 'assistant', content: r.text }));
}

function findOrCreateConversation(tenantId, channel, contact, name) {
  let c = db.prepare("SELECT * FROM conversations WHERE tenant_id=? AND channel=? AND contact=? AND status NOT IN ('closed') ORDER BY id DESC LIMIT 1")
    .get(tenantId, channel, contact);
  if (c) return c;
  const r = db.prepare('INSERT INTO conversations (tenant_id, channel, contact, contact_name, status, created_at, updated_at, last_inbound_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(tenantId, channel, contact, name || '', 'active', now(), now(), now());
  const id = Number(r.lastInsertRowid);
  addEvent(tenantId, id, 'system', `New ${channel} conversation started${name ? ' with ' + esc(name) : ''}`);
  return convoById(id);
}

// Build the tool executors for a given conversation (the DB-side effects).
function executorsFor(tenant, convo) {
  return {
    capture_lead: async (input) => {
      const set = {};
      if (input.name) set.contact_name = input.name;
      if (input.phone) set.contact_phone = input.phone;
      if (input.email) set.contact_email = input.email;
      if (input.urgency) set.urgency = input.urgency;
      const keys = Object.keys(set);
      if (keys.length) {
        db.prepare(`UPDATE conversations SET ${keys.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`)
          .run(...keys.map(k => set[k]), now(), convo.id);
      }
      const fresh = convoById(convo.id);
      addEvent(tenant.id, convo.id, 'lead', `<strong>Lead captured:</strong> ${esc(fresh.contact_name || 'Customer')} — ${esc(input.intent || '')}${input.urgency ? ' (' + input.urgency + ')' : ''}`);
      // push into Automate once
      if (!fresh.lead_pushed) {
        const res = await automate.pushLead(tenant, {
          name: fresh.contact_name, email: fresh.contact_email, phone: fresh.contact_phone,
          message: `[AI Receptionist · ${convo.channel}] ${input.intent || 'New enquiry'}`,
          source: 'reception-' + convo.channel,
        });
        db.prepare('UPDATE conversations SET lead_pushed=1 WHERE id=?').run(convo.id);
        if (res.ok) addEvent(tenant.id, convo.id, 'system', 'Pushed to Automate dashboard');
      }
      return 'Saved the contact details. Keep helping the customer naturally.';
    },
    request_booking: async (input) => {
      db.prepare("UPDATE conversations SET status='booked', updated_at=? WHERE id=?").run(now(), convo.id);
      const fresh = convoById(convo.id);

      // Concrete time? -> real calendar entry + invites. Vague? -> pending, team confirms.
      let startAt = null, endAt = null;
      if (input.start_iso) {
        const d = new Date(input.start_iso);
        if (!isNaN(d) && d.getTime() > Date.now() - 60000) {
          startAt = d.toISOString();
          endAt = new Date(d.getTime() + (Number(input.duration_minutes) || 60) * 60000).toISOString();
        }
      }
      const title = `${input.service || 'Appointment'} — ${fresh.contact_name || 'Customer'} (${tenant.name})`;
      const r = db.prepare(
        'INSERT INTO bookings (tenant_id, conversation_id, title, customer_name, customer_phone, customer_email, start_at, end_at, preferred_text, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(tenant.id, convo.id, title, fresh.contact_name || '', fresh.contact_phone || '', fresh.contact_email || '',
        startAt, endAt, input.preferred_time || '', input.notes || '', startAt ? 'confirmed' : 'pending', now());
      const bookingId = Number(r.lastInsertRowid);

      const when = startAt
        ? new Date(startAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
        : (input.preferred_time || 'time to confirm');
      addEvent(tenant.id, convo.id, 'booking', `<strong>Booking ${startAt ? 'confirmed' : 'requested'}:</strong> ${esc(input.service || 'service')} — ${esc(when)}`);

      // Calendar invites (needs a concrete time + SMTP). Sent to the business owner and,
      // if we have their email, the customer too.
      let inviteNote = '';
      if (startAt && smtpCfg()) {
        const { ics } = icsLib.buildInvite({
          title,
          description: `Booked via the AI receptionist.\n${input.notes || ''}\nCustomer: ${fresh.contact_name || ''} ${fresh.contact_phone || ''}`.trim(),
          start: startAt, end: endAt,
          organizerName: tenant.name, organizerEmail: getSetting('smtp_from') || getSetting('smtp_user'),
          attendees: [
            { name: tenant.name, email: tenant.owner_email },
            { name: fresh.contact_name, email: fresh.contact_email },
          ],
        });
        const bodyTxt = `${title}\nWhen: ${when} (Singapore time)\n\nThis calendar invite was created automatically by your AI receptionist.`;
        const targets = [tenant.owner_email, fresh.contact_email].filter(Boolean);
        for (const to of targets) {
          try {
            await sendEmail(smtpCfg(), { to, subject: `Invite: ${title}`, body: bodyTxt, ics });
            db.prepare('UPDATE bookings SET invite_sent=1 WHERE id=?').run(bookingId);
            addEvent(tenant.id, convo.id, 'booking', `<strong>Calendar invite sent</strong> to ${esc(to)}`);
          } catch (e) { console.error('invite send:', e.message); }
        }
        const sent = db.prepare('SELECT invite_sent FROM bookings WHERE id=?').get(bookingId).invite_sent;
        inviteNote = sent ? ' A calendar invite has been emailed.' : '';
      } else if (startAt && !smtpCfg()) {
        addEvent(tenant.id, convo.id, 'system', 'Booking has a confirmed time but no SMTP is set — calendar invite not emailed (Settings).');
      }

      await automate.pushLead(tenant, {
        name: fresh.contact_name, email: fresh.contact_email, phone: fresh.contact_phone,
        message: `[BOOKING via AI Receptionist] ${input.service || ''} ${when} ${input.notes || ''}`.trim(),
        source: 'reception-booking',
      });
      await handoffToClient(tenant, convo, { kind: 'booking', reason: `Wants to book ${input.service || ''} — ${when}`.trim() });

      return startAt
        ? `Booking confirmed for ${when} Singapore time and recorded on the calendar.${inviteNote} Let the customer know it is locked in.`
        : 'Booking request recorded without a fixed time. Tell the customer the team will confirm the exact slot shortly.';
    },
    escalate_to_human: async (input) => {
      db.prepare("UPDATE conversations SET status='escalated', updated_at=? WHERE id=?").run(now(), convo.id);
      addEvent(tenant.id, convo.id, 'escalation', `<strong>Escalated to human:</strong> ${esc(input.reason || '')}`);
      await handoffToClient(tenant, convo, { kind: 'escalation', reason: input.reason || '' });
      return 'Flagged for a human team member. Reassure the customer that someone will follow up very shortly.';
    },
    mark_not_interested: async (input) => {
      db.prepare("UPDATE conversations SET status='not_interested', updated_at=? WHERE id=?").run(now(), convo.id);
      addEvent(tenant.id, convo.id, 'system', `Marked not interested${input.reason ? ': ' + esc(input.reason) : ''}`);
      // gentle re-approach in 6 weeks
      db.prepare('INSERT INTO followups (conversation_id, due_at, reason, created_at) VALUES (?,?,?,?)')
        .run(convo.id, new Date(Date.now() + 42 * 24 * HOUR).toISOString(), 're-approach after a cooling off period', now());
      return 'Acknowledged warmly. A gentle re-approach has been scheduled.';
    },
    schedule_followup: async (input) => {
      const hours = Math.max(0.1, Number(input.hours) || 24);
      db.prepare('INSERT INTO followups (conversation_id, due_at, reason, created_at) VALUES (?,?,?,?)')
        .run(convo.id, new Date(Date.now() + hours * HOUR).toISOString(), input.reason || '', now());
      addEvent(tenant.id, convo.id, 'followup', `Follow-up scheduled in ${hours}h${input.reason ? ': ' + esc(input.reason) : ''}`);
      return `A follow-up has been scheduled in ${hours} hours.`;
    },
  };
}

// Singapore-friendly phone -> wa.me deep link (so the client taps and replies from their own WhatsApp).
function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 8 && /^[89]/.test(d)) d = '65' + d;
  if (!d) return '';
  return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
}
function transcriptText(convoId, n = 10) {
  const rows = db.prepare('SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(convoId, n).reverse();
  return rows.map(m => `${m.role === 'user' ? 'Customer' : m.role === 'human' ? 'You' : 'AI'}: ${m.text}`).join('\n');
}

// Escalation handoff to the CLIENT (Model A): email them the lead + the chat so far + a one-tap
// WhatsApp link to the customer, so they reply from their own phone. No client logins needed.
async function handoffToClient(tenant, convo, { kind, reason }) {
  const fresh = convoById(convo.id);
  const customer = fresh.contact_name || 'A customer';
  const phone = fresh.contact_phone || (fresh.channel === 'whatsapp' ? fresh.contact : '');
  const opener = `Hi ${fresh.contact_name || 'there'}, this is ${tenant.name}. Thanks for reaching out, I would love to help.`;
  const wa = waLink(phone, opener);
  const subject = kind === 'booking'
    ? `Booking request: ${customer} — ${tenant.name}`
    : `A lead needs you: ${customer} — ${tenant.name}`;
  const body = [
    `Your AI receptionist has ${kind === 'booking' ? 'a booking request' : 'a lead that needs a human'}.`,
    '',
    `Customer: ${customer}`,
    phone ? `Phone: ${phone}` : '',
    fresh.contact_email ? `Email: ${fresh.contact_email}` : '',
    `Channel: ${fresh.channel}`,
    reason ? `Why: ${reason}` : '',
    '',
    'Recent conversation:',
    transcriptText(convo.id, 10),
    '',
    wa ? `Reply now on WhatsApp (opens with a suggested message):\n${wa}` : '(No phone captured yet, reply via the channel they used.)',
  ].filter(x => x !== '').join('\n');

  addEvent(tenant.id, convo.id, kind === 'booking' ? 'booking' : 'escalation',
    `<strong>Handoff sent to ${esc(tenant.owner_email || 'the client')}</strong>${wa ? ' with a one-tap WhatsApp reply' : ''}`);

  const cfg = smtpCfg();
  if (cfg && tenant.owner_email) {
    try { await emailCh.send(cfg, tenant.owner_email, subject, body); }
    catch (e) { console.error('handoff email:', e.message); addEvent(tenant.id, convo.id, 'system', 'Handoff email failed: ' + esc(e.message)); }
  } else {
    addEvent(tenant.id, convo.id, 'system', 'Handoff ready, but set a notification email + SMTP (Channels / Settings) so the client actually gets pinged');
  }
}

// The core: process one inbound message. Returns the reply text (or null if AI paused).
async function handleInbound({ tenant, channel, contact, name, text }) {
  const convo = findOrCreateConversation(tenant.id, channel, contact, name);
  db.prepare('INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?,?,?,?)').run(convo.id, 'user', text, now());
  db.prepare('UPDATE conversations SET last_inbound_at=?, updated_at=?, status=CASE WHEN status=\'closed\' THEN \'active\' ELSE status END WHERE id=?').run(now(), now(), convo.id);

  // The channel itself carries the contact handle: WhatsApp gives us their number,
  // email gives us their address. Capture it automatically so the AI never has to ask.
  if (channel === 'whatsapp' && !convo.contact_phone) db.prepare('UPDATE conversations SET contact_phone=? WHERE id=?').run(contact, convo.id);
  if (channel === 'email' && !convo.contact_email) db.prepare('UPDATE conversations SET contact_email=? WHERE id=?').run(contact, convo.id);
  if (name && !convo.contact_name) db.prepare('UPDATE conversations SET contact_name=? WHERE id=?').run(name, convo.id);
  const cur = convoById(convo.id);

  // If a human took over, do not auto-reply. Just surface it.
  if (cur.ai_paused) {
    addEvent(tenant.id, convo.id, 'message', `New message from ${esc(cur.contact_name || 'customer')} (AI paused, awaiting you)`);
    return null;
  }

  const key = apiKey();
  if (!key) {
    const fallback = 'Thanks for your message. The team will get back to you shortly.';
    db.prepare('INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?,?,?,?)').run(convo.id, 'assistant', fallback, now());
    addEvent(tenant.id, convo.id, 'system', 'No Anthropic key set — sent a holding reply. Add a key in Settings.');
    return fallback;
  }

  const { reply, actions } = await brain.runBrain({
    tenant, history: history(convo.id), executors: executorsFor(tenant, convo), apiKey: key, model: chatModel(),
    ctx: { channel, contactName: cur.contact_name, contactPhone: cur.contact_phone, contactEmail: cur.contact_email },
  });
  db.prepare('INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?,?,?,?)').run(convo.id, 'assistant', reply, now());
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), convo.id);
  return reply;
}

// Deliver an outbound message on the conversation's channel (for follow-ups / human takeover).
async function deliver(convo, tenant, text) {
  const ch = JSON.parse(tenant.channels_json || '{}');
  try {
    if (convo.channel === 'whatsapp' && ch.whatsapp) { await waCh.send(ch.whatsapp, convo.contact, text); return true; }
    if (convo.channel === 'email') {
      const cfg = smtpCfg();
      if (cfg && convo.contact_email) { await emailCh.send(cfg, convo.contact_email || convo.contact, 'Re: your enquiry', text); return true; }
    }
  } catch (e) { console.error('deliver failed:', e.message); }
  return false; // webchat / voice have no async push channel — message is logged for the dashboard
}

// ---------------------------------------------------------------- SCHEDULER
async function tick() {
  const due = db.prepare("SELECT * FROM followups WHERE status='scheduled' AND due_at <= ?").all(now());
  for (const f of due) {
    const convo = convoById(f.conversation_id);
    if (!convo || ['booked', 'closed'].includes(convo.status)) {
      db.prepare("UPDATE followups SET status='cancelled' WHERE id=?").run(f.id);
      continue;
    }
    const tenant = tenantById(convo.tenant_id);
    let text = 'Hi, just checking in to see if you would still like to go ahead. Happy to help whenever you are ready.';
    try {
      if (apiKey()) text = await brain.composeFollowup({ tenant, history: history(convo.id), reason: f.reason, apiKey: apiKey(), model: chatModel(), ctx: { channel: convo.channel, contactName: convo.contact_name, contactPhone: convo.contact_phone, contactEmail: convo.contact_email } });
    } catch (e) { console.error('compose followup:', e.message); }
    db.prepare('INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?,?,?,?)').run(convo.id, 'assistant', text, now());
    const delivered = await deliver(convo, tenant, text);
    db.prepare("UPDATE followups SET status='sent' WHERE id=?").run(f.id);
    addEvent(tenant.id, convo.id, 'followup', `<strong>Follow-up ${delivered ? 'sent' : 'drafted'}:</strong> ${esc(text.slice(0, 80))}${delivered ? '' : ' (no push channel — visible here)'}`);
  }
}
setInterval(() => tick().catch(e => console.error('tick:', e.message)), 30000);

// ---------------------------------------------------------------- HTTP
function send(res, code, data, headers = {}) {
  const isStr = typeof data === 'string';
  res.writeHead(code, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isStr ? data : JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function authed(req, url) {
  if (!ADMIN_KEY) return true;
  return req.headers['x-admin-key'] === ADMIN_KEY || url.searchParams.get('key') === ADMIN_KEY;
}
function tenantPublic(t) {
  return { ...t, config: JSON.parse(t.config_json || '{}'), channels: redactChannels(t.channels_json) };
}
function redactChannels(json) {
  const ch = JSON.parse(json || '{}');
  for (const k of Object.keys(ch)) for (const f of ['token', 'secret', 'inbound_secret']) if (ch[k] && ch[k][f]) ch[k][f] = '••••••';
  return ch;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---- static UI
    if (req.method === 'GET' && (p === '/' || p === '/index.html'))
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'app.html'), 'utf8'));
    if (req.method === 'GET' && p === '/chat')
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'chat.html'), 'utf8'));

    // ---- web chat / simulator (CORS open: widget may be embedded on client sites)
    if (p === '/api/chat') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'POST') {
        const b = await readBody(req);
        const tenant = tenantById(Number(b.tenant_id));
        if (!tenant) return send(res, 404, { error: 'unknown tenant' });
        const session = String(b.session || crypto.randomBytes(6).toString('hex'));
        const reply = await handleInbound({ tenant, channel: 'webchat', contact: session, name: b.name || '', text: String(b.text || '').slice(0, 4000) });
        const convo = db.prepare("SELECT * FROM conversations WHERE tenant_id=? AND channel='webchat' AND contact=? ORDER BY id DESC LIMIT 1").get(tenant.id, session);
        return send(res, 200, { reply, session, conversation_id: convo?.id, status: convo?.status });
      }
    }

    // ---- health / version (public, used by the desktop app + update checks)
    if (p === '/api/health' && req.method === 'GET') {
      return send(res, 200, {
        ok: true, version: VERSION, schema_version: db.prepare('PRAGMA user_version').get().user_version,
        ai_ready: !!apiKey(), tenants: db.prepare('SELECT COUNT(*) AS c FROM tenants').get().c,
      });
    }

    // ---- WhatsApp webhook (Phase 1)
    if (p === '/wh/whatsapp') {
      if (req.method === 'GET') {
        // verify against any tenant that has whatsapp configured
        for (const t of db.prepare('SELECT * FROM tenants').all()) {
          const cfg = JSON.parse(t.channels_json || '{}').whatsapp;
          const ch = waCh.verify(url.searchParams, cfg);
          if (ch) return send(res, 200, ch);
        }
        return send(res, 403, 'verification failed');
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        for (const msg of waCh.parse(b)) {
          const t = db.prepare('SELECT * FROM tenants').all().find(t => JSON.parse(t.channels_json || '{}').whatsapp?.phone_number_id === msg.phone_number_id);
          if (!t) continue;
          const reply = await handleInbound({ tenant: t, channel: 'whatsapp', contact: msg.from, name: msg.name, text: msg.text });
          if (reply) await deliver({ channel: 'whatsapp', contact: msg.from }, t, reply);
        }
        return send(res, 200, { ok: true });
      }
    }

    // ---- Email inbound webhook (Phase 2)
    if (p === '/wh/email' && req.method === 'POST') {
      const b = await readBody(req);
      const m = emailCh.parse(b);
      const t = db.prepare('SELECT * FROM tenants').all().find(t => (JSON.parse(t.channels_json || '{}').email?.address || '').toLowerCase() === m.to);
      if (!t) return send(res, 404, { error: 'no tenant for ' + m.to });
      const reply = await handleInbound({ tenant: t, channel: 'email', contact: m.from, name: m.name, text: `${m.subject ? m.subject + '\n\n' : ''}${m.text}` });
      const convo = db.prepare("SELECT * FROM conversations WHERE tenant_id=? AND channel='email' AND contact=? ORDER BY id DESC LIMIT 1").get(t.id, m.from);
      if (convo && !convo.contact_email) db.prepare('UPDATE conversations SET contact_email=? WHERE id=?').run(m.from, convo.id);
      if (reply && smtpCfg()) await emailCh.send(smtpCfg(), m.from, 'Re: ' + (m.subject || 'your enquiry'), reply);
      return send(res, 200, { ok: true });
    }

    // ---- Voice provider webhook (Phase 3)
    if (p === '/wh/voice' && req.method === 'POST') {
      const b = await readBody(req);
      const v = voiceCh.parse(b);
      const t = db.prepare('SELECT * FROM tenants').all().find(t => JSON.parse(t.channels_json || '{}').voice?.phone_number) || tenantById(1);
      if (!t || !v.text) return send(res, 200, voiceCh.speak('One moment please.'));
      const reply = await handleInbound({ tenant: t, channel: 'voice', contact: v.from || v.call_id, name: '', text: v.text });
      return send(res, 200, voiceCh.speak(reply || 'Let me get a colleague to call you back.'));
    }

    // ---- admin API
    if (p.startsWith('/api/')) {
      if (!authed(req, url)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && p === '/api/tenants')
        return send(res, 200, db.prepare('SELECT * FROM tenants ORDER BY id').all().map(tenantPublic));

      if (req.method === 'POST' && p === '/api/tenants') {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        const r = db.prepare('INSERT INTO tenants (name, niche, config_json, channels_json, automate_url, automate_token, owner_email, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(b.name, b.niche || '', JSON.stringify(b.config || {}), '{}', b.automate_url || '', b.automate_token || '', b.owner_email || '', now());
        const id = Number(r.lastInsertRowid);
        addEvent(id, null, 'system', `Receptionist created for ${esc(b.name)}`);
        return send(res, 200, tenantPublic(tenantById(id)));
      }

      if (p.match(/^\/api\/tenants\/\d+$/)) {
        const id = Number(p.split('/').pop());
        const t = tenantById(id);
        if (!t) return send(res, 404, { error: 'no such tenant' });
        if (req.method === 'GET') return send(res, 200, tenantPublic(t));
        if (req.method === 'PATCH') {
          const b = await readBody(req);
          const config = b.config ? JSON.stringify(b.config) : t.config_json;
          // merge channels, preserving redacted secrets the UI did not resend
          let channels = JSON.parse(t.channels_json || '{}');
          if (b.channels) {
            for (const k of Object.keys(b.channels)) {
              channels[k] = { ...(channels[k] || {}), ...b.channels[k] };
              for (const f of ['token', 'secret', 'inbound_secret']) if (channels[k][f] === '••••••') channels[k][f] = (JSON.parse(t.channels_json || '{}')[k] || {})[f] || '';
            }
          }
          db.prepare('UPDATE tenants SET name=?, niche=?, config_json=?, channels_json=?, automate_url=?, automate_token=?, owner_email=?, active=? WHERE id=?')
            .run(b.name ?? t.name, b.niche ?? t.niche, config, JSON.stringify(channels), b.automate_url ?? t.automate_url, b.automate_token ?? t.automate_token, b.owner_email ?? t.owner_email, b.active ?? t.active, id);
          return send(res, 200, tenantPublic(tenantById(id)));
        }
      }

      if (req.method === 'GET' && p === '/api/overview') {
        const tid = Number(url.searchParams.get('tenant_id'));
        const convos = db.prepare('SELECT * FROM conversations WHERE tenant_id=?').all(tid);
        const events = db.prepare('SELECT * FROM events WHERE tenant_id=? ORDER BY id DESC LIMIT 25').all(tid);
        const dayAgo = new Date(Date.now() - 24 * HOUR).toISOString();
        return send(res, 200, {
          stats: {
            conversations: convos.length,
            today: convos.filter(c => c.created_at >= dayAgo).length,
            leads: convos.filter(c => c.lead_pushed).length,
            booked: convos.filter(c => c.status === 'booked').length,
            escalated: convos.filter(c => c.status === 'escalated').length,
          },
          events,
          ai_ready: !!apiKey(),
        });
      }

      if (req.method === 'GET' && p === '/api/bookings') {
        const tid = Number(url.searchParams.get('tenant_id'));
        const rows = db.prepare(
          "SELECT * FROM bookings WHERE tenant_id=? AND status!='cancelled' AND (start_at IS NULL OR start_at >= ?) ORDER BY start_at IS NULL, start_at ASC LIMIT 200"
        ).all(tid, new Date(Date.now() - 2 * 3600 * 1000).toISOString());
        return send(res, 200, rows);
      }

      if (req.method === 'PATCH' && p.match(/^\/api\/bookings\/\d+$/)) {
        const id = Number(p.split('/').pop());
        const b = await readBody(req);
        const bk = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
        if (!bk) return send(res, 404, { error: 'no such booking' });
        if (b.status && ['pending', 'confirmed', 'cancelled'].includes(b.status))
          db.prepare('UPDATE bookings SET status=? WHERE id=?').run(b.status, id);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && p === '/api/conversations') {
        const tid = Number(url.searchParams.get('tenant_id'));
        const rows = db.prepare('SELECT * FROM conversations WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 200').all(tid);
        return send(res, 200, rows);
      }

      if (req.method === 'GET' && p.match(/^\/api\/conversations\/\d+$/)) {
        const id = Number(p.split('/').pop());
        const convo = convoById(id);
        if (!convo) return send(res, 404, { error: 'no such conversation' });
        const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(id);
        return send(res, 200, { conversation: convo, messages: msgs });
      }

      if (req.method === 'POST' && p.match(/^\/api\/conversations\/\d+\/takeover$/)) {
        const id = Number(p.split('/')[3]);
        const b = await readBody(req);
        const convo = convoById(id);
        if (!convo) return send(res, 404, { error: 'no such conversation' });
        db.prepare('UPDATE conversations SET ai_paused=? WHERE id=?').run(b.paused ? 1 : 0, id);
        addEvent(convo.tenant_id, id, 'system', b.paused ? 'Human took over (AI paused)' : 'AI resumed');
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p.match(/^\/api\/conversations\/\d+\/send$/)) {
        const id = Number(p.split('/')[3]);
        const b = await readBody(req);
        const convo = convoById(id);
        if (!convo) return send(res, 404, { error: 'no such conversation' });
        const tenant = tenantById(convo.tenant_id);
        const text = String(b.text || '').slice(0, 4000);
        db.prepare('INSERT INTO messages (conversation_id, role, text, created_at) VALUES (?,?,?,?)').run(id, 'human', text, now());
        const delivered = await deliver(convo, tenant, text);
        addEvent(tenant.id, id, 'message', `<strong>You replied</strong>${delivered ? '' : ' (logged — webchat has no push)'}`);
        return send(res, 200, { ok: true, delivered });
      }

      if (req.method === 'GET' && p === '/api/settings') {
        return send(res, 200, {
          anthropic_api_key: getSetting('anthropic_api_key') ? '••••••••' : '',
          chat_model: chatModel(),
          smtp_host: getSetting('smtp_host'), smtp_port: getSetting('smtp_port', '465'),
          smtp_user: getSetting('smtp_user'), smtp_pass: getSetting('smtp_pass') ? '••••••••' : '',
          smtp_from: getSetting('smtp_from'),
        });
      }
      if (req.method === 'POST' && p === '/api/settings') {
        const b = await readBody(req);
        for (const k of ['chat_model', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_from']) if (b[k] !== undefined) setSetting(k, b[k]);
        for (const k of ['anthropic_api_key', 'smtp_pass']) {
          if (b[k] === '') setSetting(k, '');
          else if (b[k] && !b[k].startsWith('•')) setSetting(k, b[k]);
        }
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'not found' });
    }

    return send(res, 404, '<h1>Not found</h1>');
  } catch (e) {
    console.error(req.method, p, e);
    return send(res, 500, { error: e.message });
  }
});

// Start the server. Exported so the desktop (Electron) build can boot it in-process
// and know when it is ready; still auto-starts when run directly via `node server.js`.
function start() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`Laxorq Reception v${VERSION} running -> http://localhost:${PORT}`);
      console.log(`Test chat (simulator)   -> http://localhost:${PORT}/chat`);
      tick().catch(() => {});
      resolve({ port: PORT, version: VERSION });
    });
  });
}

if (require.main === module) start().catch(e => { console.error('Failed to start:', e.message); process.exit(1); });

module.exports = { start, PORT, VERSION };
