'use strict';
// WhatsApp Business — Meta Cloud API adapter.
// PHASE 1: goes live once the tenant has { phone_number_id, token, verify_token }
// set in its channel config and a public HTTPS webhook is pointed at /wh/whatsapp.
//
// Config shape (per tenant, channels_json.whatsapp):
//   { phone_number_id, token, verify_token }
const GRAPH = 'https://graph.facebook.com/v21.0';

// GET webhook verification handshake (Meta calls this once when you save the webhook).
function verify(query, cfg) {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');
  if (mode === 'subscribe' && cfg && token === cfg.verify_token) return challenge;
  return null;
}

// Parse an inbound Cloud API webhook payload into normalized messages.
// Returns [{ phone_number_id, from, name, text }]
function parse(body) {
  const out = [];
  try {
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        const pnid = v.metadata?.phone_number_id;
        const contacts = v.contacts || [];
        for (const m of v.messages || []) {
          if (m.type !== 'text') continue; // (media handling can be added later)
          const name = contacts.find(c => c.wa_id === m.from)?.profile?.name || '';
          out.push({ phone_number_id: pnid, from: m.from, name, text: m.text?.body || '' });
        }
      }
    }
  } catch { /* ignore malformed */ }
  return out;
}

// Send a free-form text reply (only valid inside the 24h customer-service window).
async function send(cfg, to, text) {
  if (!cfg || !cfg.phone_number_id || !cfg.token) throw new Error('WhatsApp not configured');
  const res = await fetch(`${GRAPH}/${cfg.phone_number_id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  if (!res.ok) throw new Error(`WhatsApp send ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

module.exports = { verify, parse, send };
