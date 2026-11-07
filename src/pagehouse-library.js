// A shopper's Library without an account: books bought and requests made, opened with a passkey (Face ID,
// fingerprint or the device PIN) and nothing else. No password, no codes, no SMS.
//   - A Library is created with its first passkey, or by the first MoMo payment.
//   - Paying with MoMo through the Charge API proves the paying number (the customer approves with their PIN).
//     That number is attached to the Library, so paying with it on a new phone brings the Library back there.
//   - This device stays in its Library through a signed, httpOnly cookie for 180 days.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { db } from './pagehouse.js';
import * as webauthn from './webauthn.js';

const SESSION_DAYS = 180;
const CHALLENGE_MS = 5 * 60 * 1000;
const COOKIE = 'ph_lib';
const now = () => new Date().toISOString();

db.exec(`
  CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY,
    momo_phone TEXT UNIQUE,
    momo_provider TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS library_passkeys (
    credential_id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    alg INTEGER NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS library_passkeys_library ON library_passkeys(library_id);
`);

// The cookie signing key: PAGEHOUSE_LIBRARY_SECRET, else a random key kept in the data folder.
const KEY_FILE = path.join(DATA, 'pagehouse-library.key');
let secret = process.env.PAGEHOUSE_LIBRARY_SECRET || '';
if (!secret) {
  try { secret = fs.readFileSync(KEY_FILE, 'utf8').trim(); }
  catch {
    const generated = crypto.randomBytes(32).toString('base64url');
    try { fs.writeFileSync(KEY_FILE, generated, { mode: 0o600, flag: 'wx' }); secret = generated; }
    catch (e) { if (e.code !== 'EEXIST') throw e; secret = fs.readFileSync(KEY_FILE, 'utf8').trim(); }
  }
}
if (Buffer.byteLength(secret) < 32) throw new Error('PAGEHOUSE_LIBRARY_SECRET must be at least 32 bytes');

const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const byId = db.prepare('SELECT * FROM libraries WHERE id=?');
const libraryIdOk = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);

// ── Session cookie ───────────────────────────────────────────────────────────
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionLibrary(req) {
  const [id, exp, sig] = readCookie(req, COOKIE).split('.');
  if (!libraryIdOk(id) || !/^\d{13}$/.test(exp || '') || Number(exp) < Date.now()) return null;
  const expected = sign(`${id}.${exp}`);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return byId.get(id) || null;
}

