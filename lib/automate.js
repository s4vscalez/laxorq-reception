'use strict';
// Bridge to Laxorq Automate (the client-facing dashboard, port 4000).
// When the receptionist captures / books / escalates a lead, we POST it into
// Automate's existing public lead endpoint so clients see the update where they
// already look. Best-effort: a failure here never breaks the conversation.

async function pushLead(tenant, { name, email, phone, message, source = 'reception' }) {
  const base = (tenant.automate_url || '').replace(/\/+$/, '');
  const token = tenant.automate_token || '';
  if (!base || !token) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${base}/api/public/lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name, email, phone, message, source }),
    });
    const ok = res.ok;
    return { ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { pushLead };
