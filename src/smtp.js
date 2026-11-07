// A small SMTP client on Node's own net/tls, so sending mail adds no dependency. One message per connection:
// greeting → EHLO → STARTTLS (or implicit TLS) → EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT.
// Credentials are never sent over an unencrypted connection, except to a mail server on this machine (a local
// relay or a test catcher such as Mailpit), and certificates are always verified.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export class SmtpError extends Error {
  constructor(message, { code = 0, permanent = false } = {}) { super(message); this.code = code; this.permanent = permanent; }
}

export const isLocalHost = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host || '').toLowerCase());

// Reads SMTP replies ("250-first", "250-more", "250 last") off a socket, one complete reply per read().
class Replies {
  constructor(socket) { this.waiters = []; this.ready = []; this.attach(socket); }
  attach(socket) {
    this.socket = socket; this.buf = ''; this.lines = [];
    socket.setEncoding('utf8');
    socket.on('data', d => { this.buf += d; this.parse(); });
    socket.on('error', e => this.fail(e));
    socket.on('close', () => this.fail(new SmtpError('The mail server closed the connection')));
  }
  // A socket we stopped reading can still report an error while it closes; it must not crash the server.
  detach() { for (const ev of ['data', 'error', 'close']) this.socket.removeAllListeners(ev); this.socket.on('error', () => {}); }
  parse() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines.map(l => l.slice(4)) };
        this.lines = [];
        const w = this.waiters.shift(); w ? w.resolve(reply) : this.ready.push(reply);
      } else if (!/^\d{3}-/.test(line)) { this.fail(new SmtpError('The mail server sent an unreadable reply')); return; }
      if (this.buf.length > 64e3) { this.fail(new SmtpError('The mail server reply is too long')); return; }
    }
  }
  fail(e) { this.error = this.error || e; for (const w of this.waiters.splice(0)) w.reject(this.error); }
  read() {
    if (this.ready.length) return Promise.resolve(this.ready.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

// RFC 2047 encoded words for non-ASCII header text, split so no encoded word passes 75 characters.
function encodeWords(text) {
  const s = String(text);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = []; let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}
const address = ({ email, name }) => !name ? `<${email}>`
  : /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}" <${email}>` : `${encodeWords(name)} <${email}>`;
const base64Lines = s => Buffer.from(String(s), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

export function buildMessage({ from, to, subject, text, html, messageId, headers = {}, date = new Date() }) {
  const boundary = 'ph-' + crypto.randomBytes(12).toString('hex');
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`);
  return [
    `From: ${address(from)}`, `To: ${address(to)}`, `Subject: ${encodeWords(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0', 'Auto-Submitted: auto-generated', ...extra,
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

function open({ host, port, secure, timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    const socket = secure === 'tls'
      ? tls.connect({ host, port, ca, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError(`The mail server at ${host}:${port} did not answer in time`)));
    socket.once(secure === 'tls' ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', e => reject(new SmtpError(`Could not reach the mail server at ${host}:${port}: ${e.message}`)));
  });
}

function upgrade(socket, host, timeoutMs, ca) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, ca, servername: net.isIP(host) ? undefined : host });
    secured.setTimeout(timeoutMs, () => secured.destroy(new SmtpError('The mail server did not finish STARTTLS in time')));
    secured.once('secureConnect', () => resolve(secured));
    secured.once('error', e => reject(new SmtpError(`STARTTLS failed: ${e.message}`)));
  });
}

// Send one message. `secure` is 'starttls' (default), 'tls' (implicit TLS, usually port 465) or 'none'.
// Resolves with the server's reply to the message (it usually names the queue id). Rejects with an SmtpError
// whose `permanent` flag says retrying this same message cannot help (the server refused the recipient or content).
// `ca` adds trusted certificates (a private mail server's CA); the system's trusted roots are always used otherwise.
export async function sendMail({ host, port, secure = 'starttls', user = '', pass = '', from, to, subject, text, html, messageId, headers, timeoutMs = 20000, ca }) {
  if (!host) throw new SmtpError('SMTP_HOST is not set');
  if (!['starttls', 'tls', 'none'].includes(secure)) throw new SmtpError('SMTP_SECURE must be starttls, tls or none');
  if (secure === 'none' && !isLocalHost(host)) throw new SmtpError('SMTP_SECURE=none is only allowed for a mail server on this machine');
  port = Number(port) || (secure === 'tls' ? 465 : 587);
  const helo = (os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  let socket = await open({ host, port, secure, timeoutMs, ca });
  const replies = new Replies(socket);
  // Reply codes this step accepts; 5xx while naming the recipient or sending the content is final for this message.
  const step = async (line, ok, label, finalOn5xx = false) => {
    if (line != null) socket.write(line + '\r\n');
    const r = await replies.read();
    if (!ok.includes(r.code)) {
      if (r.code === 530) throw new SmtpError('The mail server requires sign-in: set SMTP_USER and SMTP_PASS', { code: 530 });
      throw new SmtpError(`${label} refused: ${r.code} ${r.lines.join(' ').slice(0, 200)}`.trim(), { code: r.code, permanent: finalOn5xx && r.code >= 500 });
    }
    return r;
  };
  try {
    await step(null, [220], 'Greeting');
    let caps = (await step(`EHLO ${helo}`, [250], 'EHLO')).lines.slice(1).map(l => l.toUpperCase());
    if (secure === 'starttls') {
      if (!caps.some(c => c === 'STARTTLS')) throw new SmtpError('The mail server does not offer STARTTLS; set SMTP_SECURE=tls if it uses port 465');
      await step('STARTTLS', [220], 'STARTTLS');
      replies.detach();
      socket = await upgrade(socket, host, timeoutMs, ca);
      replies.attach(socket);
      caps = (await step(`EHLO ${helo}`, [250], 'EHLO')).lines.slice(1).map(l => l.toUpperCase());
    }
    if (user) {
      const auth = caps.find(c => c.startsWith('AUTH')) || '';
      if (/\bPLAIN\b/.test(auth)) {
        await step('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`).toString('base64'), [235], 'Sign-in (check SMTP_USER and SMTP_PASS)');
      } else if (/\bLOGIN\b/.test(auth)) {
        await step('AUTH LOGIN', [334], 'Sign-in');
        await step(Buffer.from(user).toString('base64'), [334], 'Sign-in');
        await step(Buffer.from(pass).toString('base64'), [235], 'Sign-in (check SMTP_USER and SMTP_PASS)');
      } else throw new SmtpError('The mail server offers no supported sign-in method (PLAIN or LOGIN)');
    }
    await step(`MAIL FROM:<${from.email}>`, [250], 'Sender (check PAGEHOUSE_EMAIL_FROM is allowed on this server)');
    await step(`RCPT TO:<${to.email}>`, [250, 251], 'Recipient', true);
    await step('DATA', [354], 'DATA', true);
    const body = buildMessage({ from, to, subject, text, html, messageId, headers }).replace(/\r\n$/, '').replace(/^\./gm, '..');
    const done = await step(body + '\r\n.', [250], 'Message', true);
    socket.write('QUIT\r\n');
    return done.lines.join(' ').slice(0, 200);
  } finally {
    replies.detach();
    socket.end(); socket.destroy();
  }
}
