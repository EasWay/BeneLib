// Pagehouse transactional email through an outbox (see the architecture doc, "Email").
// Every email is first written to `email_outbox`, in the same transaction as whatever caused it, so a mail
// server outage or missing settings never lose one: it waits and is sent once the server answers. A dedupe key
// per message makes enqueueing idempotent (a webhook replay or a second sweep does not send a second email).
// Sending is plain SMTP (src/smtp.js), capped per UTC day, with exponential backoff between attempts.
//
// Environment:
//   SMTP_HOST, SMTP_PORT          the mail server (port defaults to 587, or 465 with SMTP_SECURE=tls)
//   SMTP_SECURE                   starttls (default), tls (implicit TLS, port 465) or none (local servers only)
//   SMTP_USER, SMTP_PASS          sign-in; leave empty for a server that needs none
//   PAGEHOUSE_EMAIL_FROM          sender, "Name <address>" or "address"; the server must allow sending as it
//   PAGEHOUSE_OWNER_EMAIL         where owner alerts go (new book requests); unset = no owner alerts
//   PAGEHOUSE_PUBLIC_URL          the storefront's public address, for links in emails
//   PAGEHOUSE_EMAIL_DAILY_LIMIT   sends per UTC day (default 300); set it to your provider's limit
import crypto from 'node:crypto';
import { db } from './pagehouse.js';
import { sendMail, isLocalHost } from './smtp.js';

const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
const KEEP_SENT_DAYS = 30;
const emailOk = s => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s) && s.length <= 254;
const oneLine = (v, n) => String(v ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const iso = ms => new Date(ms).toISOString();

db.exec(`
  CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    to_email TEXT NOT NULL,
    to_name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS email_outbox_sent ON email_outbox(status, sent_at);
`);

export function emailConfig() {
  // Without PAGEHOUSE_EMAIL_FROM, send as the account we sign in with (what Gmail and most providers require).
  const user = String(process.env.SMTP_USER || '').trim();
  const from = parseAddress(process.env.PAGEHOUSE_EMAIL_FROM || (emailOk(user.toLowerCase()) ? `Pagehouse <${user}>` : ''));
  const limit = Number(process.env.PAGEHOUSE_EMAIL_DAILY_LIMIT || 300);
  const secure = String(process.env.SMTP_SECURE || 'starttls').trim().toLowerCase();
  const host = String(process.env.SMTP_HOST || '').trim();
  let problem = '';
  if (!host) problem = 'SMTP_HOST is not set';
  else if (!from) problem = user || process.env.PAGEHOUSE_EMAIL_FROM ? 'PAGEHOUSE_EMAIL_FROM is not a valid address' : 'Set SMTP_USER to the account to send from (for Gmail, your Gmail address)';
  else if (!['starttls', 'tls', 'none'].includes(secure)) problem = 'SMTP_SECURE must be starttls, tls or none';
  else if (secure === 'none' && !isLocalHost(host)) problem = 'SMTP_SECURE=none is only allowed for a mail server on this machine';
  else if (!!process.env.SMTP_USER !== !!process.env.SMTP_PASS) problem = 'Set SMTP_USER and SMTP_PASS together';
  return {
    smtp: { host, port: Number(process.env.SMTP_PORT) || (secure === 'tls' ? 465 : 587), secure, user, pass: smtpPassword(host) },
    problem,
    from,
    owner: emailOk(String(process.env.PAGEHOUSE_OWNER_EMAIL || '').trim().toLowerCase()) ? String(process.env.PAGEHOUSE_OWNER_EMAIL).trim().toLowerCase() : '',
    publicUrl: publicUrl(),
    dailyLimit: Number.isInteger(limit) && limit > 0 ? limit : 300,
  };
}

function parseAddress(value) {
  const v = oneLine(value, 300);
  const m = v.match(/^(.*?)\s*<([^<>]+)>$/);
  const email = (m ? m[2] : v).trim().toLowerCase(), name = (m ? m[1] : '').replace(/^"|"$/g, '').trim();
  return emailOk(email) ? { email, name: name || 'Pagehouse' } : null;
}

// The storefront's address for links. PAGEHOUSE_PUBLIC_URL, else the origin of the Paystack callback URL.
export function publicUrl() {
  for (const raw of [process.env.PAGEHOUSE_PUBLIC_URL, process.env.PAGEHOUSE_CALLBACK_URL]) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
        return raw === process.env.PAGEHOUSE_PUBLIC_URL ? u.href.replace(/\/+$/, '') : u.origin;
      }
    } catch { /* ignored: not a URL */ }
  }
  return '';
}

