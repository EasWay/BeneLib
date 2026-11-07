// Pagehouse checkout, verified Paystack payments, and buyer-specific download entitlements.
// No card data is handled here. Checkout initialization only creates a provider checkout session;
// payment is complete only after the signed webhook AND server-side transaction verification succeed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { db, storePrice } from './pagehouse.js';
import * as email from './pagehouse-email.js';
import * as library from './pagehouse-library.js';
import * as delivery from './pagehouse-delivery.js';

const FILES_DIR = path.resolve(process.env.PAGEHOUSE_FILES_DIR || path.join(DATA, 'pagehouse-files'));
fs.mkdirSync(FILES_DIR, { recursive: true });
const TOKEN_KEY_FILE = path.join(DATA, 'pagehouse-token.key');
fs.mkdirSync(DATA, { recursive: true });
let tokenSecret = process.env.PAGEHOUSE_TOKEN_SECRET || '';
if (!tokenSecret && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PAYSTACK_SECRET_KEY)) {
  tokenSecret = crypto.createHash('sha256').update('pagehouse-token:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.PAYSTACK_SECRET_KEY)).digest('base64url');
}
if (!tokenSecret) {
  try { tokenSecret = fs.readFileSync(TOKEN_KEY_FILE, 'utf8').trim(); }
  catch {
    const generated = crypto.randomBytes(32).toString('base64url');
    try { fs.writeFileSync(TOKEN_KEY_FILE, generated, { mode: 0o600, flag: 'wx' }); tokenSecret = generated; }
    catch (e) { if (e.code !== 'EEXIST') throw e; tokenSecret = fs.readFileSync(TOKEN_KEY_FILE, 'utf8').trim(); }
  }
}
if (Buffer.byteLength(tokenSecret) < 32) throw new Error('PAGEHOUSE_TOKEN_SECRET must be at least 32 bytes');
try { fs.chmodSync(TOKEN_KEY_FILE, 0o600); } catch { /* best effort on non-POSIX filesystems */ }

const PAYSTACK_SECRET = () => process.env.PAYSTACK_SECRET_KEY || '';
// PAYSTACK_API_BASE points at the local simulator (scripts/paystack-sim.mjs) while Paystack is not set up. Only a
// localhost address is accepted, so a live server can never be redirected to another payment host.
const isLocalUrl = u => { try { const x = new URL(u); return x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };
const BASE = (() => {
  const v = (process.env.PAYSTACK_API_BASE || '').replace(/\/+$/, '');
  if (!v) return 'https://api.paystack.co';
  if (!isLocalUrl(v)) throw new Error('PAYSTACK_API_BASE may only point at a localhost simulator');
  return v;
})();
export const simulated = BASE !== 'https://api.paystack.co';
const stamp = () => new Date().toISOString();
const clean = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const emailOk = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const ref = () => 'PH-' + crypto.randomBytes(18).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

db.exec(`
  CREATE TABLE IF NOT EXISTS store_orders (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL CHECK (currency='GHS'),
    status TEXT NOT NULL CHECK (status IN ('pending','paid','failed')),
    checkout_url TEXT NOT NULL DEFAULT '',
    provider_access_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS store_order_items (
    order_id TEXT NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES catalog_books(id),
    title_snapshot TEXT NOT NULL,
    price_minor INTEGER NOT NULL,
    file_key_snapshot TEXT NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    download_limit INTEGER NOT NULL DEFAULT 5,
    expires_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(order_id, book_id)
  );
  CREATE TABLE IF NOT EXISTS store_download_sessions (
    order_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    token_expires_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(order_id, book_id, token_expires_at)
  );
  CREATE TABLE IF NOT EXISTS store_payment_events (
    event_hash TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS store_orders_email_created ON store_orders(email, created_at DESC);
  CREATE INDEX IF NOT EXISTS store_order_items_book ON store_order_items(book_id);
`);

for (const [column, type] of [['channel', "TEXT NOT NULL DEFAULT 'checkout'"], ['momo_phone', "TEXT NOT NULL DEFAULT ''"], ['momo_provider', "TEXT NOT NULL DEFAULT ''"], ['library_id', "TEXT NOT NULL DEFAULT ''"], ['client_hash', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!db.prepare('PRAGMA table_info(store_orders)').all().some(c => c.name === column)) db.exec(`ALTER TABLE store_orders ADD COLUMN ${column} ${type}`);
}
for (const [column, type] of [['source_id_snapshot', "TEXT NOT NULL DEFAULT ''"], ['source_ref_snapshot', "TEXT NOT NULL DEFAULT ''"], ['format_snapshot', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!db.prepare('PRAGMA table_info(store_order_items)').all().some(c => c.name === column)) db.exec(`ALTER TABLE store_order_items ADD COLUMN ${column} ${type}`);
}
db.exec("CREATE INDEX IF NOT EXISTS store_orders_library ON store_orders(library_id, created_at DESC)");

// Ghana mobile numbers: +233 / 0 followed by a two-digit network prefix and seven digits. The prefix names the
// network, which is also the Paystack mobile-money provider code (mtn, vod = Telecel, atl = AirtelTigo).
const NETWORKS = { mtn: ['24', '25', '53', '54', '55', '59'], vod: ['20', '50'], atl: ['26', '27', '56', '57'] };
export function parseGhanaPhone(input) {
  let d = String(input ?? '').replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('233')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^\d{9}$/.test(d)) return null;
  const provider = Object.keys(NETWORKS).find(k => NETWORKS[k].includes(d.slice(0, 2)));
  return provider ? { intl: '233' + d, local: '0' + d, provider } : null;
}

const selectProduct = db.prepare(`SELECT b.id,b.source_name,b.title,b.price_minor,b.currency,b.file_status,b.file_key,b.source_id,b.source_ref,b.format,
  b.status,b.rights_status,b.license,b.rights_scope,b.rights_evidence,c.size AS delivery_size
  FROM catalog_books b LEFT JOIN store_download_checks c ON c.book_id=b.id WHERE b.id=? AND b.status='listed'`);
const orderByRef = db.prepare('SELECT * FROM store_orders WHERE reference=?');
const itemsByOrder = db.prepare('SELECT * FROM store_order_items WHERE order_id=? ORDER BY title_snapshot');
const insertOrder = db.prepare('INSERT INTO store_orders(id,reference,idempotency_key,email,amount_minor,currency,status,created_at) VALUES(?,?,?,?,?,? ,\'pending\',?)');
const insertItem = db.prepare(`INSERT INTO store_order_items(order_id,book_id,title_snapshot,price_minor,file_key_snapshot,
  source_id_snapshot,source_ref_snapshot,format_snapshot) VALUES(?,?,?,?,?,?,?,?)`);

async function paystack(pathname, init = {}, fetchImpl = fetch) {
  const secret = PAYSTACK_SECRET();
  if (!secret) throw new Error('Paystack is not configured (set PAYSTACK_SECRET_KEY)');
  let response;
  try {
    response = await fetchImpl(BASE + pathname, {
      ...init,
      signal: init.signal || AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (e) { throw Object.assign(new Error('Could not reach Paystack'), { statusCode: 502, cause: e }); }
  let payload;
  try { payload = await response.json(); } catch { throw Object.assign(new Error('Paystack returned an unreadable response'), { statusCode: 502 }); }
  if (!response.ok || !payload.status) throw Object.assign(new Error(clean(payload.message || `Paystack request failed (${response.status})`, 300)), { statusCode: 502 });
  return payload.data;
}

function orderSnapshot(order) {
  return { reference: order.reference, amountMinor: order.amount_minor, currency: order.currency, status: order.status, createdAt: order.created_at, paidAt: order.paid_at || '' };
}

// The checks every checkout shares: buyer, books (priced, ready), amount, and the idempotency key. Returns either
// { previous } (the same request again) or what a new order needs.
async function prepareOrder({ bookIds, email: buyerEmail, idempotencyKey }) {
  const buyer = clean(buyerEmail, 254).toLowerCase();
  if (!emailOk(buyer)) throw new Error('A valid email address is required');
  if (!Array.isArray(bookIds) || !bookIds.length || bookIds.length > 10) throw new Error('Choose between 1 and 10 books');
  const key = clean(idempotencyKey, 100);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new Error('A 16–100 character idempotencyKey is required');
  const ids = [...new Set(bookIds.map(x => clean(x, 64)))];
  if (ids.length !== bookIds.length || ids.some(x => !/^[a-f0-9]{32}$/.test(x))) throw new Error('Book selection is invalid');
  let products = ids.map(id => selectProduct.get(id));
  if (products.some(x => !x)) throw new Error('A selected book is not available for sale');
  if (products.some(x => x.file_status === 'unavailable' || (!x.file_key && !delivery.isSupportedSource(x.source_id)))) {
    throw new Error('A selected book is not ready for delivery yet');
  }
  // Every book costs the store's one price (set in the admin panel); each item keeps the price it was bought at.
  const price = storePrice().priceMinor;
  for (const x of products) { x.price_minor = price; x.currency = 'GHS'; }
  const amount = products.reduce((n, x) => n + x.price_minor, 0);
  if (!Number.isSafeInteger(amount)) throw new Error('Order amount is invalid');
  const previous = db.prepare('SELECT * FROM store_orders WHERE idempotency_key=?').get(key);
  if (previous) {
    const priorIds = itemsByOrder.all(previous.id).map(x => x.book_id).sort();
    if (previous.email !== buyer || previous.amount_minor !== amount || priorIds.join(',') !== ids.slice().sort().join(','))
      throw Object.assign(new Error('This checkout key was already used for a different order'), { statusCode: 409 });
  }
  return { buyer, key, products, amount, previous };
}

function insertNewOrder({ key, buyer, amount, products }, extra = {}) {
  const id = crypto.randomUUID(), reference = ref(), createdAt = stamp();
  db.exec('BEGIN IMMEDIATE');
  try {
    insertOrder.run(id, reference, key, buyer, amount, 'GHS', createdAt);
    db.prepare('UPDATE store_orders SET channel=?,momo_phone=?,momo_provider=?,library_id=?,client_hash=? WHERE id=?')
      .run(extra.channel || 'checkout', extra.momoPhone || '', extra.momoProvider || '', extra.libraryId || '', extra.clientHash || '', id);
    for (const p of products) insertItem.run(id, p.id, p.title, p.price_minor, p.file_key, p.source_id, p.source_ref, p.format);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { id, reference };
}

export async function createCheckout(input, fetchImpl = fetch, ctx = {}) {
  const { buyer, key, products, amount, previous } = await prepareOrder(input || {});
  if (previous) {
    if (previous.status === 'paid') return getOrderForBuyer(previous.reference, buyer);
    if (previous.checkout_url) return { ...orderSnapshot(previous), authorizationUrl: previous.checkout_url, accessCode: previous.provider_access_code };
    throw Object.assign(new Error('Checkout initialization is already in progress for this request'), { statusCode: 409 });
  }
  const callbackUrl = process.env.PAGEHOUSE_CALLBACK_URL || '';
  if (callbackUrl) {
    let u; try { u = new URL(callbackUrl); } catch { throw new Error('PAGEHOUSE_CALLBACK_URL must be an absolute URL'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) throw new Error('PAGEHOUSE_CALLBACK_URL must use HTTPS');
  }
  const { id, reference } = insertNewOrder({ key, buyer, amount, products }, { libraryId: ctx.libraryId });

  try {
    const data = await paystack('/transaction/initialize', {
      method: 'POST', body: JSON.stringify({ email: buyer, amount, currency: 'GHS', reference,
        ...(callbackUrl ? { callback_url: clean(callbackUrl, 500) } : {}),
        metadata: { order_id: id, book_count: products.length }, }),
    }, fetchImpl);
    if (data.reference !== reference || !(/^https:\/\//i.test(data.authorization_url || '') || (simulated && isLocalUrl(data.authorization_url)))) throw new Error('Paystack checkout response did not match this order');
    db.prepare('UPDATE store_orders SET checkout_url=?,provider_access_code=? WHERE id=? AND status=\'pending\'')
      .run(data.authorization_url, clean(data.access_code, 100), id);
    return { ...orderSnapshot(orderByRef.get(reference)), authorizationUrl: data.authorization_url, accessCode: clean(data.access_code, 100) };
  } catch (e) {
    db.prepare("UPDATE store_orders SET status='failed' WHERE id=? AND status='pending'").run(id);
    throw e;
  }
}

// MoMo straight from the store (Paystack Charge API, https://paystack.com/docs/payments/payment-channels/): the
// customer gets an approval prompt on their phone and has 180 seconds to approve it with their PIN. Because the
// charge only succeeds on that phone, a paid MoMo order proves the number, which then opens the buyer's Library.
// The browser keeps checking /verify until Paystack says success (or the webhook marks it paid first).
export async function createMomoCharge(input, fetchImpl = fetch, ctx = {}) {
  const phone = parseGhanaPhone(input?.phone);
  if (!phone) throw new Error('Enter a Ghana mobile money number, for example 024 412 4521');
  const provider = ['mtn', 'vod', 'atl'].includes(input?.provider) ? input.provider : phone.provider;
  const prepared = await prepareOrder(input || {});
  if (prepared.previous) {
    const prev = prepared.previous;
    if (prev.channel !== 'momo' || prev.momo_phone !== phone.intl) throw Object.assign(new Error('This checkout key was already used for a different order'), { statusCode: 409 });
    if (prev.status === 'paid') return { ...orderSnapshot(prev), channel: 'momo' };
    if (prev.status === 'pending') return { ...orderSnapshot(prev), channel: 'momo', displayText: 'Approve the payment on your phone.' };
    throw new Error('This payment did not go through. Start again.');
  }
  const { id, reference } = insertNewOrder(prepared, { channel: 'momo', momoPhone: phone.intl, momoProvider: provider, libraryId: ctx.libraryId, clientHash: ctx.clientHash });
  try {
    const data = await paystack('/charge', {
      method: 'POST',
      body: JSON.stringify({ email: prepared.buyer, amount: prepared.amount, currency: 'GHS', reference,
        mobile_money: { phone: phone.local, provider }, metadata: { order_id: id, book_count: prepared.products.length } }),
    }, fetchImpl);
    if (data.reference && data.reference !== reference) throw new Error('Paystack charge response did not match this order');
    if (data.status === 'failed') throw new Error(clean(data.gateway_response || data.message || 'The payment was declined', 200));
    if (data.status === 'success') markPaid(await verifiedTransaction(reference, fetchImpl));
    const order = orderByRef.get(reference);
    return { ...orderSnapshot(order), channel: 'momo', displayText: clean(data.display_text || 'Approve the payment on your phone with your MoMo PIN.', 300) };
  } catch (e) {
    db.prepare("UPDATE store_orders SET status='failed' WHERE id=? AND status='pending'").run(id);
    throw e;
  }
}

async function verifiedTransaction(reference, fetchImpl = fetch) {
  const data = await paystack('/transaction/verify/' + encodeURIComponent(reference), { method: 'GET' }, fetchImpl);
  const order = orderByRef.get(reference);
  if (!order) throw new Error('Unknown order reference');
  if (!['pending','paid'].includes(order.status)) throw new Error('Order is not payable');
  // Still waiting for the customer (a MoMo prompt open on their phone): not an error, just not paid yet.
  if (data.reference === reference && ['pending', 'ongoing', 'processing', 'queued', 'pay_offline', 'send_otp'].includes(data.status))
    throw Object.assign(new Error('Waiting for approval on the phone'), { pending: true });
  if (data.reference === reference && ['failed', 'abandoned', 'reversed'].includes(data.status)) {
    db.prepare("UPDATE store_orders SET status='failed' WHERE id=? AND status='pending'").run(order.id);
    throw Object.assign(new Error(clean(data.gateway_response || 'The payment was not approved', 200)), { failed: true });
  }
  if (data.reference !== reference || data.status !== 'success' || Number(data.amount) !== order.amount_minor || String(data.currency).toUpperCase() !== order.currency)
    throw new Error('Payment verification did not match the order amount, currency and reference');
  return order;
}

function markPaid(order) {
  if (order.status === 'paid') return;
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const fresh = orderByRef.get(order.reference);
    if (!fresh) throw new Error('Unknown order reference');
    if (fresh.status !== 'paid') {
      db.prepare("UPDATE store_orders SET status='paid',paid_at=? WHERE id=? AND status='pending'").run(stamp(), fresh.id);
      db.prepare("UPDATE store_order_items SET expires_at=? WHERE order_id=?").run(expires, fresh.id);
      if (fresh.channel === 'momo') library.attachPaidMomoOrder(fresh);
      // The receipt carries the buyer's download links, so closing the tab after paying loses nothing. Queued in
      // this transaction: an order is never paid without its receipt, and a replayed webhook never sends two.
      const base = email.publicUrl();
      const items = itemsByOrder.all(fresh.id).map(i => ({ title: i.title_snapshot, amountMinor: i.price_minor,
        url: base ? base + '/api/store/download/' + issueToken(fresh.id, i.book_id, expires) : '' }));
      email.enqueue(email.orderReceipt(fresh, items));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function verifyCheckout(reference, fetchImpl = fetch) {
  const r = clean(reference, 100);
  if (!/^PH-[a-f0-9]{36}$/.test(r)) throw new Error('Invalid order reference');
  const order = orderByRef.get(r);
  if (!order) throw new Error('Order not found');
  if (order.status === 'failed') throw new Error('Order is not payable');
  if (order.status !== 'paid') {
    try { markPaid(await verifiedTransaction(r, fetchImpl)); }
    catch (e) { if (e.pending) return { ...orderSnapshot(orderByRef.get(r)), items: [] }; throw e; }
  }
  return getOrderForBuyer(r, order.email);
}

// Paystack signs webhooks two ways (https://paystack.com/docs/payments/webhooks/):
//   Paystack-Signature: t=<unix seconds>,v1=<key id>:<hex HMAC-SHA512 of "t.<raw body>" keyed with the whsec_ secret>
//     (several v1 values while a secret is being rotated; events older than 300 s are refused, so a captured
//     request cannot be replayed later)
//   x-paystack-signature: hex HMAC-SHA512 of the raw body keyed with the secret key (legacy, no timestamp)
// With PAYSTACK_WEBHOOK_SECRET set the timestamped signature is required; otherwise the legacy one is checked.
const WEBHOOK_TOLERANCE_S = 300;
const hexEqual = (a, b) => /^[a-f0-9]{128}$/.test(a) && /^[a-f0-9]{128}$/.test(b) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export function verifyWebhookSignature(rawBody, headers, nowMs = Date.now()) {
  const h = typeof headers === 'string' ? { legacy: headers } : (headers || {});
  const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET || '';
  if (webhookSecret) {
    const parts = String(h.modern || '').split(',').map(x => x.trim());
    const t = Number((parts.find(x => x.startsWith('t=')) || '').slice(2));
    const signatures = parts.filter(x => x.startsWith('v1=')).map(x => x.slice(3).split(':').pop().toLowerCase());
    if (!Number.isSafeInteger(t) || !signatures.length) return false;
    if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
    const expected = crypto.createHmac('sha512', webhookSecret).update(`${t}.`).update(rawBody).digest('hex');
    return signatures.some(sig => hexEqual(sig, expected));
  }
  const secret = PAYSTACK_SECRET();
  if (!secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hexEqual(String(h.legacy || '').trim().toLowerCase(), expected);
}

export async function handlePaystackWebhook(rawBody, signature, fetchImpl = fetch) {
  if (!PAYSTACK_SECRET() && !process.env.PAYSTACK_WEBHOOK_SECRET) throw new Error('Paystack is not configured');
  if (!verifyWebhookSignature(rawBody, signature)) throw Object.assign(new Error('Invalid Paystack signature'), { statusCode: 401 });
  let event;
  try { event = JSON.parse(rawBody); } catch { throw Object.assign(new Error('Invalid webhook JSON'), { statusCode: 400 }); }
  const reference = clean(event?.data?.reference, 100), eventType = clean(event?.event, 80);
  if (!reference || !eventType) throw Object.assign(new Error('Missing webhook event fields'), { statusCode: 400 });
  const eventHash = sha(rawBody);
  if (db.prepare('SELECT 1 FROM store_payment_events WHERE event_hash=?').get(eventHash)) return { accepted: true, duplicate: true };
  if (eventType === 'charge.success') {
    const verified = await verifiedTransaction(reference, fetchImpl);
    markPaid(verified);
  }
  // Persist only after successful processing, so provider/network failures can be retried by Paystack.
  db.prepare('INSERT OR IGNORE INTO store_payment_events(event_hash,reference,event_type,received_at) VALUES(?,?,?,?)').run(eventHash, reference, eventType, stamp());
  if (eventType !== 'charge.success') return { accepted: true, ignored: true };
  return { accepted: true, paid: true, reference };
}

function issueToken(orderId, bookId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ o: orderId, b: bookId, e: Date.parse(expiresAt) })).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

export function getOrderForBuyer(reference, email) {
  const order = orderByRef.get(clean(reference, 100));
  if (!order || order.email !== clean(email, 254).toLowerCase()) return null;
  const items = itemsByOrder.all(order.id).map(i => ({
    bookId: i.book_id, title: i.title_snapshot, amountMinor: i.price_minor,
    ...(order.status === 'paid' && i.expires_at && Date.parse(i.expires_at) > Date.now()
      ? { downloadUrl: '/api/store/download/' + issueToken(order.id, i.book_id, i.expires_at), downloadsRemaining: Math.max(0, i.download_limit - i.download_count) }
      : {}),
  }));
  return { ...orderSnapshot(order), items };
}

// Everything bought into a Library, newest first, with download links while they last.
export function libraryOrders(libraryId) {
  if (!library.libraryIdOk(libraryId)) return [];
  return db.prepare("SELECT * FROM store_orders WHERE library_id=? AND status='paid' ORDER BY paid_at DESC LIMIT 100").all(libraryId).map(order => ({
    ...orderSnapshot(order),
    items: itemsByOrder.all(order.id).map(i => {
      const session = i.expires_at ? db.prepare(`SELECT started_at,completed_at FROM store_download_sessions
        WHERE order_id=? AND book_id=? AND token_expires_at=?`).get(order.id, i.book_id, i.expires_at) : null;
      const canResume = session && !session.completed_at && Date.now() - Date.parse(session.started_at) <= 60 * 60 * 1000;
      const live = i.expires_at && Date.parse(i.expires_at) > Date.now() && (i.download_count < i.download_limit || canResume);
      return { bookId: i.book_id, title: i.title_snapshot, amountMinor: i.price_minor, expiresAt: i.expires_at,
        downloadsRemaining: Math.max(0, i.download_limit - i.download_count),
        ...(live ? { downloadUrl: '/api/store/download/' + issueToken(order.id, i.book_id, i.expires_at) } : {}) };
    }),
  }));
}

// After /verify: the Library this browser should now be in. Only the browser that started the MoMo checkout
// (its ph_co secret) gets it, never someone who merely learned the order reference and email.
export function libraryForVerifiedOrder(reference, clientSecretHash) {
  const order = orderByRef.get(clean(reference, 100));
  if (!order || order.status !== 'paid' || order.channel !== 'momo' || !order.library_id || !order.client_hash || !clientSecretHash) return '';
  if (!/^[a-f0-9]{64}$/.test(clientSecretHash) || !/^[a-f0-9]{64}$/.test(order.client_hash)) return '';
  return crypto.timingSafeEqual(Buffer.from(order.client_hash, 'hex'), Buffer.from(clientSecretHash, 'hex')) ? order.library_id : '';
}

function decodeDownloadToken(token) {
  const [payload, sig, extra] = String(token || '').split('.');
  if (!payload || !sig || extra || payload.length > 1000) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  return data && typeof data.o === 'string' && typeof data.b === 'string' && Number.isFinite(data.e) && data.e > Date.now()
    ? data : null;
}

export function getDownloadGrant(token) {
  const data = decodeDownloadToken(token);
  if (!data) return null;
  const row = db.prepare(`SELECT i.file_key_snapshot,i.source_id_snapshot,i.source_ref_snapshot,i.format_snapshot,
      i.download_count,i.download_limit,i.expires_at,o.status,b.title,b.status AS book_status,b.rights_status,
      b.license,b.rights_scope,b.rights_evidence,b.source_id,b.source_ref,b.format,b.file_status
    FROM store_order_items i JOIN store_orders o ON o.id=i.order_id JOIN catalog_books b ON b.id=i.book_id
    WHERE i.order_id=? AND i.book_id=?`).get(data.o, data.b);
  if (!row || row.status !== 'paid' || Date.parse(row.expires_at) !== data.e || row.book_status !== 'listed') return null;
  const expiresAt = new Date(data.e).toISOString();
  const session = db.prepare(`SELECT started_at,completed_at FROM store_download_sessions
    WHERE order_id=? AND book_id=? AND token_expires_at=?`).get(data.o, data.b, expiresAt);
  const canResume = session && !session.completed_at && Date.now() - Date.parse(session.started_at) <= 60 * 60 * 1000;
  if (row.file_status === 'unavailable' && !canResume) return null;
  if (row.download_count >= row.download_limit && !canResume) return null;
  return {
    orderId: data.o, bookId: data.b, expiresAt, title: row.title, fileKey: row.file_key_snapshot,
    sourceId: row.source_id_snapshot || row.source_id, sourceRef: row.source_ref_snapshot || row.source_ref,
    format: row.format_snapshot || row.format,
  };
}

export function reserveDownload(grant) {
  const expiresAt = grant?.expiresAt;
  if (!grant || !/^[a-f0-9]{32}$/.test(grant.bookId) || !/^[A-Za-z0-9-]{36}$/.test(grant.orderId)
      || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`SELECT i.download_count,i.download_limit,i.expires_at,o.status,b.status AS book_status,
      b.rights_status,b.license,b.rights_scope,b.rights_evidence,b.source_id FROM store_order_items i
      JOIN store_orders o ON o.id=i.order_id JOIN catalog_books b ON b.id=i.book_id
      WHERE i.order_id=? AND i.book_id=?`).get(grant.orderId, grant.bookId);
    if (!row || row.status !== 'paid' || row.expires_at !== expiresAt || row.book_status !== 'listed') {
      db.exec('ROLLBACK');
      return false;
    }
    const session = db.prepare(`SELECT started_at,completed_at FROM store_download_sessions
      WHERE order_id=? AND book_id=? AND token_expires_at=?`).get(grant.orderId, grant.bookId, expiresAt);
    const canResume = session && !session.completed_at && Date.now() - Date.parse(session.started_at) <= 60 * 60 * 1000;
    if (!canResume) {
      const updated = db.prepare(`UPDATE store_order_items SET download_count=download_count+1
        WHERE order_id=? AND book_id=? AND download_count<download_limit AND expires_at=?`)
        .run(grant.orderId, grant.bookId, expiresAt);
      if (updated.changes !== 1) {
        db.exec('ROLLBACK');
        return false;
      }
      db.prepare(`INSERT INTO store_download_sessions(order_id,book_id,token_expires_at,started_at,completed_at)
        VALUES(?,?,?,?, '') ON CONFLICT(order_id,book_id,token_expires_at) DO UPDATE SET
        started_at=excluded.started_at,completed_at=''`).run(grant.orderId, grant.bookId, expiresAt, stamp());
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function completeRemoteDownload(grant) {
  db.prepare(`UPDATE store_download_sessions SET completed_at=? WHERE order_id=? AND book_id=? AND token_expires_at=?`)
    .run(stamp(), grant.orderId, grant.bookId, grant.expiresAt);
}

export function consumeDownloadToken(token) {
  const [payload, sig, extra] = String(token || '').split('.');
  if (!payload || !sig || extra || payload.length > 1000) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data.o !== 'string' || typeof data.b !== 'string' || !Number.isFinite(data.e) || data.e <= Date.now()) return null;
  const file = db.prepare(`SELECT i.file_key_snapshot,i.download_count,i.download_limit,i.expires_at,o.status
    FROM store_order_items i JOIN store_orders o ON o.id=i.order_id WHERE i.order_id=? AND i.book_id=?`).get(data.o, data.b);
  if (!file || file.status !== 'paid' || Date.parse(file.expires_at) !== data.e || file.download_count >= file.download_limit) return null;
  const root = fs.realpathSync(FILES_DIR);
  const candidate = path.resolve(root, file.file_key_snapshot);
  if (!candidate.startsWith(root + path.sep)) return null;
  let actual;
  try { actual = fs.realpathSync(candidate); } catch { return null; }
  if (!actual.startsWith(root + path.sep) || !fs.statSync(actual).isFile()) return null;
  const result = db.prepare('UPDATE store_order_items SET download_count=download_count+1 WHERE order_id=? AND book_id=? AND download_count<download_limit AND expires_at=?')
    .run(data.o, data.b, new Date(data.e).toISOString());
  if (result.changes !== 1) return null;
  return { path: actual, filename: path.basename(actual), contentType: 'application/pdf' };
}
