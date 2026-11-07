import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createPaystackSimulator } from '../scripts/paystack-sim.mjs';

const webhookSecret = 'whsec_test_only';
const received = [];
const webhook = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({ raw: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
  res.writeHead(200).end('ok');
});
await new Promise(resolve => webhook.listen(0, '127.0.0.1', resolve));
const webhookUrl = `http://127.0.0.1:${webhook.address().port}/webhooks/paystack`;
const simulator = createPaystackSimulator({
  port: 0, apiSecret: 'sk_test_local', webhookSecret, webhookUrl, callbackUrl: 'http://localhost:8081/#checkout',
});
await new Promise(resolve => simulator.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${simulator.server.address().port}`;
const headers = { Authorization: 'Bearer sk_test_local', 'Content-Type': 'application/json' };
const reference = `PH-${'a'.repeat(36)}`;
const referenceMomo = `PH-${'b'.repeat(36)}`;

try {
  const card = await fetch(base + '/transaction/initialize', { method: 'POST', headers, body: JSON.stringify({
    email: 'reader@example.test', amount: 500, currency: 'GHS', reference,
  }) }).then(response => response.json());
  assert.equal(card.data.reference, reference);
  assert.equal(new URL(card.data.authorization_url).pathname, `/pay/${reference}`);
  assert.match(await fetch(card.data.authorization_url).then(response => response.text()), /Approve Card payment/);
  const back = await fetch(`${base}/sim/settle/${reference}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'status=success' });
  assert.equal(back.status, 303, 'approving a card sends the browser back to the store, like Paystack');
  assert.equal(back.headers.get('location'), `http://localhost:8081/?trxref=${reference}&reference=${reference}#checkout`);
  assert.equal((await fetch(`${base}/transaction/verify/${reference}`, { headers }).then(r => r.json())).data.status, 'success');
  const offsite = `PH-${'c'.repeat(36)}`;
  const evil = await fetch(base + '/transaction/initialize', { method: 'POST', headers, body: JSON.stringify({ email: 'r@example.test', amount: 500, currency: 'GHS', reference: offsite, callback_url: 'https://evil.example/steal' }) }).then(r => r.json());
  assert.ok(evil.data.reference === offsite, 'an off-machine callback is ignored, the default is used');

  const momo = await fetch(base + '/charge', { method: 'POST', headers, body: JSON.stringify({
    email: 'reader@example.test', amount: 500, currency: 'GHS', reference: referenceMomo,
    mobile_money: { phone: '0244124521', provider: 'mtn' },
  }) }).then(response => response.json());
  assert.match(momo.data.display_text, new RegExp(`/phone/${referenceMomo}`));
  assert.equal((await fetch(`${base}/transaction/verify/${referenceMomo}`, { headers }).then(response => response.json())).data.status, 'pending');
  assert.match(await fetch(`${base}/phone/${referenceMomo}`).then(response => response.text()), /Approve Mobile Money payment/);
  const phone = await fetch(`${base}/phone`).then(r => r.text());
  assert.match(phone, /0244124521 · MTN/, 'the phone page lists the waiting prompt');
  await fetch(`${base}/sim/settle/${referenceMomo}`, { method: 'POST', headers, body: JSON.stringify({ status: 'failed' }) });
  assert.equal((await fetch(`${base}/transaction/verify/${referenceMomo}`, { headers }).then(response => response.json())).data.status, 'failed');

  assert.equal(received.length, 2);
  for (const event of received) {
    const [timestampPart, signaturePart] = event.headers['paystack-signature'].split(',');
    const timestamp = timestampPart.slice(2);
    const signature = signaturePart.slice(3);
    const expected = crypto.createHmac('sha512', webhookSecret).update(`${timestamp}.`).update(event.raw).digest('hex');
    assert.equal(signature, expected, 'simulator webhook signature is valid');
  }
  assert.equal(JSON.parse(received[0].raw).event, 'charge.success');
  assert.equal(JSON.parse(received[1].raw).event, 'charge.failed');
  console.log('Local Paystack simulator: ok');
} finally {
  simulator.server.closeAllConnections();
  webhook.closeAllConnections();
  await Promise.all([
    new Promise(resolve => simulator.server.close(resolve)),
    new Promise(resolve => webhook.close(resolve)),
  ]);
}
