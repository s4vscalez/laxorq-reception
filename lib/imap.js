'use strict';
// Minimal IMAP-over-TLS poller. Zero dependencies.
// Built for the common case: a client's Gmail inbox (imap.gmail.com:993 with an
// app password), but works with any IMAP server that accepts LOGIN.
// Flow per poll: LOGIN -> SELECT INBOX -> UID SEARCH UNSEEN -> fetch headers+text
// (with PEEK so nothing changes if we crash mid-way) -> hand back parsed messages;
// the caller marks each UID \Seen only after it has processed it.

const tls = require('node:tls');

const quote = (s) => '"' + String(s).replace(/([\\"])/g, '\\$1') + '"';

class ImapClient {
  constructor({ host, port = 993, user, pass, timeoutMs = 25000 }) {
    this.host = host; this.port = port; this.user = user; this.pass = pass;
    this.timeoutMs = timeoutMs;
    this.buf = Buffer.alloc(0);
    this.tagN = 0;
    this.pending = null; // { tag, lines, litRemaining, resolve, reject }
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(this.port, this.host, { servername: this.host });
      this.socket.setTimeout(this.timeoutMs, () => this._fail(new Error('IMAP timeout')));
      this.socket.on('error', (e) => this._fail(e));
      this.socket.on('data', (chunk) => this._onData(chunk));
      // greeting is an untagged "* OK" line before any command
      this.greetResolve = resolve;
      this.greetReject = reject;
    });
  }

  _fail(err) {
    try { this.socket.destroy(); } catch {}
    if (this.greetReject) { this.greetReject(err); this.greetReject = this.greetResolve = null; }
    if (this.pending) { this.pending.reject(err); this.pending = null; }
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const p = this.pending;
      if (p && p.litRemaining > 0) {
        const take = Math.min(p.litRemaining, this.buf.length);
        if (!take) return;
        p.lines.push(this.buf.subarray(0, take).toString('utf8'));
        this.buf = this.buf.subarray(take);
        p.litRemaining -= take;
        if (p.litRemaining > 0) return;
        continue;
      }
      const nl = this.buf.indexOf('\r\n');
      if (nl === -1) return;
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 2);

      if (this.greetResolve) { // server greeting
        if (/^\* (OK|PREAUTH)/i.test(line)) { this.greetResolve(); this.greetResolve = this.greetReject = null; }
        else if (/^\* BYE/i.test(line)) this._fail(new Error('IMAP rejected connection: ' + line));
        continue;
      }
      if (!p) continue; // unsolicited data between commands — ignore

      p.lines.push(line + '\r\n');
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) { p.litRemaining = Number(lit[1]); continue; }
      if (line.startsWith(p.tag + ' ')) {
        this.pending = null;
        if (/^\S+ OK/i.test(line)) p.resolve(p.lines.join(''));
        else p.reject(new Error('IMAP: ' + line));
      }
    }
  }

  cmd(command) {
    return new Promise((resolve, reject) => {
      const tag = 'A' + (++this.tagN);
      this.pending = { tag, lines: [], litRemaining: 0, resolve, reject };
      this.socket.write(tag + ' ' + command + '\r\n');
    });
  }

  async login() { await this.cmd(`LOGIN ${quote(this.user)} ${quote(this.pass)}`); }
  async select() { await this.cmd('SELECT INBOX'); }

  async searchUnseen() {
    const res = await this.cmd('UID SEARCH UNSEEN');
    const m = /\* SEARCH([\d ]*)/i.exec(res);
    return m ? m[1].trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  // Returns the literal content of one BODY.PEEK[section] fetch ('' when absent).
  async fetchSection(uid, section) {
    const res = await this.cmd(`UID FETCH ${uid} BODY.PEEK[${section}]`);
    const i = res.search(/\{\d+\}\r\n/);
    if (i === -1) return '';
    const n = Number(/\{(\d+)\}/.exec(res.slice(i))[1]);
    const start = res.indexOf('\r\n', i) + 2;
    return res.slice(start, start + n);
  }

  async markSeen(uid) { await this.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); }
  async logout() { try { await this.cmd('LOGOUT'); } catch {} try { this.socket.end(); } catch {} }
}

// ---------------------------------------------------------------- decoding
// RFC 2047 encoded words in From/Subject: =?utf-8?B?...?= / =?utf-8?Q?...?=
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');
    } catch { return data; }
  });
}

function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseHeaders(raw) {
  const h = {};
  for (const line of raw.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

// Reduce a raw BODY[TEXT] to readable plain text, handling the common cases:
// single-part text (qp/base64), multipart with a text/plain part, html-only.
function extractText(rawBody, contentType = '', cte = '') {
  let text = rawBody;
  const ct = contentType.toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (ct.startsWith('multipart') && boundary) {
    const parts = rawBody.split('--' + boundary).slice(1, -1);
    let best = null;
    for (const part of parts) {
      const split = part.indexOf('\r\n\r\n');
      if (split === -1) continue;
      const ph = parseHeaders(part.slice(0, split).replace(/^\r\n/, ''));
      const pct = (ph['content-type'] || 'text/plain').toLowerCase();
      const body = part.slice(split + 4);
      if (pct.startsWith('text/plain')) { best = { body, cte: ph['content-transfer-encoding'] || '' }; break; }
      if (!best && pct.startsWith('text/html')) best = { body, cte: ph['content-transfer-encoding'] || '', html: true };
    }
    if (!best) return '';
    text = decodeCte(best.body, best.cte);
    if (best.html) text = stripHtml(text);
    return text.trim();
  }
  text = decodeCte(text, cte);
  if (ct.startsWith('text/html')) text = stripHtml(text);
  return text.trim();
}

function decodeCte(s, cte) {
  const e = (cte || '').toLowerCase();
  if (e.includes('base64')) { try { return Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return s; } }
  if (e.includes('quoted-printable')) return decodeQP(s);
  return s;
}

function stripHtml(s) {
  return s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------- high level
// Poll one inbox. Returns [{ uid, from, name, subject, text }] of UNSEEN mail,
// marking each seen only after it made it into the list. Caps at `limit`.
async function pollInbox({ host = 'imap.gmail.com', user, pass, limit = 5 }) {
  const c = new ImapClient({ host, user, pass: String(pass || '').replace(/\s+/g, '') });
  await c.connect();
  try {
    await c.login();
    await c.select();
    const uids = (await c.searchUnseen()).slice(-limit);
    const out = [];
    for (const uid of uids) {
      const rawH = await c.fetchSection(uid, 'HEADER.FIELDS (FROM SUBJECT CONTENT-TYPE CONTENT-TRANSFER-ENCODING)');
      const h = parseHeaders(rawH);
      const rawB = await c.fetchSection(uid, 'TEXT');
      const fromRaw = decodeWords(h.from || '');
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(fromRaw);
      const text = extractText(rawB, h['content-type'] || '', h['content-transfer-encoding'] || '').slice(0, 4000);
      out.push({
        uid,
        from: (m ? m[2] : fromRaw).trim().toLowerCase(),
        name: m ? m[1].trim() : '',
        subject: decodeWords(h.subject || '').trim(),
        text,
      });
      await c.markSeen(uid);
    }
    return out;
  } finally {
    await c.logout();
  }
}

module.exports = { pollInbox, extractText, decodeWords, parseHeaders };