// Google shows App Passwords as four groups of four letters; they contain no spaces, so pasted spaces are dropped.
function smtpPassword(host) {
  const pass = process.env.SMTP_PASS || '';
  return /(^|\.)(gmail|googlemail)\.com$/i.test(host) ? pass.replace(/\s+/g, '') : pass;
}

export function isConfigured() { return !emailConfig().problem; }

// Logs never carry full addresses (the architecture doc: "Logs redact email and phone").
export const redact = email => String(email || '').replace(/^(.).*?(@.*)$/, '$1***$2');

const insert = db.prepare(`INSERT INTO email_outbox(id,dedupe_key,kind,to_email,to_name,subject,html,text,status,next_attempt_at,created_at)
  VALUES(?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(dedupe_key) DO NOTHING`);

// Queue one email. Call it inside the caller's transaction so the email exists exactly when the change does.
// Returns false when the address is unusable or the same dedupe key was already queued.
export function enqueue({ key, kind, to, toName = '', subject, html, text }, nowMs = Date.now()) {
  const email = String(to || '').trim().toLowerCase();
  if (!emailOk(email) || !key || !subject) return false;
  const stamp = iso(nowMs);
  return insert.run(crypto.randomUUID(), oneLine(key, 200), oneLine(kind, 60), email, oneLine(toName, 120),
    oneLine(subject, 200), String(html), String(text), stamp, stamp).changes === 1;
}

const sentToday = () => db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status='sent' AND sent_at>=?").get(new Date().toISOString().slice(0, 10)).n;

// The real transport: one SMTP conversation per email. Tests pass their own `transport`.
function smtpTransport(row, cfg) {
  return sendMail({
    ...cfg.smtp, from: cfg.from, to: { email: row.to_email, name: row.to_name }, subject: row.subject, text: row.text, html: row.html,
    messageId: `${row.id}@${cfg.from.email.split('@')[1]}`, headers: { 'X-Pagehouse-Message': row.id, 'X-Pagehouse-Kind': row.kind },
  });
}

let running = null;
// Send what is due, oldest first, within the daily cap. Safe to call often; overlapping calls share one run.
export function processOutbox({ transport = smtpTransport, limit = 25, nowMs = Date.now() } = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = emailConfig(), counts = { sent: 0, failed: 0, retrying: 0, waiting: 0 };
    // A crash mid-send leaves rows in 'sending'; after 10 minutes they are due again.
    db.prepare("UPDATE email_outbox SET status='pending' WHERE status='sending' AND next_attempt_at<=?").run(iso(nowMs - 10 * 60e3));
    db.prepare("DELETE FROM email_outbox WHERE status='sent' AND sent_at<=?").run(iso(nowMs - KEEP_SENT_DAYS * 864e5));
    const due = db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status='pending' AND next_attempt_at<=?").get(iso(nowMs)).n;
    if (cfg.problem) { counts.waiting = due; return counts; }
    const room = Math.max(0, cfg.dailyLimit - sentToday());
    const rows = db.prepare("SELECT * FROM email_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?").all(iso(nowMs), Math.min(limit, room));
    counts.waiting = due - rows.length;
    const claim = db.prepare("UPDATE email_outbox SET status='sending',next_attempt_at=? WHERE id=? AND status='pending'");
    for (const row of rows) {
      if (!claim.run(iso(nowMs), row.id).changes) continue;
      try {
        const providerId = String(await transport(row, cfg) || '').slice(0, 200);
        db.prepare("UPDATE email_outbox SET status='sent',sent_at=?,attempts=attempts+1,provider_id=?,last_error='' WHERE id=?").run(iso(Date.now()), providerId, row.id);
        counts.sent++;
      } catch (e) {
        const attempts = row.attempts + 1, failed = e.permanent || attempts >= MAX_ATTEMPTS;
        db.prepare('UPDATE email_outbox SET status=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=?')
          .run(failed ? 'failed' : 'pending', attempts, iso(nowMs + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]), oneLine(e.message, 300), row.id);
        failed ? counts.failed++ : counts.retrying++;
        console.warn(`[email] ${row.kind} to ${redact(row.to_email)} ${failed ? 'failed' : 'will retry'}: ${oneLine(e.message, 200)}`);
      }
    }
    return counts;
  })().finally(() => { running = null; });
  return running;
}

