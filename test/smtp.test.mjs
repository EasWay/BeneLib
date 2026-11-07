// The SMTP client against a fake mail server on this machine: plain (local only), STARTTLS with a verified
// certificate, implicit TLS, sign-in, refusals, and the message it actually sends.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sendMail, buildMessage, SmtpError } from '../src/smtp.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-test-'));
// A throwaway certificate for "localhost", trusted only by passing it as `ca`.
let cert = null;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  cert = { key: fs.readFileSync(path.join(root, 'key.pem')), cert: fs.readFileSync(path.join(root, 'cert.pem')) };
} catch { console.log('smtp: openssl unavailable, TLS cases skipped'); }

// A fake mail server. opts: starttls, implicitTls, auth ('PLAIN', 'LOGIN' or ''), user/pass, rejectRcpt, dataReply.
function fakeServer(opts = {}) {
  const log = { messages: [], commands: [], authed: false, secureAtAuth: null };
  const handle = socket => {
    let buf = '', inData = false, data = '', secure = !!opts.implicitTls, loginStep = 0, loginUser = '';
    const say = s => socket.write(s + '\r\n');
    const onData = chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; log.messages.push(data); say(opts.dataReply || '250 2.0.0 Ok: queued as ABC123'); data = ''; }
          else data += line.replace(/^\.\./, '.') + '\r\n';
          continue;
        }
        log.commands.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN ***' : line);
        if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) { loginStep = 0; const ok = loginUser === opts.user && Buffer.from(line, 'base64').toString() === opts.pass; log.authed = ok; log.secureAtAuth = secure; say(ok ? '235 ok' : '535 5.7.8 bad credentials'); continue; }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') {
          const caps = ['fake.example', ...(opts.starttls && !secure ? ['STARTTLS'] : []), ...(opts.auth ? [`AUTH ${opts.auth}`] : []), '8BITMIME'];
          caps.forEach((c, n) => say(`250${n === caps.length - 1 ? ' ' : '-'}${c}`));
        } else if (cmd === 'STARTTLS') {
          say('220 go ahead');
          socket.removeListener('data', onData);
          const secured = new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
          secured.setEncoding('utf8'); secured.on('data', onData); secured.on('error', () => {});
          secure = true; socket = secured;
        } else if (cmd === 'AUTH' && line.startsWith('AUTH PLAIN ')) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          log.authed = u === opts.user && p === opts.pass; log.secureAtAuth = secure; say(log.authed ? '235 ok' : '535 5.7.8 bad credentials');
        } else if (cmd === 'AUTH' && line === 'AUTH LOGIN') { loginStep = 1; say('334 VXNlcm5hbWU6'); }
        else if (cmd === 'MAIL') say('250 ok');
        else if (cmd === 'RCPT') say(opts.rejectRcpt ? '550 5.1.1 no such user' : '250 ok');
        else if (cmd === 'DATA') { inData = true; say('354 end with .'); }
        else if (cmd === 'QUIT') { say('221 bye'); socket.end(); }
        else say('500 unknown');
      }
    };
    socket.setEncoding('utf8'); socket.on('data', onData); socket.on('error', () => {});
    say('220 fake.example ESMTP');
  };
  const server = opts.implicitTls ? tls.createServer({ key: cert.key, cert: cert.cert }, handle) : net.createServer(handle);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, log, close: () => server.close() })));
}

const from = { email: 'books@example.test', name: 'Quiet Chapters' };
const mail = extra => ({ host: '127.0.0.1', from, to: { email: 'ama@example.test', name: 'Ama Mensah' }, subject: 'Found it: “Arrow of God” is on Quiet Chapters',
  text: 'Plain body\n.leading dot line', html: '<p>Hello</p>', messageId: 'abc@example.test', headers: { 'X-Pagehouse-Message': 'abc' }, timeoutMs: 5000, ...extra });
const decodeParts = raw => [...raw.matchAll(/Content-Type: text\/(plain|html); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)]
  .map(m => [m[1], Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString()]);

