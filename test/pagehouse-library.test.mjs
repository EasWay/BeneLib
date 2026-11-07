// Libraries without accounts: passkeys (checked against a software authenticator with real keys), MoMo
// checkout through the Charge API, the MoMo-number link and restore, and Paystack's timestamped webhook signature.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-library-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
process.env.PAGEHOUSE_FILES_DIR = path.join(root, 'private-files');
process.env.PAGEHOUSE_TOKEN_SECRET = 'test-only-token-key-with-32-bytes-minimum';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_no_real_payment';
delete process.env.PAYSTACK_WEBHOOK_SECRET;
fs.mkdirSync(process.env.PAGEHOUSE_FILES_DIR, { recursive: true });
const catalog = await import('../src/pagehouse.js');
const requests = await import('../src/pagehouse-requests.js');
const payments = await import('../src/pagehouse-payments.js');
const library = await import('../src/pagehouse-library.js');
const webauthn = await import('../src/webauthn.js');
const { db } = catalog;
catalog.saveRightsPolicy({
  license: 'CC BY 4.0', rightsScope: 'commercial redistribution',
  rightsEvidence: 'Test fixture license', confirmUniversalRights: true,
});
catalog.saveSourceLicence('catalog', { licensor: 'Test Press', licence: 'Test agreement', rightsScope: 'Test scope', evidence: 'Test fixture', permitsSale: true, permitsRedistribution: true, confirm: true });

// ── A software authenticator ─────────────────────────────────────────────────
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n])
    : n < 65536 ? Buffer.from([major << 5 | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = major << 5 | 26; b.writeUInt32BE(n, 1); return b; })();
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cannot encode');
}
const sha256 = b => crypto.createHash('sha256').update(b).digest();
class Authenticator {
  constructor(kind = 'es256') {
    this.kind = kind;
    this.keys = crypto.generateKeyPairSync(kind === 'es256' ? 'ec' : 'ed25519', kind === 'es256' ? { namedCurve: 'P-256' } : {});
    this.credentialId = crypto.randomBytes(32);
    this.counter = 0;
  }
  cose() {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return this.kind === 'es256'
      ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
      : new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]);
  }
  authData(rpId, { attested = false, flags = 0x05, counter = this.counter } = {}) {
    const head = Buffer.alloc(37); sha256(rpId).copy(head, 0); head[32] = flags | (attested ? 0x40 : 0); head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, this.credentialId, cbor(this.cose())]);
  }
  create(options, origin, over = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.publicKey.challenge, origin: over.origin || origin }));
    const authData = this.authData(over.rpId || options.publicKey.rp.id, { attested: true, flags: over.flags ?? 0x05 });
    return { id: webauthn.b64u(this.credentialId), rawId: webauthn.b64u(this.credentialId), type: 'public-key',
      response: { clientDataJSON: webauthn.b64u(clientData), attestationObject: webauthn.b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal', 'hybrid'] } };
  }
  get(options, origin, userHandle, over = {}) {
    if (over.counter === undefined) this.counter += 1;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: over.challenge || options.publicKey.challenge, origin: over.origin || origin }));
    const authData = this.authData(options.publicKey.rpId, { flags: over.flags ?? 0x05, counter: over.counter ?? this.counter });
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = this.kind === 'es256' ? crypto.sign('sha256', signed, this.keys.privateKey) : crypto.sign(null, signed, this.keys.privateKey);
    return { id: webauthn.b64u(this.credentialId), type: 'public-key',
      response: { clientDataJSON: webauthn.b64u(clientData), authenticatorData: webauthn.b64u(authData), signature: webauthn.b64u(over.badSig ? Buffer.alloc(64) : signature), userHandle } };
  }
}
const rp = { id: 'store.example.test', origin: 'https://store.example.test' };
const userHandle = opts => opts.publicKey.user.id;

