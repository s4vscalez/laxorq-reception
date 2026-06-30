'use strict';
// Email adapter.
// PHASE 2: inbound arrives via an inbound-parse webhook (Cloudflare Email Workers,
// Mailgun Routes, SendGrid Inbound Parse, etc.) POSTing JSON to /wh/email.
// Outbound reuses the shared SMTP sender (lib/smtp.js), called by the engine.
//
// Tenant channel config (channels_json.email): { address, inbound_secret }
// Global SMTP creds live in Settings (shared sender), same as Laxorq Automate.

const { sendEmail } = require('../smtp');

// Normalize a generic inbound-parse payload. Different providers use different
// field names, so we accept the common ones.
// Returns { to, from, name, subject, text }
function parse(body) {
  const from = body.from || body.sender || body.From || '';
  const to = body.to || body.recipient || body.To || '';
  const subject = body.subject || body.Subject || '';
  const text = body.text || body['stripped-text'] || body['body-plain'] || body.plain || body.html || '';
  // pull "Name <email>" → name + bare address
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const name = m ? m[1].trim() : '';
  const addr = m ? m[2].trim() : from.trim();
  return { to: String(to).toLowerCase(), from: addr, name, subject, text: String(text).trim() };
}

// send via shared SMTP. smtpCfg = { host, port, user, pass, from }
async function send(smtpCfg, to, subject, text) {
  return sendEmail(smtpCfg, { to, subject: subject || 'Re: your enquiry', body: text });
}

module.exports = { parse, send };