try {
  // Plain SMTP is refused for a remote host before anything is sent; allowed on this machine.
  await assert.rejects(sendMail(mail({ host: 'smtp.example.test', secure: 'none' })), /only allowed for a mail server on this machine/);

  // Local plain server with PLAIN sign-in: the whole conversation and the message.
  let s = await fakeServer({ auth: 'PLAIN LOGIN', user: 'u', pass: 'p' });
  const reply = await sendMail(mail({ port: s.port, secure: 'none', host: 'localhost', user: 'u', pass: 'p' }));
  assert.match(reply, /queued as ABC123/);
  assert.ok(s.log.authed);
  assert.deepEqual(s.log.commands.filter(c => /^(MAIL|RCPT|DATA)/.test(c)), ['MAIL FROM:<books@example.test>', 'RCPT TO:<ama@example.test>', 'DATA']);
  const raw = s.log.messages[0];
  assert.match(raw, /^From: "Quiet Chapters" <books@example\.test>\r\n/m);
  assert.match(raw, /^To: "Ama Mensah" <ama@example\.test>\r\n/m);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, 'non-ASCII subject is an encoded word');
  const subjectWords = raw.match(/^Subject: ((?:.*\r\n )*.*)\r\n/m)[1].split('\r\n ').map(w => w.match(/=\?UTF-8\?B\?(.*)\?=/)[1]);
  assert.equal(subjectWords.map(w => Buffer.from(w, 'base64').toString()).join(''), 'Found it: “Arrow of God” is on Quiet Chapters');
  assert.ok(subjectWords.every(w => w.length + 12 <= 75), 'encoded words stay within 75 characters');
  assert.match(raw, /^Message-ID: <abc@example\.test>\r\n/m);
  assert.match(raw, /^X-Pagehouse-Message: abc\r\n/m);
  assert.deepEqual(decodeParts(raw), [['plain', 'Plain body\n.leading dot line'], ['html', '<p>Hello</p>']]);
  s.close();

  // LOGIN sign-in, wrong password: a sign-in failure is not a permanent failure of the message.
  s = await fakeServer({ auth: 'LOGIN', user: 'u', pass: 'p' });
  await assert.rejects(sendMail(mail({ port: s.port, secure: 'none', user: 'u', pass: 'nope' })), e => e instanceof SmtpError && e.code === 535 && !e.permanent);
  await sendMail(mail({ port: s.port, secure: 'none', user: 'u', pass: 'p' }));
  assert.ok(s.log.authed, 'LOGIN works');
  s.close();

  // A refused recipient is permanent; a temporary refusal of the content is not.
  s = await fakeServer({ rejectRcpt: true });
  await assert.rejects(sendMail(mail({ port: s.port, secure: 'none' })), e => e.code === 550 && e.permanent);
  s.close();
  s = await fakeServer({ dataReply: '451 4.3.0 try later' });
  await assert.rejects(sendMail(mail({ port: s.port, secure: 'none' })), e => e.code === 451 && !e.permanent);
  s.close();

  // STARTTLS required by default: a server without it is refused before signing in.
  s = await fakeServer({ auth: 'PLAIN', user: 'u', pass: 'p' });
  await assert.rejects(sendMail(mail({ port: s.port, user: 'u', pass: 'p' })), /does not offer STARTTLS/);
  assert.equal(s.log.authed, false);
  s.close();
  // Nothing to connect to.
  await assert.rejects(sendMail(mail({ port: 1, secure: 'none' })), /Could not reach the mail server/);

  if (cert) {
    // STARTTLS: credentials only after the upgrade, certificate verified.
    s = await fakeServer({ starttls: true, auth: 'PLAIN', user: 'u', pass: 'p' });
    await sendMail(mail({ host: 'localhost', port: s.port, user: 'u', pass: 'p', ca: cert.cert }));
    assert.equal(s.log.secureAtAuth, true, 'signed in only over TLS');
    assert.equal(s.log.commands.filter(c => c.startsWith('EHLO')).length, 2, 'EHLO again after STARTTLS');
    assert.equal(s.log.messages.length, 1);
    // An untrusted certificate is refused (no ca given).
    await assert.rejects(sendMail(mail({ host: 'localhost', port: s.port, user: 'u', pass: 'p' })), /STARTTLS failed/);
    s.close();
    // Implicit TLS (port 465 style).
    s = await fakeServer({ implicitTls: true, auth: 'PLAIN', user: 'u', pass: 'p' });
    await sendMail(mail({ host: 'localhost', port: s.port, secure: 'tls', user: 'u', pass: 'p', ca: cert.cert }));
    assert.equal(s.log.secureAtAuth, true);
    s.close();
  }

  // Header values cannot break out of their line.
  const built = buildMessage({ from, to: { email: 'a@example.test', name: 'A' }, subject: 'Hi\r\nBcc: x@evil.test', text: '', html: '', messageId: 'm@x', headers: { 'X-Test': 'a\r\nBcc: y@evil.test' } });
  assert.doesNotMatch(built, /^Bcc:/m);
  console.log('smtp: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
