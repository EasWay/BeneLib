// Pagehouse checkout, verified Paystack payments, and buyer-specific download entitlements.
// No card data is handled here. Checkout initialization only creates a provider checkout session;
// payment is complete only after the signed webhook AND server-side transaction verification succeed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { db } from './pagehouse.js';

const FILES_DIR = path.resolve(process.env.PAGEHOUSE_FILES_DIR || path.join(DATA, 'pagehouse-files'));
fs.mkdirSync(FILES_DIR, { recursive: true });
const TOKEN_KEY_FILE = path.join(DATA, 'pagehouse-token.key');
fs.mkdirSync(DATA, { recursive: true });
let tokenSecret = process.env.PAGEHOUSE_TOKEN_SECRET || '';
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
const BASE = 'https://api.paystack.co';
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
  CREATE TABLE IF NOT EXISTS store_payment_events (
    event_hash TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS store_orders_email_created ON store_orders(email, created_at DESC);
  CREATE INDEX IF NOT EXISTS store_order_items_book ON store_order_items(book_id);
`);

const selectProduct = db.prepare("SELECT id,title,price_minor,currency,file_status,file_key FROM catalog_books WHERE id=? AND status='listed' AND rights_status='approved'");
const orderByRef = db.prepare('SELECT * FROM store_orders WHERE reference=?');
const itemsByOrder = db.prepare('SELECT * FROM store_order_items WHERE order_id=? ORDER BY title_snapshot');
const insertOrder = db.prepare('INSERT INTO store_orders(id,reference,idempotency_key,email,amount_minor,currency,status,created_at) VALUES(?,?,?,?,?,? ,\'pending\',?)');
const insertItem = db.prepare('INSERT INTO store_order_items(order_id,book_id,title_snapshot,price_minor,file_key_snapshot) VALUES(?,?,?,?,?)');

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

export async function createCheckout({ bookIds, email, idempotencyKey }, fetchImpl = fetch) {
  const buyer = clean(email, 254).toLowerCase();
  if (!emailOk(buyer)) throw new Error('A valid email address is required');
  if (!Array.isArray(bookIds) || !bookIds.length || bookIds.length > 10) throw new Error('Choose between 1 and 10 books');
  const key = clean(idempotencyKey, 100);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new Error('A 16–100 character idempotencyKey is required');
  const ids = [...new Set(bookIds.map(x => clean(x, 64)))];
  if (ids.length !== bookIds.length || ids.some(x => !/^[a-f0-9]{32}$/.test(x))) throw new Error('Book selection is invalid');
  const products = ids.map(id => selectProduct.get(id));
  if (products.some(x => !x)) throw new Error('A selected book is not available for sale');
  if (products.some(x => x.file_status !== 'ready' || !x.file_key)) throw new Error('A selected book is not ready for delivery yet');
  if (products.some(x => x.currency !== 'GHS' || !Number.isSafeInteger(x.price_minor) || x.price_minor <= 0)) throw new Error('A selected book has no valid GHS price');
  const amount = products.reduce((n, x) => n + x.price_minor, 0);
  if (!Number.isSafeInteger(amount)) throw new Error('Order amount is invalid');
  const previous = db.prepare('SELECT * FROM store_orders WHERE idempotency_key=?').get(key);
  if (previous) {
    const priorIds = itemsByOrder.all(previous.id).map(x => x.book_id).sort();
    if (previous.email !== buyer || previous.amount_minor !== amount || priorIds.join(',') !== ids.slice().sort().join(','))
      throw Object.assign(new Error('This checkout key was already used for a different order'), { statusCode: 409 });
    if (previous.status === 'paid') return getOrderForBuyer(previous.reference, buyer);
    if (previous.checkout_url) return { ...orderSnapshot(previous), authorizationUrl: previous.checkout_url, accessCode: previous.provider_access_code };
    throw Object.assign(new Error('Checkout initialization is already in progress for this request'), { statusCode: 409 });
  }
  const callbackUrl = process.env.PAGEHOUSE_CALLBACK_URL || '';
  if (callbackUrl) {
    let u; try { u = new URL(callbackUrl); } catch { throw new Error('PAGEHOUSE_CALLBACK_URL must be an absolute URL'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) throw new Error('PAGEHOUSE_CALLBACK_URL must use HTTPS');
  }
  const id = crypto.randomUUID(), reference = ref(), createdAt = stamp();
  db.exec('BEGIN IMMEDIATE');
  try {
    insertOrder.run(id, reference, key, buyer, amount, 'GHS', createdAt);
    for (const p of products) insertItem.run(id, p.id, p.title, p.price_minor, p.file_key);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  try {
    const data = await paystack('/transaction/initialize', {
      method: 'POST', body: JSON.stringify({ email: buyer, amount, currency: 'GHS', reference,
        ...(callbackUrl ? { callback_url: clean(callbackUrl, 500) } : {}),
        metadata: { order_id: id, book_count: products.length }, }),
    }, fetchImpl);
    if (data.reference !== reference || !/^https:\/\//i.test(data.authorization_url || '')) throw new Error('Paystack checkout response did not match this order');
    db.prepare('UPDATE store_orders SET checkout_url=?,provider_access_code=? WHERE id=? AND status=\'pending\'')
      .run(data.authorization_url, clean(data.access_code, 100), id);
    return { ...orderSnapshot(orderByRef.get(reference)), authorizationUrl: data.authorization_url, accessCode: clean(data.access_code, 100) };
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
  if (order.status !== 'paid') markPaid(await verifiedTransaction(r, fetchImpl));
  return getOrderForBuyer(r, order.email);
}

export async function handlePaystackWebhook(rawBody, signature, fetchImpl = fetch) {
  const secret = PAYSTACK_SECRET();
  if (!secret) throw new Error('Paystack is not configured');
  const supplied = String(signature || '').trim().toLowerCase();
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  if (!/^[a-f0-9]{128}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex')))
    throw Object.assign(new Error('Invalid Paystack signature'), { statusCode: 401 });
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