export function sessionCookie(libraryId, secure) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${COOKIE}=${libraryId}.${exp}.${sign(`${libraryId}.${exp}`)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
export const clearSessionCookie = secure => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

// A random per-browser secret binding a MoMo checkout to the browser that started it (see restoreFromOrder).
export function checkoutSecret(req) { const v = readCookie(req, 'ph_co'); return /^[A-Za-z0-9_-]{32,64}$/.test(v) ? v : ''; }
export const newCheckoutSecretCookie = secure => {
  const v = crypto.randomBytes(24).toString('base64url');
  return { value: v, cookie: `ph_co=${v}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` };
};
export const hashSecret = v => v ? crypto.createHash('sha256').update(v).digest('hex') : '';

// ── Passkeys ─────────────────────────────────────────────────────────────────
const challenges = new Map(); // id -> { kind, challenge, rpId, origin, libraryId, until }
function newChallenge(entry) {
  const t = Date.now();
  for (const [k, v] of challenges) if (v.until < t) challenges.delete(k);
  if (challenges.size > 5000) throw Object.assign(new Error('Too many sign-ins in progress. Try again shortly.'), { statusCode: 429 });
  const id = crypto.randomBytes(16).toString('hex'), challenge = webauthn.b64u(crypto.randomBytes(32));
  challenges.set(id, { ...entry, challenge, until: t + CHALLENGE_MS });
  return { id, challenge };
}
function takeChallenge(id, kind) {
  const entry = typeof id === 'string' ? challenges.get(id) : null;
  if (entry) challenges.delete(id); // single use, whatever happens next
  if (!entry || entry.kind !== kind || entry.until < Date.now()) throw Object.assign(new Error('This sign-in expired. Try again.'), { statusCode: 400 });
  return entry;
}

// rp: { id: the host name, origin: "https://host[:port]" }. Passkeys need HTTPS or localhost, and a host name
// (browsers refuse IP addresses).
export function registrationOptions(rp, current) {
  const libraryId = current?.id || crypto.randomUUID();
  const { id, challenge } = newChallenge({ kind: 'create', rpId: rp.id, origin: rp.origin, libraryId });
  const exclude = current ? db.prepare('SELECT credential_id,transports FROM library_passkeys WHERE library_id=?').all(current.id)
    .map(k => ({ type: 'public-key', id: k.credential_id, transports: JSON.parse(k.transports) })) : [];
  return {
    challengeId: id,
    publicKey: {
      challenge, rp: { id: rp.id, name: 'Pagehouse' },
      user: { id: webauthn.b64u(Buffer.from(libraryId)), name: 'Pagehouse Library', displayName: 'Pagehouse Library' },
      pubKeyCredParams: [{ type: 'public-key', alg: webauthn.ALG_ES256 }, { type: 'public-key', alg: webauthn.ALG_EDDSA }, { type: 'public-key', alg: webauthn.ALG_RS256 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: CHALLENGE_MS, excludeCredentials: exclude,
    },
  };
}

export function finishRegistration(challengeId, credential) {
  const entry = takeChallenge(challengeId, 'create');
  const key = webauthn.verifyRegistration(credential, entry);
  const transports = Array.isArray(credential?.response?.transports)
    ? credential.response.transports.filter(t => typeof t === 'string' && /^[a-z-]{2,20}$/.test(t)).slice(0, 6) : [];
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM library_passkeys WHERE credential_id=?').get(key.credentialId)) throw Object.assign(new Error('This passkey is already saved'), { statusCode: 409 });
    db.prepare('INSERT OR IGNORE INTO libraries(id,created_at,updated_at) VALUES(?,?,?)').run(entry.libraryId, stamp, stamp);
    db.prepare(`INSERT INTO library_passkeys(credential_id,library_id,public_key,alg,sign_count,transports,backed_up,created_at,last_used_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(key.credentialId, entry.libraryId, key.publicKey, key.alg, key.signCount, JSON.stringify(transports), key.backedUp ? 1 : 0, stamp, stamp);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return byId.get(entry.libraryId);
}

export function loginOptions(rp) {
  const { id, challenge } = newChallenge({ kind: 'get', rpId: rp.id, origin: rp.origin });
  // No allowCredentials: the phone offers whichever Pagehouse passkey it holds (discoverable credentials).
  return { challengeId: id, publicKey: { challenge, rpId: rp.id, userVerification: 'required', timeout: CHALLENGE_MS } };
}

export function finishLogin(challengeId, credential) {
  const entry = takeChallenge(challengeId, 'get');
  const credentialId = typeof credential?.id === 'string' ? credential.id : '';
  const stored = db.prepare('SELECT * FROM library_passkeys WHERE credential_id=?').get(credentialId);
  if (!stored) throw Object.assign(new Error('This passkey is not saved with Pagehouse'), { statusCode: 401 });
  const { signCount } = webauthn.verifyAssertion(credential, { ...entry, publicKey: stored.public_key, alg: stored.alg, signCount: stored.sign_count });
  // The credential id and its verified signature decide the Library. The user handle the phone sends back was
  // fixed when the passkey was made, so after a merge it still names the Library that was merged away.
  db.prepare('UPDATE library_passkeys SET sign_count=?,last_used_at=? WHERE credential_id=?').run(signCount, now(), credentialId);
  return byId.get(stored.library_id);
}

// ── MoMo link ────────────────────────────────────────────────────────────────
const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Move everything of `fromId` into `toId` (the same person proved both). Runs inside the caller's transaction.
function merge(fromId, toId) {
  if (!fromId || fromId === toId) return;
  db.prepare('UPDATE library_passkeys SET library_id=? WHERE library_id=?').run(toId, fromId);
  if (hasTable('book_requests')) db.prepare('UPDATE book_requests SET library_id=? WHERE library_id=?').run(toId, fromId);
  if (hasTable('store_orders')) db.prepare('UPDATE store_orders SET library_id=? WHERE library_id=?').run(toId, fromId);
  db.prepare('DELETE FROM libraries WHERE id=?').run(fromId);
}

// Called when a MoMo order becomes paid, inside that transaction. The number approved the payment with its PIN,
// so it is proof of ownership: the order goes into the Library of that number (created if new), and a Library
// the buyer already had on this device joins it. Returns the Library id the order now belongs to.
export function attachPaidMomoOrder(order) {
  if (!order.momo_phone) return order.library_id || '';
  const stamp = now();
  let owner = db.prepare('SELECT * FROM libraries WHERE momo_phone=?').get(order.momo_phone);
  if (!owner && order.library_id && byId.get(order.library_id)) {
    db.prepare('UPDATE libraries SET momo_phone=?,momo_provider=?,updated_at=? WHERE id=? AND momo_phone IS NULL').run(order.momo_phone, order.momo_provider || '', stamp, order.library_id);
    owner = byId.get(order.library_id);
    if (owner.momo_phone !== order.momo_phone) owner = null; // already linked to another number: keep that one
  }
  if (!owner) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO libraries(id,momo_phone,momo_provider,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, order.momo_phone, order.momo_provider || '', stamp, stamp);
    owner = byId.get(id);
  }
  if (order.library_id && order.library_id !== owner.id && byId.get(order.library_id)) {
    const other = byId.get(order.library_id);
    if (!other.momo_phone) merge(other.id, owner.id); // a Library tied to a different number stays separate
  }
  db.prepare('UPDATE store_orders SET library_id=? WHERE id=?').run(owner.id, order.id);
  return owner.id;
}

export function summary(library) {
  const keys = db.prepare('SELECT COUNT(*) AS n FROM library_passkeys WHERE library_id=?').get(library.id).n;
  const phone = library.momo_phone || '';
  return {
    id: library.id, passkeys: keys,
    phone: phone ? `0${phone.slice(3, 5)} ••• ${phone.slice(-4)}` : '',
    network: { mtn: 'MTN', vod: 'Telecel', atl: 'AirtelTigo' }[library.momo_provider] || '',
  };
}

export { libraryIdOk };
