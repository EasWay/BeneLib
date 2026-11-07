import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-email-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
process.env.PAGEHOUSE_FILES_DIR = path.join(root, 'private-files');
process.env.PAGEHOUSE_TOKEN_SECRET = 'test-only-token-key-with-32-bytes-minimum';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_no_real_payment';
process.env.PAGEHOUSE_PUBLIC_URL = 'https://store.example.test/';
process.env.PAGEHOUSE_OWNER_EMAIL = 'owner@example.test';
delete process.env.SMTP_HOST;
process.env.PAGEHOUSE_EMAIL_FROM = 'Pagehouse <books@example.test>';
const catalog = await import('../src/pagehouse.js');
catalog.saveRightsPolicy({ license: 'CC BY 4.0', rightsScope: 'commercial redistribution', rightsEvidence: 'Test fixture license', confirmUniversalRights: true });
catalog.saveSourceLicence('catalog', { licensor: 'Test Press', licence: 'Test agreement', rightsScope: 'Test scope', evidence: 'Test fixture', permitsSale: true, permitsRedistribution: true, confirm: true });
const payments = await import('../src/pagehouse-payments.js');
const requests = await import('../src/pagehouse-requests.js');
const email = await import('../src/pagehouse-email.js');
const { db } = catalog;
const DAY = 864e5;

const sent = [];
// The outbox logic runs against an in-memory transport here; test/smtp.test.mjs covers the SMTP conversation,
// and the end of this file sends one email through a real local SMTP connection.
const { SmtpError } = await import('../src/smtp.js');
let answer = () => '250 2.0.0 Ok: queued';
const transport = async (row, cfg) => {
  sent.push({ kind: row.kind, to: row.to_email, toName: row.to_name, subject: row.subject, html: row.html, text: row.text, from: cfg.from });
  return answer(row);
};
const outbox = () => db.prepare('SELECT kind,to_email,status,attempts,subject,html,text FROM email_outbox ORDER BY created_at,rowid').all();
const kinds = () => sent.map(m => m.kind);