export function outboxStatus() {
  const cfg = emailConfig();
  const byStatus = Object.fromEntries(db.prepare('SELECT status,COUNT(*) AS n FROM email_outbox GROUP BY status').all().map(r => [r.status, r.n]));
  const recent = db.prepare(`SELECT id,kind,to_email,subject,status,attempts,last_error,created_at,sent_at FROM email_outbox
    ORDER BY created_at DESC,rowid DESC LIMIT 15`).all().map(r => ({
      id: r.id, kind: r.kind, to: redact(r.to_email), subject: r.subject, status: r.status, attempts: r.attempts,
      error: r.last_error, createdAt: r.created_at, sentAt: r.sent_at,
    }));
  return {
    configured: !cfg.problem, problem: cfg.problem, from: cfg.from ? `${cfg.from.name} <${cfg.from.email}>` : '',
    server: cfg.smtp.host ? `${cfg.smtp.host}:${cfg.smtp.port} (${cfg.smtp.secure}${cfg.smtp.user ? ', signed in' : ''})` : '',
    ownerAlerts: !!cfg.owner, publicUrl: cfg.publicUrl, dailyLimit: cfg.dailyLimit, sentToday: sentToday(),
    counts: { pending: byStatus.pending || 0, sending: byStatus.sending || 0, sent: byStatus.sent || 0, failed: byStatus.failed || 0 },
    recent,
  };
}

// Failed emails go back in the queue (after the admin fixed the key, sender or address problem).
export function retryFailed() {
  return { requeued: Number(db.prepare("UPDATE email_outbox SET status='pending',attempts=0,next_attempt_at=?,last_error='' WHERE status='failed'").run(iso(Date.now())).changes) };
}

// ── Templates ────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = path => { const base = publicUrl(); return base ? base + path : ''; };
const button = (href, label) => href ? `<p style="margin:28px 0"><a href="${esc(href)}" style="display:inline-block;background:#1F3B2D;color:#EFE9DC;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:600">${esc(label)}</a></p>` : '';

