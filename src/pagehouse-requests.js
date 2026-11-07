// Pagehouse book requests: a customer asks for a title the catalogue does not have yet.
// Lifecycle (see Pagehouse-System-Architecture-Revised.html, "Request lifecycle"):
//   open ──(a published book matches)──▶ matched ──(requester buys it)──▶ fulfilled
//   open ──(30 days, no match)──▶ expired        matched ──(14 days, no purchase)──▶ closed
// Matching normalises title and author (lowercase, strip articles and punctuation, drop accents) and accepts a
// title trigram similarity of 0.8 or higher together with an exact author surname match.
// Closed and expired requests are purged 90 days after they last changed.
import crypto from 'node:crypto';
import { db, storePrice } from './pagehouse.js';
import * as mail from './pagehouse-email.js';

export const OPEN_PER_EMAIL = 3;
export const OPEN_DAYS = 30;
export const MATCHED_DAYS = 14;
export const PURGE_DAYS = 90;
export const TITLE_SIMILARITY = 0.8;
const DAY = 24 * 60 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS book_requests (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    isbn TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    title_key TEXT NOT NULL,
    surname_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','fulfilled','closed','expired')),
    matched_book_id TEXT REFERENCES catalog_books(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    matched_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS book_requests_status ON book_requests(status, created_at);
  CREATE INDEX IF NOT EXISTS book_requests_email ON book_requests(email, status);
`);
if (!db.prepare('PRAGMA table_info(book_requests)').all().some(c => c.name === 'library_id')) {
  db.exec("ALTER TABLE book_requests ADD COLUMN library_id TEXT NOT NULL DEFAULT ''");
}
db.exec('CREATE INDEX IF NOT EXISTS book_requests_library ON book_requests(library_id, created_at DESC)');

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, n);
const emailOk = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const iso = ms => new Date(ms).toISOString();

// Lowercase, transliterate accents, strip punctuation and leading/inner articles.
export function normalizeTitle(value) {
  return String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ').filter(word => word && !['the', 'a', 'an'].includes(word)).join(' ');
}

// Surname of one written name: "Herbert, Frank" → herbert, "Frank Herbert" → herbert.
function surnameOf(name) {
  const raw = String(name || '').trim();
  const part = raw.includes(',') ? raw.split(',')[0] : raw;
  const words = normalizeTitle(part).split(' ').filter(w => w && !/^(jr|sr|ii|iii|iv|phd|md|dr)$/.test(w));
  return words.at(-1) || '';
}

// Catalogue author fields list several people separated by commas, semicolons, "&" or "and"
// ("Peter L. Berger, Thomas Luckmann"). A lone "Surname, Given" pair cannot be told apart from two people,
// so every piece counts as a candidate surname.
export function catalogSurnames(authors) {
  const out = new Set();
  for (const person of String(authors || '').split(/\s*(?:;|&|\band\b)\s*/i)) {
    for (const piece of person.split(',')) { const s = surnameOf(piece); if (s) out.add(s); }
    const whole = surnameOf(person.replace(/,.*$/, '')); if (whole) out.add(whole);
  }
  return out;
}

function trigrams(value) {
  const out = new Set();
  for (const word of value.split(' ').filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

// pg_trgm-style similarity: shared trigrams over all distinct trigrams.
export function titleSimilarity(a, b) {
  const x = trigrams(normalizeTitle(a)), y = trigrams(normalizeTitle(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

// Catalogue titles often carry a subtitle or edition note ("Dune (Deluxe Edition)", "Walden: or, Life in the
// Woods"). A request for the main title should still match, so the title before ':' or '(' is compared too.
function bestTitleScore(requestTitle, bookTitle) {
  const main = String(bookTitle || '').split(/\s*[:(\[]/)[0];
  return Math.max(titleSimilarity(requestTitle, bookTitle), main ? titleSimilarity(requestTitle, main) : 0);
}

const findCandidates = db.prepare(`SELECT b.id,b.title,b.authors,b.price_minor,b.currency,b.file_status
  FROM catalog_books_fts f JOIN catalog_books b ON b.id=f.book_id
  WHERE catalog_books_fts MATCH ? AND b.status='listed'
  ORDER BY bm25(catalog_books_fts) LIMIT 60`);

// The best published book for a title and surname, or null.
export function findMatch(title, surname) {
  const titleKey = normalizeTitle(title);
  if (!titleKey || !surname) return null;
  // Narrow with FTS: the author's surname must appear, plus any title word. Each token is quoted so user text
  // is never read as FTS syntax.
  const quote = t => `"${t.replaceAll('"', '""')}"`;
  const words = [...new Set(titleKey.split(' ').filter(w => w.length > 1))].slice(0, 8);
  if (!words.length) words.push(...titleKey.split(' ').slice(0, 1));
  const match = `authors : ${quote(surname)} AND (${words.map(w => `title : ${quote(w)}`).join(' OR ')})`;
  let best = null;
  for (const row of findCandidates.all(match)) {
    if (!catalogSurnames(row.authors).has(surname)) continue;
    const score = bestTitleScore(title, row.title);
    if (score >= TITLE_SIMILARITY && (!best || score > best.score)) best = { ...row, score };
  }
  return best;
}

function publicView(row) {
  if (!row) return null;
  const book = row.matched_book_id
    ? db.prepare("SELECT id,title,authors,price_minor,currency,file_status FROM catalog_books WHERE id=? AND status='listed'").get(row.matched_book_id)
    : null;
  return {
    reference: row.reference, title: row.title, author: row.author, isbn: row.isbn, status: row.status,
    createdAt: row.created_at, expiresAt: row.expires_at, matchedAt: row.matched_at || '',
    ...(book ? { book: { id: book.id, title: book.title, authors: book.authors, priceMinor: storePrice().priceMinor, currency: 'GHS', fileStatus: book.file_status } } : {}),
  };
}

const byReference = db.prepare('SELECT * FROM book_requests WHERE reference=?');
const byId = db.prepare('SELECT * FROM book_requests WHERE id=?');
const setMatched = db.prepare("UPDATE book_requests SET status='matched',matched_book_id=?,matched_at=?,updated_at=?,expires_at=? WHERE id=? AND status='open'");

// Mark a request matched and queue the customer's "found it" email in the same step. Runs inside a transaction.
function markMatched(id, hit, nowMs) {
  const stamp = iso(nowMs);
  if (!setMatched.run(hit.id, stamp, stamp, iso(nowMs + MATCHED_DAYS * DAY), id).changes) return false;
  mail.enqueue(mail.requestMatched(byId.get(id), hit));
  return true;
}

export function createRequest(input = {}, nowMs = Date.now(), { libraryId = '' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request must be an object');
  // Hidden "website" field: people never fill it in, form-filling bots usually do. Pretend it worked.
  if (clean(input.website, 200)) return { reference: 'RQ-' + crypto.randomBytes(12).toString('hex'), status: 'open' };
  const title = clean(input.title, 300), author = clean(input.author, 200);
  const isbn = clean(input.isbn, 40).replace(/[^0-9Xx-]/g, '').toUpperCase();
  const name = clean(input.name, 120), email = clean(input.email, 254).toLowerCase();
  if (!title || !normalizeTitle(title)) throw new Error('Enter the book title');
  const surname = surnameOf(author);
  if (!surname) throw new Error("Enter the author's name");
  if (!name) throw new Error('Enter your name');
  if (!emailOk(email)) throw new Error('Enter a valid email address');
  const titleKey = normalizeTitle(title);
  const stamp = iso(nowMs);

  db.exec('BEGIN IMMEDIATE');
  try {
    // The same person asking for the same book again gets their existing request back.
    const same = db.prepare("SELECT * FROM book_requests WHERE email=? AND title_key=? AND surname_key=? AND status IN ('open','matched')").get(email, titleKey, surname);
    if (same) {
      if (libraryId && !same.library_id && /^[0-9a-f-]{36}$/.test(libraryId)) db.prepare('UPDATE book_requests SET library_id=? WHERE id=?').run(libraryId, same.id);
      db.exec('COMMIT'); return { ...publicView(same), duplicate: true };
    }
    const openCount = db.prepare("SELECT COUNT(*) AS n FROM book_requests WHERE email=? AND status='open'").get(email).n;
    if (openCount >= OPEN_PER_EMAIL) {
      throw Object.assign(new Error(`You already have ${OPEN_PER_EMAIL} open requests. You can ask for more once one is found or expires.`), { statusCode: 429 });
    }
    const id = crypto.randomUUID(), reference = 'RQ-' + crypto.randomBytes(12).toString('hex');
    db.prepare(`INSERT INTO book_requests(id,reference,title,author,isbn,name,email,title_key,surname_key,status,created_at,updated_at,expires_at,library_id)
      VALUES(?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`).run(id, reference, title, author, isbn, name, email, titleKey, surname, stamp, stamp, iso(nowMs + OPEN_DAYS * DAY), /^[0-9a-f-]{36}$/.test(libraryId) ? libraryId : '');
    // It may already be on the shelves under a slightly different title.
    const hit = findMatch(title, surname);
    // Already on the shelves: the "found it" email replaces the "we're looking" one.
    if (!(hit && markMatched(id, hit, nowMs))) mail.enqueue(mail.requestReceived(byId.get(id)));
    const owner = mail.emailConfig().owner;
    if (owner) mail.enqueue(mail.ownerNewRequest(byId.get(id), owner));
    db.exec('COMMIT');
    return publicView(byReference.get(reference));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Status for the person who asked: the reference alone is not enough, the email must match too.
export function getRequestForRequester(reference, email) {
  const row = byReference.get(clean(reference, 40));
  if (!row || row.email !== clean(email, 254).toLowerCase()) return null;
  return publicView(row);
}

// One pass of the request job: match open requests, mark purchases, expire, close and purge.
export function sweepRequests(nowMs = Date.now()) {
  const stamp = iso(nowMs);
  const counts = { matched: 0, fulfilled: 0, expired: 0, closed: 0, purged: 0 };
  // A matched book that was later withdrawn sends its request back to open, keeping the original deadline.
  const lost = db.prepare(`UPDATE book_requests SET status='open',matched_book_id=NULL,matched_at='',updated_at=?,
      expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+${OPEN_DAYS} days')
    WHERE status='matched' AND (matched_book_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM catalog_books b WHERE b.id=matched_book_id AND b.status='listed'))`).run(stamp);
  counts.reopened = Number(lost.changes);
  const hasOrders = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_orders'").get();
  if (hasOrders) counts.fulfilled = Number(db.prepare(`UPDATE book_requests SET status='fulfilled',updated_at=?
    WHERE status='matched' AND EXISTS (SELECT 1 FROM store_orders o JOIN store_order_items i ON i.order_id=o.id
      WHERE o.status='paid' AND o.email=book_requests.email AND i.book_id=book_requests.matched_book_id)`).run(stamp).changes);
  // Matching and expiry each change a request and queue its email together, one transaction per request.
  const inTransaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  for (const row of db.prepare("SELECT id,title,surname_key FROM book_requests WHERE status='open' AND expires_at>? ORDER BY created_at").all(stamp)) {
    const hit = findMatch(row.title, row.surname_key);
    if (hit && inTransaction(() => markMatched(row.id, hit, nowMs))) counts.matched++;
  }
  const expire = db.prepare("UPDATE book_requests SET status='expired',updated_at=? WHERE id=? AND status='open'");
  for (const row of db.prepare("SELECT id FROM book_requests WHERE status='open' AND expires_at<=?").all(stamp)) {
    if (inTransaction(() => { if (!expire.run(stamp, row.id).changes) return false; mail.enqueue(mail.requestExpired(byId.get(row.id))); return true; })) counts.expired++;
  }
  counts.closed = Number(db.prepare("UPDATE book_requests SET status='closed',updated_at=? WHERE status='matched' AND expires_at<=?").run(stamp, stamp).changes);
  counts.purged = Number(db.prepare("DELETE FROM book_requests WHERE status IN ('closed','expired') AND updated_at<=?").run(iso(nowMs - PURGE_DAYS * DAY)).changes);
  return counts;
}

// A Library's requests, newest first (closed and expired ones too, until they are purged).
export function libraryRequests(libraryId) {
  if (!/^[0-9a-f-]{36}$/.test(String(libraryId || ''))) return [];
  return db.prepare('SELECT * FROM book_requests WHERE library_id=? ORDER BY created_at DESC LIMIT 50').all(libraryId).map(publicView);
}

export function listRequests({ status = '', limit = 25, offset = 0 } = {}) {
  const take = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const skip = Math.max(0, Math.min(1e6, Math.floor(Number(offset) || 0)));
  const filter = ['open', 'matched', 'fulfilled', 'closed', 'expired'].includes(status) ? status : '';
  const where = filter ? 'WHERE r.status=?' : '';
  const args = filter ? [filter] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM book_requests r ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT r.*,b.title AS book_title FROM book_requests r LEFT JOIN catalog_books b ON b.id=r.matched_book_id
    ${where} ORDER BY r.created_at DESC,r.id LIMIT ? OFFSET ?`).all(...args, take, skip);
  const byStatus = Object.fromEntries(db.prepare('SELECT status,COUNT(*) AS n FROM book_requests GROUP BY status').all().map(r => [r.status, r.n]));
  return {
    items: rows.map(r => ({
      id: r.id, reference: r.reference, title: r.title, author: r.author, isbn: r.isbn, name: r.name, email: r.email,
      status: r.status, matchedBookId: r.matched_book_id || '', matchedTitle: r.book_title || '',
      createdAt: r.created_at, expiresAt: r.expires_at, matchedAt: r.matched_at,
    })),
    total, limit: take, offset: skip, counts: byStatus,
  };
}

// Admin action: close an open or matched request by hand (spam, already handled elsewhere).
export function closeRequest(id) {
  const key = clean(id, 64);
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Unknown request');
  const result = db.prepare("UPDATE book_requests SET status='closed',updated_at=? WHERE id=? AND status IN ('open','matched')").run(iso(Date.now()), key);
  if (!result.changes) throw new Error('That request is not open');
  return { closed: true };
}
