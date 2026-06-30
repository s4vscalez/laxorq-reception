'use strict';
// The AI brain — single source of truth for the receptionist's prompt + tools.
// Runs the Anthropic Messages API conversation loop with tool-use. The DB-side
// effects of each tool are supplied by the engine as `executors`, so this file
// owns the *thinking* and the engine owns the *doing*.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function tcfg(tenant) {
  try { return JSON.parse(tenant.config_json || '{}'); } catch { return {}; }
}

// Build the per-tenant system prompt from that client's receptionist profile.
// ctx = { channel, contactName, contactPhone, contactEmail } describes THIS conversation.
function buildSystem(tenant, ctx = {}) {
  const c = tcfg(tenant);
  const L = [];
  L.push(`You are the front desk receptionist for "${tenant.name}", a ${tenant.niche || 'local business'} based in Singapore.`);
  L.push(`A potential customer has just messaged in. The owner is busy, so you are the first point of contact. Your job: answer helpfully, make the customer feel looked after, capture their contact details, and guide them toward booking or speaking with the team. You are the reason a busy owner does not lose this lead.`);
  L.push('');
  L.push('## This conversation');
  if (ctx.channel === 'whatsapp') {
    L.push(`You are chatting on WhatsApp. You ALREADY have the customer's WhatsApp number${ctx.contactName ? ` and their name (${ctx.contactName})` : ''}, because they messaged you from it. NEVER ask for their phone number or how to reach them. When you learn their name and what they want, call capture_lead (their number is already on file). Chat naturally, like a real WhatsApp conversation.`);
  } else if (ctx.channel === 'email') {
    L.push(`You are replying over email, so you already have the customer's email address. Do not ask for it. Only ask for a name or phone if it genuinely helps.`);
  } else if (ctx.channel === 'voice') {
    L.push(`This is a phone call turned into text. Keep replies short and natural to say out loud. You likely already have their number from caller ID, so do not ask for it.`);
  } else {
    L.push(`This is a chat on the website, so you do NOT have any contact details yet. At a natural point, gently ask for the customer's name and a WhatsApp number or email so the team can follow up if the chat drops, then call capture_lead.`);
  }
  L.push('');
  L.push('## How you speak');
  L.push('Warm, human, and professional, like a thoughtful person texting back, not a corporate bot. Keep replies short, usually one to three sentences. Ask one question at a time. Start every sentence with a capital letter. Do not use dashes. Write in plain text only, never use markdown, asterisks, or bold, because these channels show them as literal characters. Avoid emoji unless the customer uses them first. Never sound scripted or pushy.');
  if (c.tone) L.push(`Tone guidance from the business: ${c.tone}`);
  L.push('');
  L.push('## What you know about the business');
  if (c.about) L.push(c.about);
  if (c.services) L.push(`Services: ${c.services}`);
  if (c.hours) L.push(`Opening hours: ${c.hours}`);
  if (c.location) L.push(`Location: ${c.location}`);
  if (c.pricing) L.push(`Pricing guidance: ${c.pricing}`);
  if (c.booking) L.push(`How booking / next steps work: ${c.booking}`);
  if (c.faq) L.push(`Frequently asked questions and answers:\n${c.faq}`);
  L.push('');
  L.push('## Remember the conversation (very important)');
  L.push('Read the ENTIRE conversation above before every reply. The customer can see it too, and nothing annoys them more than being asked something they already answered. NEVER ask again for anything they have already given or that you already have: their name, their child name, the level, what they want, or any contact detail. If you already know it, use it and move the conversation forward. If you are unsure whether you already have something, assume you do and do not ask.');
  L.push('Ask for a contact detail (phone or email) at MOST ONCE in the whole conversation, and only when you do not already have it. If they give it, never ask again. If they do not give it or change the subject, let it go completely and keep helping, the team can still follow up. Do not nag.');
  L.push('Each reply must move things forward (answer their question, share a useful detail, or take a next step). Never send a reply whose only purpose is to re-request something.');
  L.push('');
  L.push('## Hard rules');
  L.push('Never invent prices, availability, guarantees, or any fact not given above. If you do not know something, say you will check with the team, and capture the customer details so they get a real answer. Do not over promise outcomes.');
  L.push('As soon as you have the customer name (and a contact, only if not already on file), call capture_lead once so the team can follow up even if the chat drops. Never interrogate.');
  L.push('When the customer wants to book, start, sign up, or come down, call request_booking with their preferred timing.');
  L.push('Call escalate_to_human when the customer is ready to pay or commit, is upset or unhappy, asks for the owner, or asks something you genuinely cannot answer. Then tell the customer a team member will follow up very shortly.');
  L.push('If the customer is clearly not interested, acknowledge it warmly and call mark_not_interested. Do not chase.');
  L.push('If the customer says they need time or will decide later, call schedule_followup so we gently check back.');
  L.push('Always write a natural reply to the customer as well as calling any tool. The reply is what the customer actually sees.');
  return L.join('\n');
}

