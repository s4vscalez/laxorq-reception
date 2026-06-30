'use strict';
// Minimal SMTP-over-implicit-TLS sender (port 465). Zero dependencies.
// Lifted from Laxorq Automate's proven sendEmail() so the two apps behave identically.
const tls = require('node:tls');

// cfg = { host, port, user, pass, from }
function sendEmail(cfg, { to, subject, body }) {
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) {
    return Promise.reject(new Error('SMTP not configured'));
  }
  const from = cfg.from || cfg.user;
  const port = Number(cfg.port || 465);
  return new Promise((resolve, reject) => {
    const socket = tls.connect(port, cfg.host, { servername: cfg.host });
    let buf = '';
    let step = 0;
    const fail = (err) => { try { socket.destroy(); } catch {} reject(err); };
    socket.setTimeout(20000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);

    const msg = [
      `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
      String(body || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    ].join('\r\n');

    const steps = [
      { expect: 220, send: () => `EHLO laxorq.local\r\n` },
      { expect: 250, send: () => `AUTH LOGIN\r\n` },
      { expect: 334, send: () => Buffer.from(cfg.user).toString('base64') + '\r\n' },
      { expect: 334, send: () => Buffer.from(cfg.pass).toString('base64') + '\r\n' },
      { expect: 235, send: () => `MAIL FROM:<${from.replace(/.*</, '').replace(/>.*/, '')}>\r\n` },
      { expect: 250, send: () => `RCPT TO:<${to}>\r\n` },
      { expect: 250, send: () => `DATA\r\n` },
      { expect: 354, send: () => msg + '\r\n.\r\n' },
      { expect: 250, send: () => `QUIT\r\n`, done: true },
    ];

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n');
      const last = lines.filter(Boolean).pop() || '';
      if (!/^\d{3} /.test(last)) return; // wait for final line "NNN " (space, not dash)
      const code = Number(last.slice(0, 3));
      buf = '';
      const s = steps[step];
      if (!s) return;
      if (code !== s.expect) return fail(new Error(`SMTP step ${step}: expected ${s.expect}, got "${last}"`));
      socket.write(s.send());
      if (s.done) { socket.end(); resolve(true); }
      step++;
    });
  });
}

module.exports = { sendEmail };