try {
  catalog.importBooks([{ sourceId: 'catalog', sourceRef: 'tfa', sourceName: 'Catalog', title: 'Things Fall Apart', authors: 'Chinua Achebe',
    license: 'Test', rightsStatus: 'approved', rightsScope: 'test', rightsEvidence: 'fixture', priceMinor: 500, currency: 'GHS', fileStatus: 'ready', fileKey: 'tfa.pdf' }]);
  fs.writeFileSync(path.join(process.env.PAGEHOUSE_FILES_DIR, 'tfa.pdf'), '%PDF');

  // Without an API key emails are queued, never dropped.
  const open = requests.createRequest({ title: 'Arrow of <b>God</b>', author: 'Chinua Achebe', email: 'Ama@Example.test', name: 'Ama' });
  assert.deepEqual(outbox().map(m => [m.kind, m.to_email, m.status]), [['request-received', 'ama@example.test', 'pending'], ['owner-request', 'owner@example.test', 'pending']]);
  assert.equal(email.isConfigured(), false);
  assert.equal(email.outboxStatus().problem, 'SMTP_HOST is not set');
  process.env.SMTP_HOST = 'smtp.example.test'; process.env.SMTP_SECURE = 'none';
  assert.match(email.outboxStatus().problem, /only allowed for a mail server on this machine/);
  process.env.SMTP_SECURE = 'starttls'; process.env.SMTP_USER = 'u';
  assert.equal(email.outboxStatus().problem, 'Set SMTP_USER and SMTP_PASS together');
  delete process.env.SMTP_USER; delete process.env.SMTP_HOST;
  // Gmail: sender defaults to the signed-in account; App Password spaces are dropped (other hosts keep them).
  const savedFrom = process.env.PAGEHOUSE_EMAIL_FROM; delete process.env.PAGEHOUSE_EMAIL_FROM;
  Object.assign(process.env, { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'pagehouse.store@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' });
  assert.deepEqual(email.emailConfig().from, { email: 'pagehouse.store@gmail.com', name: 'Pagehouse' });
  assert.equal(email.emailConfig().smtp.pass, 'abcdefghijklmnop');
  assert.equal(email.emailConfig().smtp.port, 587);
  assert.equal(email.outboxStatus().problem, '');
  process.env.SMTP_HOST = 'mail.example.test';
  assert.equal(email.emailConfig().smtp.pass, 'abcd efgh ijkl mnop');
  process.env.PAGEHOUSE_EMAIL_FROM = savedFrom;
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS; delete process.env.SMTP_HOST;
  assert.deepEqual(await email.processOutbox({ transport }), { sent: 0, failed: 0, retrying: 0, waiting: 2 });
  assert.equal(sent.length, 0);

  // User text is escaped in HTML and kept plain in the text part.
  const received = outbox()[0];
  assert.match(received.html, /Arrow of &lt;b&gt;God&lt;\/b&gt;/);
  assert.doesNotMatch(received.html, /<b>God<\/b>/);
  assert.match(received.text, /Arrow of <b>God<\/b>/);
  assert.match(received.html, /https:\/\/store\.example\.test\/#request/);

  // Configured: the queue drains through Brevo with sender, recipient and both bodies.
  process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_SECURE = 'none';
  assert.deepEqual(await email.processOutbox({ transport }), { sent: 2, failed: 0, retrying: 0, waiting: 0 });
  assert.deepEqual(sent[0].from, { email: 'books@example.test', name: 'Pagehouse' });
  assert.equal(sent[0].to, 'ama@example.test'); assert.equal(sent[0].toName, 'Ama');
  assert.ok(sent[0].html && sent[0].text && sent[0].subject.includes('Arrow of'));
  assert.deepEqual(kinds(), ['request-received', 'owner-request']);

  // Already on the shelves: one "found it" email instead of "we're looking", with a link that opens the search.
  sent.length = 0;
  requests.createRequest({ name: 'Reader', title: 'Things Fall Apart', author: 'Achebe', email: 'kofi@example.test' });
  await email.processOutbox({ transport });
  assert.deepEqual(kinds(), ['request-matched', 'owner-request']);
  assert.match(sent[0].html, /https:\/\/store\.example\.test\/\?find=Things%20Fall%20Apart#store/);

  // The nightly harvest adds the open request's book: one email, and a second sweep sends nothing more.
  sent.length = 0;
  catalog.importBooks([{ sourceId: 'catalog', sourceRef: 'aog', sourceName: 'Catalog', title: 'Arrow of God', authors: 'Chinua Achebe',
    license: 'Test', rightsStatus: 'approved', rightsScope: 'test', rightsEvidence: 'fixture' }]);
  requests.sweepRequests(); requests.sweepRequests();
  await email.processOutbox({ transport });
  assert.deepEqual(kinds(), ['request-matched']);
  assert.equal(sent[0].to, 'ama@example.test');

  // Expiry sends the "not available" email once.
  sent.length = 0;
  requests.createRequest({ name: 'Reader', title: 'A Book Nobody Has', author: 'Nobody', email: 'yaw@example.test' });
  const later = Date.now() + 31 * DAY;
  requests.sweepRequests(later); requests.sweepRequests(later);
  await email.processOutbox({ transport });
  assert.deepEqual(kinds(), ['request-received', 'owner-request', 'request-expired']);

  // Paying sends a receipt with absolute download links, once, even when verify and the webhook both mark it paid.
  sent.length = 0;
  const id = catalog.searchCatalog({ q: 'Things Fall Apart' }).items[0].id;
  let amount = 0;
  const paystack = async (url, init) => {
    if (url.endsWith('/transaction/initialize')) { const b = JSON.parse(init.body); amount = b.amount; return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', reference: b.reference, access_code: 'a' } }); }
    return Response.json({ status: true, data: { reference: decodeURIComponent(url.split('/').pop()), status: 'success', amount, currency: 'GHS' } });
  };
  const order = await payments.createCheckout({ bookIds: [id], email: 'buyer@example.test', idempotencyKey: 'email-test-key-0001' }, paystack);
  await payments.verifyCheckout(order.reference, paystack);
  await payments.verifyCheckout(order.reference, paystack);
  await email.processOutbox({ transport });
  assert.deepEqual(kinds(), ['order-receipt']);
  const download = sent[0].html.match(/https:\/\/store\.example\.test\/api\/store\/download\/([A-Za-z0-9_.-]+)/);
  assert.ok(download, 'receipt carries an absolute download link');
  assert.ok(payments.consumeDownloadToken(download[1]), 'the emailed link is a working download token');
  assert.match(sent[0].text, /GH₵ 5\.00/);

  // Failures: 5xx retries with backoff, 400 fails for good, retryFailed requeues.
  sent.length = 0;
  answer = () => { throw new SmtpError('Message refused: 451 try later', { code: 451 }); };
  email.enqueue(email.testEmail('one@example.test'));
  assert.equal((await email.processOutbox({ transport })).retrying, 1);
  assert.equal((await email.processOutbox({ transport })).waiting, 0, 'not retried before its backoff');
  const retryAt = Date.now() + 2 * 60e3;
  answer = () => { throw new SmtpError('Recipient refused: 550 no such user', { code: 550, permanent: true }); };
  assert.equal((await email.processOutbox({ transport, nowMs: retryAt })).failed, 1);
  assert.equal(email.outboxStatus().counts.failed, 1);
  assert.equal(email.outboxStatus().recent[0].error, 'Recipient refused: 550 no such user');
  answer = () => '250 ok';
  assert.equal(email.retryFailed().requeued, 1);
  assert.equal((await email.processOutbox({ transport })).sent, 1);

  // Daily cap: past the limit, the rest wait.
  process.env.PAGEHOUSE_EMAIL_DAILY_LIMIT = String(email.outboxStatus().sentToday + 1);
  email.enqueue(email.testEmail('a@example.test')); email.enqueue(email.testEmail('b@example.test'));
  assert.deepEqual(await email.processOutbox({ transport }), { sent: 1, failed: 0, retrying: 0, waiting: 1 });
  delete process.env.PAGEHOUSE_EMAIL_DAILY_LIMIT;

  // Status for the admin panel never shows full addresses; bad addresses and duplicate keys are not queued.
  assert.ok(email.outboxStatus().recent.every(m => /\*\*\*@/.test(m.to)));
  assert.equal(email.enqueue({ key: 'x', kind: 'test', to: 'not-an-email', subject: 's', html: '', text: '' }), false);
  assert.equal(email.enqueue({ key: 'dup', kind: 'test', to: 'a@example.test', subject: 's', html: '', text: '' }), true);
  assert.equal(email.enqueue({ key: 'dup', kind: 'test', to: 'a@example.test', subject: 's', html: '', text: '' }), false);
  // One email end to end: outbox → SMTP client → a mail server on this machine.
  const net = await import('node:net');
  const delivered = [];
  const server = net.createServer(socket => {
    let buf = '', data = null; const say = x => socket.write(x + '\r\n');
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) { if (line === '.') { delivered.push(data); data = null; say('250 queued as E2E'); } else data += line + '\r\n'; continue; }
      if (/^EHLO/.test(line)) say('250 local'); else if (/^DATA/.test(line)) { data = ''; say('354 go'); } else if (/^QUIT/.test(line)) { say('221 bye'); socket.end(); } else say('250 ok'); } });
    say('220 local ESMTP');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = String(server.address().port); process.env.SMTP_SECURE = 'none';
  db.prepare("UPDATE email_outbox SET status='sent' WHERE status='pending'").run();
  email.enqueue(email.testEmail('e2e@example.test'));
  assert.equal((await email.processOutbox()).sent, 1);
  server.close();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /^To: <e2e@example\.test>\r\n/m);
  assert.match(delivered[0], /^Message-ID: <[0-9a-f-]{36}@example\.test>\r\n/m, 'Message-ID uses the sender domain');
  assert.match(delivered[0], /^X-Pagehouse-Kind: test\r\n/m);
  assert.match(email.outboxStatus().recent[0].status, /sent/);
  console.log('pagehouse email tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