// One layout for every email: paragraphs are plain strings (escaped here), `html` blocks are trusted markup.
function render({ heading, paragraphs = [], action, after = [], footer }) {
  const p = t => `<p style="margin:0 0 14px;line-height:1.55">${esc(t)}</p>`;
  const body = paragraphs.map(x => typeof x === 'string' ? p(x) : x.html).join('');
  const tail = after.map(x => typeof x === 'string' ? p(x) : x.html).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#EDEBE5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#14201A">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<p style="margin:0 0 20px;font-family:Georgia,serif;font-size:20px;font-style:italic;color:#1F3B2D">Pagehouse</p>
<div style="background:#FFFFFF;border-radius:18px;padding:28px 26px;font-size:15px">
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;letter-spacing:-.01em">${esc(heading)}</h1>
${body}${action ? button(action.href, action.label) : ''}${tail}
</div>
<p style="margin:18px 6px 0;font-size:12.5px;line-height:1.5;color:#6B746F">${esc(footer || 'Pagehouse · Books worth keeping, for five cedis.')}</p>
</div></body></html>`;
  const plain = x => typeof x === 'string' ? x : x.text;
  const text = [heading, '', ...paragraphs.map(plain), ...(action && action.href ? ['', `${action.label}: ${action.href}`] : []), ...(after.length ? ['', ...after.map(plain)] : []), '', footer || 'Pagehouse'].join('\n');
  return { html, text };
}

const requestFooter = 'You are getting this because you asked Pagehouse to look for a book. We only use your email for this request.';
const describe = r => `“${r.title}” by ${r.author}`;

export function requestReceived(r) {
  const { html, text } = render({
    heading: 'We’re looking for your book',
    paragraphs: [
      r.name ? `Hi ${r.name},` : 'Hi,',
      `Thanks for your request for ${describe(r)}. We check every book added to Pagehouse against it, every day, until ${new Date(r.expires_at).toUTCString().slice(5, 16)}.`,
      'If we add it, we’ll email you a link straight away. If it doesn’t turn up within 30 days, we’ll let you know too.',
      `Your request reference is ${r.reference}.`,
    ],
    action: { href: link('/#request'), label: 'See your requests' },
    footer: requestFooter,
  });
  return { key: `request-received:${r.id}`, kind: 'request-received', to: r.email, toName: r.name, subject: `We’re looking for “${oneLine(r.title, 120)}”`, html, text };
}

export function requestMatched(r, book) {
  const { html, text } = render({
    heading: 'Your book is on the shelves',
    paragraphs: [
      r.name ? `Hi ${r.name},` : 'Hi,',
      `Good news: you asked us for ${describe(r)}, and it’s now in the Pagehouse catalogue as “${book.title}”${book.authors ? ` by ${book.authors}` : ''}.`,
      'Requested books are GH₵ 5, like everything else on the shelves.',
    ],
    action: { href: link('/?find=' + encodeURIComponent(book.title) + '#store'), label: 'See the book' },
    footer: requestFooter,
  });
  return { key: `request-matched:${r.id}:${book.id}`, kind: 'request-matched', to: r.email, toName: r.name, subject: `Found it: “${oneLine(book.title, 120)}” is on Pagehouse`, html, text };
}

export function requestExpired(r) {
  const { html, text } = render({
    heading: 'We couldn’t find your book this time',
    paragraphs: [
      r.name ? `Hi ${r.name},` : 'Hi,',
      `For the last 30 days we checked every new addition against your request for ${describe(r)}, and it hasn’t become available.`,
      'Your request is now closed. You’re welcome to ask again; new books are added every night.',
    ],
    action: { href: link('/#request'), label: 'Request another book' },
    footer: requestFooter,
  });
  return { key: `request-expired:${r.id}`, kind: 'request-expired', to: r.email, toName: r.name, subject: `Update on your request for “${oneLine(r.title, 120)}”`, html, text };
}

export function ownerNewRequest(r, owner) {
  const { html, text } = render({
    heading: 'New book request',
    paragraphs: [
      `${describe(r)}${r.isbn ? ` · ISBN ${r.isbn}` : ''}`,
      `From ${r.name ? `${r.name} ` : ''}<${r.email}> · ${r.reference}`,
      r.status === 'matched' ? 'It already matched a published book, and the customer has been told.' : 'It is open and will be matched against new books for 30 days.',
    ],
    action: { href: link('/admin'), label: 'Open the admin panel' },
    footer: 'Owner alert from your Pagehouse store.',
  });
  return { key: `owner-request:${r.id}`, kind: 'owner-request', to: owner, subject: `New request: ${oneLine(r.title, 120)}`, html, text };
}

export function orderReceipt(order, items) {
  const fmt = minor => `GH₵ ${(minor / 100).toFixed(2)}`;
  const rows = items.map(i => ({
    html: `<p style="margin:0 0 12px;line-height:1.5"><b>${esc(i.title)}</b> · ${esc(fmt(i.amountMinor))}<br>${i.url
      ? `<a href="${esc(i.url)}" style="color:#1F3B2D;font-weight:600">Download PDF</a>` : 'Download link: open the store page you paid on.'}</p>`,
    text: `${i.title} · ${fmt(i.amountMinor)}${i.url ? `\n  Download: ${i.url}` : ''}`,
  }));
  const { html, text } = render({
    heading: 'Thank you, your books are ready',
    paragraphs: [
      `Payment received for order ${order.reference}: ${fmt(order.amount_minor)}.`,
      ...rows,
    ],
    after: ['Each link works for 24 hours and up to 5 downloads. Keep this email: it is your receipt.'],
    footer: 'Pagehouse receipt. Reply to this email if a download does not work.',
  });
  return { key: `order-receipt:${order.id}`, kind: 'order-receipt', to: order.email, subject: `Your Pagehouse books · ${order.reference}`, html, text };
}

export function testEmail(to) {
  const { html, text } = render({ heading: 'Pagehouse email works', paragraphs: ['This is a test from your Pagehouse admin panel. If you can read it, customer and owner emails will be delivered.'], footer: 'Test message.' });
  return { key: `test:${crypto.randomUUID()}`, kind: 'test', to, subject: 'Pagehouse test email', html, text };
}