const TOOLS = [
  {
    name: 'capture_lead',
    description: 'Save the customer contact details so the business can follow up. Call this as soon as you have learned their name and a phone number or email.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'customer name' },
        phone: { type: 'string', description: 'phone number if given' },
        email: { type: 'string', description: 'email if given' },
        intent: { type: 'string', description: 'what the customer wants, in one short line' },
        urgency: { type: 'string', enum: ['hot', 'warm', 'cold'], description: 'how ready to buy they seem' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'request_booking',
    description: 'The customer wants to book, start, sign up, or come in. Records their preferred timing for the team to confirm.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'what they want to book' },
        preferred_time: { type: 'string', description: 'their preferred day/time in their own words' },
        notes: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Flag this conversation for a human team member to take over now (ready to commit, upset, asked for the owner, or a question you cannot answer).',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'why a human is needed' } },
      required: ['reason'],
    },
  },
  {
    name: 'mark_not_interested',
    description: 'The customer is not interested. Close the conversation gracefully.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'schedule_followup',
    description: 'Schedule a gentle future check-in to re-confirm interest if the customer goes quiet or says they will decide later.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'how many hours from now to check back' },
        reason: { type: 'string', description: 'one line on what to follow up about' },
      },
      required: ['hours'],
    },
  },
];

async function callAnthropic({ apiKey, model, system, messages, max_tokens = 700 }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens, system, tools: TOOLS, messages }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

// history: array of { role: 'user'|'assistant', content: string }
// executors: { capture_lead, request_booking, escalate_to_human, mark_not_interested, schedule_followup }
//            each (input) => Promise<string|void>  (string is fed back to the model)
// Returns { reply, actions: [{ tool, input }] }
async function runBrain({ tenant, history, executors = {}, apiKey, model = 'claude-sonnet-4-6', ctx = {} }) {
  if (!apiKey) throw new Error('No Anthropic API key set');
  const system = buildSystem(tenant, ctx);
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  const actions = [];
  let reply = '';

  for (let hop = 0; hop < 6; hop++) {
    const data = await callAnthropic({ apiKey, model, system, messages });
    const content = data.content || [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (text) reply = text;
    const toolUses = content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) break;

    messages.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) {
      let out = 'ok';
      try {
        const fn = executors[tu.name];
        out = fn ? ((await fn(tu.input)) ?? 'ok') : `no handler for ${tu.name}`;
      } catch (e) {
        out = 'error: ' + e.message;
      }
      actions.push({ tool: tu.name, input: tu.input });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
    }
    messages.push({ role: 'user', content: results });
    if (data.stop_reason !== 'tool_use' && data.stop_reason !== 'pause_turn') break;
  }

  if (!reply) reply = 'Thanks for your message. Let me get the team to follow up with you shortly.';
  return { reply, actions };
}

// One-shot composer for an outbound follow-up message (no tools, no customer turn).
async function composeFollowup({ tenant, history, reason, apiKey, model = 'claude-sonnet-4-6', ctx = {} }) {
  if (!apiKey) throw new Error('No Anthropic API key set');
  const system = buildSystem(tenant, ctx) +
    `\n\n## Follow-up task\nThe customer has gone quiet. Write ONE short, warm follow-up message that gently re-checks whether they are still interested. Bring a tiny bit of new value or a clear easy next step. Do not say "just following up". Reason for this follow-up: ${reason || 'no reply yet'}. Output only the message text.`;
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: '[The team is sending a follow-up now. Write the follow-up message.]' });
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 300, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

module.exports = { runBrain, composeFollowup, buildSystem, tcfg, TOOLS };
