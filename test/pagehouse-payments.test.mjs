import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-payments-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
process.env.PAGEHOUSE_FILES_DIR = path.join(root, 'private-files');
process.env.PAGEHOUSE_TOKEN_SECRET = 'test-only-token-key-with-32-bytes-minimum';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_no_real_payment';
fs.mkdirSync(process.env.PAGEHOUSE_FILES_DIR, { recursive: true });
const catalog = await import('../src/pagehouse.js');
const payments = await import('../src/pagehouse-payments.js');

const book = {
  sourceId: 'catalog', sourceRef: 'payment-test-book', sourceName: 'Catalog', title: 'Test Book', authors: 'A Writer',
  license: 'Test permitted use', rightsStatus: 'approved', rightsScope: 'test', rightsEvidence: 'test fixture',
  priceMinor: 575, currency: 'GHS', fileStatus: 'ready', fileKey: 'test-book.pdf',
};
const [id] = (() => { catalog.importBooks([book]); return [catalog.searchCatalog({ q: 'Test Book' }).items[0].id]; })();
fs.writeFileSync(path.join(process.env.PAGEHOUSE_FILES_DIR, 'test-book.pdf'), Buffer.from('%PDF test data'));
let expectedAmount = 575;
let initializeCount = 0;
let amountAdjustment = 0;
const fakePaystack = async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer sk_test_no_real_payment');
  if (url.endsWith('/transaction/initialize')) {
    initializeCount++;
    const payload = JSON.parse(options.body);
    expectedAmount = payload.amount;
    return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/test', reference: payload.reference, access_code: 'test-access' } });
  }
  const reference = decodeURIComponent(url.split('/').pop());
  return Response.json({ status: true, data: { reference, status: 'success', amount: expectedAmount + amountAdjustment, currency: 'GHS' } });
};

try {
  const checkout = { bookIds: [id], email: 'reader@example.test', idempotencyKey: 'test-checkout-key-0001' };
  const started = await payments.createCheckout(checkout, fakePaystack);
  assert.equal(started.status, 'pending');
  assert.equal(started.authorizationUrl, 'https://checkout.paystack.com/test');
  assert.equal(started.amountMinor, 575);
  const retried = await payments.createCheckout(checkout, fakePaystack);
  assert.equal(retried.reference, started.reference);
  assert.equal(initializeCount, 1, 'duplicate checkout request does not initialize a second payment');
  const verified = await payments.verifyCheckout(started.reference, fakePaystack);
  assert.equal(verified.status, 'paid');
  assert.equal(verified.items[0].title, 'Test Book');
  assert.match(verified.items[0].downloadUrl, /^\/api\/store\/download\//);
  assert.equal(payments.getOrderForBuyer(started.reference, 'wrong@example.test'), null);

  const token = verified.items[0].downloadUrl.split('/').pop();
  const delivered = payments.consumeDownloadToken(token);
  assert.equal(delivered.filename, 'test-book.pdf');
  assert.equal(fs.readFileSync(delivered.path).toString(), '%PDF test data');
  for (let i = 0; i < 4; i++) assert.ok(payments.consumeDownloadToken(token));
  assert.equal(payments.consumeDownloadToken(token), null, 'sixth use is denied after five allowed uses');
  assert.equal(payments.consumeDownloadToken(token + 'tampered'), null);

  const eventBody = JSON.stringify({ event: 'charge.success', data: { reference: started.reference } });
  const signature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(eventBody).digest('hex');
  assert.deepEqual(await payments.handlePaystackWebhook(eventBody, signature, fakePaystack), { accepted: true, paid: true, reference: started.reference });
  assert.deepEqual(await payments.handlePaystackWebhook(eventBody, signature, fakePaystack), { accepted: true, duplicate: true });
  await assert.rejects(payments.handlePaystackWebhook(eventBody, 'bad', fakePaystack), e => e.statusCode === 401);

  const second = await payments.createCheckout({ ...checkout, idempotencyKey: 'test-checkout-key-0002' }, fakePaystack);
  amountAdjustment = 1;
  await assert.rejects(payments.verifyCheckout(second.reference, fakePaystack), /did not match/);
  amountAdjustment = 0;
  assert.equal(payments.getOrderForBuyer(second.reference, checkout.email).status, 'pending', 'mismatched amount never grants entitlement');

  await assert.rejects(payments.createCheckout({ ...checkout, email: 'bad' }, fakePaystack), /valid email/);
  console.log('Pagehouse checkout and delivery: ok');
} finally {
  catalog.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