try {
  // ── Passkeys ─────────────────────────────────────────────────────────────
  const phone1 = new Authenticator('es256');
  const regOpts = library.registrationOptions(rp, null);
  assert.equal(regOpts.publicKey.authenticatorSelection.userVerification, 'required');
  assert.equal(regOpts.publicKey.authenticatorSelection.residentKey, 'required');
  const lib = library.finishRegistration(regOpts.challengeId, phone1.create(regOpts, rp.origin));
  assert.match(lib.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => library.finishRegistration(regOpts.challengeId, phone1.create(regOpts, rp.origin)), /expired/, 'a challenge is single use');

  // Registration refusals.
  const refuse = (over, re) => { const o = library.registrationOptions(rp, null); assert.throws(() => library.finishRegistration(o.challengeId, new Authenticator().create(o, rp.origin, over)), re); };
  refuse({ origin: 'https://evil.example' }, /another site/);
  refuse({ rpId: 'evil.example' }, /another site/);
  refuse({ flags: 0x01 }, /Face ID, fingerprint or the device PIN/);

  // Sign in with it (discoverable: no credential list sent).
  let loginOpts = library.loginOptions(rp);
  assert.equal(loginOpts.publicKey.allowCredentials, undefined);
  assert.equal(library.finishLogin(loginOpts.challengeId, phone1.get(loginOpts, rp.origin, userHandle(regOpts))).id, lib.id);

  // Sign-in refusals: tampered signature, wrong origin, replayed challenge, no user verification, cloned counter.
  const failLogin = (over, re) => { const o = library.loginOptions(rp); assert.throws(() => library.finishLogin(o.challengeId, phone1.get(o, rp.origin, userHandle(regOpts), over)), re); };
  failLogin({ badSig: true }, /signature is not valid/);
  failLogin({ origin: 'https://evil.example' }, /another site/);
  failLogin({ challenge: loginOpts.publicKey.challenge }, /challenge does not match/);
  failLogin({ flags: 0x01 }, /Face ID, fingerprint or the device PIN/);
  failLogin({ counter: 1 }, /cloned/);
  const stranger = new Authenticator();
  const so = library.loginOptions(rp);
  assert.throws(() => library.finishLogin(so.challengeId, stranger.get(so, rp.origin, userHandle(regOpts))), /not saved with Quiet Chapters/);

  // A second passkey (Ed25519, synced: counter 0) joins the same Library; the first is excluded from re-adding.
  const laptop = new Authenticator('ed25519');
  const addOpts = library.registrationOptions(rp, lib);
  assert.equal(addOpts.publicKey.excludeCredentials[0].id, webauthn.b64u(phone1.credentialId));
  assert.equal(library.finishRegistration(addOpts.challengeId, laptop.create(addOpts, rp.origin)).id, lib.id);
  loginOpts = library.loginOptions(rp);
  assert.equal(library.finishLogin(loginOpts.challengeId, laptop.get(loginOpts, rp.origin, userHandle(addOpts), { counter: 0 })).id, lib.id);
  assert.equal(library.summary(lib).passkeys, 2);

  // Session cookie: signed, tamper-proof.
  const cookie = library.sessionCookie(lib.id, true).split(';')[0];
  assert.match(library.sessionCookie(lib.id, true), /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(library.sessionLibrary({ headers: { cookie } }).id, lib.id);
  assert.equal(library.sessionLibrary({ headers: { cookie: cookie.replace(/.$/, c => c === 'A' ? 'B' : 'A') } }), null);

  // Requests made in the Library belong to it.
  requests.createRequest({ title: 'Arrow of God', author: 'Achebe', name: 'Ama', email: 'ama@example.test' }, Date.now(), { libraryId: lib.id });
  assert.equal(requests.libraryRequests(lib.id)[0].title, 'Arrow of God');

  // ── MoMo ─────────────────────────────────────────────────────────────────
  assert.deepEqual(payments.parseGhanaPhone('+233 24 412 4521'), { intl: '233244124521', local: '0244124521', provider: 'mtn' });
  assert.equal(payments.parseGhanaPhone('0201234567').provider, 'vod');
  assert.equal(payments.parseGhanaPhone('0571234567').provider, 'atl');
  assert.equal(payments.parseGhanaPhone('0311234567'), null, 'landline prefix');
  assert.equal(payments.parseGhanaPhone('024412452'), null, 'too short');

  catalog.importBooks([{ sourceId: 'catalog', sourceRef: 'momo-book', sourceName: 'Catalog', title: 'Things Fall Apart', authors: 'Chinua Achebe',
    license: 'L', rightsStatus: 'approved', rightsScope: 'S', rightsEvidence: 'E', priceMinor: 500, currency: 'GHS', fileStatus: 'ready', fileKey: 'tfa.pdf' }]);
  fs.writeFileSync(path.join(process.env.PAGEHOUSE_FILES_DIR, 'tfa.pdf'), '%PDF');
  const bookId = catalog.searchCatalog({ q: 'Things Fall Apart' }).items[0].id;
  let txStatus = 'pending', charged = [];
  const paystack = async (url, init) => {
    if (url.endsWith('/charge')) { const b = JSON.parse(init.body); charged.push(b); return Response.json({ status: true, data: { reference: b.reference, status: 'pay_offline', display_text: 'Please complete authorization process on your mobile phone' } }); }
    const reference = decodeURIComponent(url.split('/').pop());
    return Response.json({ status: true, data: { reference, status: txStatus, amount: 500, currency: 'GHS', gateway_response: 'Declined by customer' } });
  };
  const secretA = 'a'.repeat(40), hashA = library.hashSecret(secretA);
  const momo = await payments.createMomoCharge({ bookIds: [bookId], email: 'ama@example.test', phone: '024 412 4521', idempotencyKey: 'momo-key-00000001' }, paystack, { libraryId: lib.id, clientHash: hashA });
  assert.equal(momo.status, 'pending');
  assert.match(momo.displayText, /authorization/);
  assert.deepEqual(charged[0].mobile_money, { phone: '0244124521', provider: 'mtn' });
  assert.equal(charged[0].amount, 500, 'amount comes from the catalogue, not the browser');
  // Same key again: no second prompt on the phone.
  await payments.createMomoCharge({ bookIds: [bookId], email: 'ama@example.test', phone: '0244124521', idempotencyKey: 'momo-key-00000001' }, paystack, { libraryId: lib.id, clientHash: hashA });
  assert.equal(charged.length, 1);

  // While the customer is approving, /verify says pending (no error); then success.
  assert.equal((await payments.verifyCheckout(momo.reference, paystack)).status, 'pending');
  txStatus = 'success';
  const paid = await payments.verifyCheckout(momo.reference, paystack);
  assert.equal(paid.status, 'paid');
  // The approved number is now the Library's; its books are listed with working download links.
  assert.equal(db.prepare('SELECT momo_phone FROM libraries WHERE id=?').get(lib.id).momo_phone, '233244124521');
  assert.deepEqual(library.summary(db.prepare('SELECT * FROM libraries WHERE id=?').get(lib.id)), { id: lib.id, passkeys: 2, phone: '024 ••• 4521', network: 'MTN' });
  const orders = payments.libraryOrders(lib.id);
  assert.equal(orders[0].items[0].title, 'Things Fall Apart');
  assert.ok(payments.consumeDownloadToken(orders[0].items[0].downloadUrl.split('/').pop()));
  // Only the browser that started the checkout is put into the Library by /verify.
  assert.equal(payments.libraryForVerifiedOrder(momo.reference, hashA), lib.id);
  assert.equal(payments.libraryForVerifiedOrder(momo.reference, library.hashSecret('b'.repeat(40))), '');
  assert.equal(payments.libraryForVerifiedOrder(momo.reference, ''), '');

  // New phone, no passkey: paying with the same number restores the same Library (and its requests).
  const momo2 = await payments.createMomoCharge({ bookIds: [bookId], email: 'ama@example.test', phone: '0244124521', idempotencyKey: 'momo-key-00000002' }, paystack, { clientHash: library.hashSecret('c'.repeat(40)) });
  await payments.verifyCheckout(momo2.reference, paystack);
  assert.equal(payments.libraryForVerifiedOrder(momo2.reference, library.hashSecret('c'.repeat(40))), lib.id);
  assert.equal(payments.libraryOrders(lib.id).length, 2);

  // A passkey Library made on another phone merges into the number's Library when it pays with that number.
  const phone2 = new Authenticator();
  const o2 = library.registrationOptions(rp, null);
  const lib2 = library.finishRegistration(o2.challengeId, phone2.create(o2, rp.origin));
  requests.createRequest({ title: 'No Longer at Ease', author: 'Achebe', name: 'Ama', email: 'ama2@example.test' }, Date.now(), { libraryId: lib2.id });
  const momo3 = await payments.createMomoCharge({ bookIds: [bookId], email: 'ama@example.test', phone: '0244124521', idempotencyKey: 'momo-key-00000003' }, paystack, { libraryId: lib2.id, clientHash: hashA });
  await payments.verifyCheckout(momo3.reference, paystack);
  assert.equal(db.prepare('SELECT 1 FROM libraries WHERE id=?').get(lib2.id), undefined, 'merged away');
  assert.equal(library.summary({ id: lib.id }).passkeys, 3, 'its passkey now opens the merged Library');
  assert.deepEqual(requests.libraryRequests(lib.id).map(r => r.title).sort(), ['Arrow of God', 'No Longer at Ease']);
  const o3 = library.loginOptions(rp);
  assert.equal(library.finishLogin(o3.challengeId, phone2.get(o3, rp.origin, userHandle(o2))).id, lib.id);

  // A declined prompt fails the order.
  txStatus = 'failed';
  const momo4 = await payments.createMomoCharge({ bookIds: [bookId], email: 'kofi@example.test', phone: '0501234567', idempotencyKey: 'momo-key-00000004' }, paystack);
  await assert.rejects(payments.verifyCheckout(momo4.reference, paystack), /Declined by customer/);
  assert.equal(db.prepare('SELECT status FROM store_orders WHERE reference=?').get(momo4.reference).status, 'failed');
  await assert.rejects(payments.createMomoCharge({ bookIds: [bookId], email: 'kofi@example.test', phone: '0311234567', idempotencyKey: 'momo-key-00000005' }, paystack), /Ghana mobile money number/);

  // ── Webhook signatures ───────────────────────────────────────────────────
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'PH-x' } }));
  const legacy = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
  assert.equal(payments.verifyWebhookSignature(body, { legacy }), true, 'legacy signature without a webhook secret');
  assert.equal(payments.verifyWebhookSignature(body, { legacy: legacy.replace(/^./, c => c === 'a' ? 'b' : 'a') }), false);
  process.env.PAYSTACK_WEBHOOK_SECRET = 'whsec_test_secret';
  const t = Math.floor(Date.now() / 1000);
  const modern = (secret, ts) => crypto.createHmac('sha512', secret).update(`${ts}.`).update(body).digest('hex');
  assert.equal(payments.verifyWebhookSignature(body, { modern: `t=${t},v1=whk_1:${modern('whsec_test_secret', t)}` }), true);
  assert.equal(payments.verifyWebhookSignature(body, { modern: `t=${t},v1=whk_old:${modern('whsec_old', t)},v1=whk_1:${modern('whsec_test_secret', t)}` }), true, 'any v1 during rotation');
  assert.equal(payments.verifyWebhookSignature(body, { modern: `t=${t - 301},v1=whk_1:${modern('whsec_test_secret', t - 301)}` }), false, 'older than 300 s');
  assert.equal(payments.verifyWebhookSignature(body, { modern: `t=${t},v1=whk_1:${modern('whsec_wrong', t)}` }), false);
  assert.equal(payments.verifyWebhookSignature(body, { legacy }), false, 'with a webhook secret the timestamped signature is required');
  delete process.env.PAYSTACK_WEBHOOK_SECRET;
  console.log('pagehouse library tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
