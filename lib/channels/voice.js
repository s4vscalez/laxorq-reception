'use strict';
// Voice receptionist adapter.
// PHASE 3: a turnkey voice provider (Vapi / Retell / Twilio ConversationRelay)
// handles speech-to-text and text-to-speech, and calls our webhook (/wh/voice)
// once per caller turn with the transcribed text. We run the same brain and return
// text for the provider to speak. This keeps one brain across chat AND phone.
//
// Tenant channel config (channels_json.voice): { provider, phone_number, secret }

// Normalize a per-turn webhook from the voice provider.
// Returns { call_id, from, text, ended }
function parse(body) {
  // Vapi-style and generic shapes both supported.
  const msg = body.message || body;
  const text =
    msg.transcript || msg.text || msg.user_text || msg.speech ||
    (Array.isArray(msg.messages) ? (msg.messages.at(-1)?.content || '') : '') || '';
  return {
    call_id: body.call_id || msg.call?.id || body.callSid || '',
    from: body.from || msg.customer?.number || body.caller || '',
    text: String(text).trim(),
    ended: !!(body.ended || msg.type === 'end-of-call-report'),
  };
}

// "Sending" a voice reply = returning the text the provider will speak.
// The webhook handler returns this in the HTTP response body.
function speak(text) {
  return { reply: text };
}

module.exports = { parse, speak };
