'use strict';
// Zero-dependency iCalendar (.ics) builder. Produces a METHOD:REQUEST invite that
// Gmail / Outlook / Apple Calendar render as a real event with an RSVP box.
// Times are emitted in UTC (Z) — universally correct, no VTIMEZONE needed.

const crypto = require('node:crypto');

function icsDate(d) {
  // 2026-07-04T02:00:00.000Z -> 20260704T020000Z
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// RFC 5545 text escaping
function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold lines to 75 octets (spec); simple byte-safe fold on char boundary is fine here.
function fold(line) {
  const out = [];
  while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); }
  out.push(line);
  return out.join('\r\n');
}

// { title, description, start, end, organizerName, organizerEmail, attendees: [{name,email}], uid }
function buildInvite(ev) {
  const uid = ev.uid || crypto.randomBytes(12).toString('hex') + '@laxorq-reception';
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Laxorq//Reception//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(ev.end)}`,
    fold(`SUMMARY:${icsEscape(ev.title)}`),
    ev.description ? fold(`DESCRIPTION:${icsEscape(ev.description)}`) : '',
    ev.organizerEmail ? fold(`ORGANIZER;CN=${icsEscape(ev.organizerName || ev.organizerEmail)}:mailto:${ev.organizerEmail}`) : '',
    ...(ev.attendees || []).filter(a => a.email).map(a =>
      fold(`ATTENDEE;CN=${icsEscape(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`)),
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    fold(`DESCRIPTION:${icsEscape('Reminder: ' + ev.title)}`),
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return { uid, ics: L.join('\r\n') + '\r\n' };
}

module.exports = { buildInvite };
