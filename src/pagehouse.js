// Pagehouse catalog persistence for the existing Node backend.
// This is deliberately separate from sources.js: current search adapters remain unchanged.
// Requires Node's built-in node:sqlite (available in the project's Node >=24 runtime).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './config.js';
import { fetchPublic, readCapped } from './netguard.js';

const dbPath = process.env.PAGEHOUSE_DB_PATH || path.join(DATA, 'pagehouse.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS catalog_books (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    source_name TEXT NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    published_year INTEGER,
    format TEXT NOT NULL DEFAULT '',
    subjects TEXT NOT NULL DEFAULT '[]',
    cover_url TEXT NOT NULL DEFAULT '',
    license TEXT NOT NULL DEFAULT '',
    rights_status TEXT NOT NULL DEFAULT 'pending' CHECK (rights_status IN ('pending','approved','rejected')),
    rights_scope TEXT NOT NULL DEFAULT '',
    rights_evidence TEXT NOT NULL DEFAULT '',
    attribution TEXT NOT NULL DEFAULT '',
    price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'GHS',
    file_status TEXT NOT NULL DEFAULT 'metadata_only' CHECK (file_status IN ('metadata_only','queued','ready','unavailable')),
    file_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed','hidden')),
    content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_id, source_ref)
  );
  CREATE INDEX IF NOT EXISTS catalog_books_status_updated ON catalog_books(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS catalog_books_source ON catalog_books(source_id, source_ref);
  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_books_fts USING fts5(
    book_id UNINDEXED, title, authors, description, subjects,
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS catalog_rights_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    license TEXT NOT NULL DEFAULT '',
    rights_scope TEXT NOT NULL DEFAULT '',
    rights_evidence TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    admin_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (admin_confirmed IN (0,1))
  );
`);
if (!db.prepare('PRAGMA table_info(catalog_books)').all().some(column => column.name === 'cover_url')) {
  db.exec("ALTER TABLE catalog_books ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(catalog_rights_policy)').all().some(column => column.name === 'admin_confirmed')) {
  db.exec('ALTER TABLE catalog_rights_policy ADD COLUMN admin_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (admin_confirmed IN (0,1))');
}
try { fs.chmodSync(dbPath, 0o600); } catch { /* the database may be on a filesystem that ignores mode bits */ }

const text = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const now = () => new Date().toISOString();
const stableId = (sourceId, sourceRef) => crypto.createHash('sha256').update(`${sourceId}\0${sourceRef}`).digest('hex').slice(0, 32);
const normalizedMatch = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const authorTokens = value => normalizedMatch(value).replace(/\b\d+\b/g, '').split(' ').filter(Boolean).sort().join(' ');

function exactAuthorMatch(local, candidates) {
  const authors = local.split(/\s*(?:;|&|\band\b)\s*/i).map(authorTokens).filter(Boolean);
  return !authors.length || candidates.some(candidate => {
    const tokens = authorTokens(candidate);
    return tokens && authors.includes(tokens);
  });
}

export function getRightsPolicy() {
  const row = db.prepare('SELECT license,rights_scope,rights_evidence,updated_at,admin_confirmed FROM catalog_rights_policy WHERE id=1').get();
  return row ? {
    license: row.license, rightsScope: row.rights_scope,
    rightsEvidence: row.rights_evidence, updatedAt: row.updated_at, adminConfirmed: row.admin_confirmed === 1,
  } : { license: '', rightsScope: '', rightsEvidence: '', updatedAt: null, adminConfirmed: false };
}

export function saveRightsPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Rights policy must be an object');
  const policy = {
    license: String(input.license ?? '').trim(),
    rightsScope: String(input.rightsScope ?? '').trim(),
    rightsEvidence: String(input.rightsEvidence ?? '').trim(),
  };
  if (policy.license.length > 300 || policy.rightsScope.length > 200 || policy.rightsEvidence.length > 2000) {
    throw new Error('Rights policy exceeds the allowed field length');
  }
  if (Object.values(policy).some(Boolean) && Object.values(policy).some(value => !value)) {
    throw new Error('Enter the license, rights scope, and evidence together, or clear all three');
  }
  const complete = Object.values(policy).every(Boolean);
  if (complete && input.confirmUniversalRights !== true) {
    throw new Error('Confirm that the license, rights scope, and evidence apply to all future imports');
  }
  db.prepare(`INSERT INTO catalog_rights_policy(id,license,rights_scope,rights_evidence,updated_at,admin_confirmed)
    VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET license=excluded.license,
    rights_scope=excluded.rights_scope,rights_evidence=excluded.rights_evidence,
    updated_at=excluded.updated_at,admin_confirmed=excluded.admin_confirmed`)
    .run(policy.license, policy.rightsScope, policy.rightsEvidence, now(), complete ? 1 : 0);
  return getRightsPolicy();
}

export function applyRightsPolicyToExisting() {
  const policy = getRightsPolicy();
  if (!policy.license || !policy.rightsScope || !policy.rightsEvidence || !policy.adminConfirmed) {
    throw new Error('Save and confirm a complete license, rights scope, and evidence policy first');
  }
  const rows = db.prepare(`SELECT id,source_name,title,authors,description,language,published_year,format,subjects,cover_url,
    license,rights_status,rights_scope,rights_evidence,attribution,price_minor,currency,file_status,file_key,status
    FROM catalog_books`).all();
  const update = db.prepare(`UPDATE catalog_books SET license=?,rights_scope=?,rights_evidence=?,content_hash=?,updated_at=?
    WHERE id=?`);
  let updated = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const license = row.license || policy.license;
      const rightsScope = row.rights_scope || policy.rightsScope;
      const rightsEvidence = row.rights_evidence || policy.rightsEvidence;
      if (license === row.license && rightsScope === row.rights_scope && rightsEvidence === row.rights_evidence) continue;
      const material = [
        row.source_name,row.title,row.authors,row.description,row.language,row.published_year,row.format,row.subjects,row.cover_url,
        license,row.rights_status,rightsScope,rightsEvidence,row.attribution,row.price_minor,row.currency,
        row.file_status,row.file_key,row.status,
      ].join('\0');
      const digest = crypto.createHash('sha256').update(material).digest('hex');
      update.run(license, rightsScope, rightsEvidence, digest, now(), row.id);
      updated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { total: rows.length, updated, unchanged: rows.length - updated, approved: 0 };
}

function safeCoverUrl(value) {
  const coverUrl = text(value, 2000);
  if (!coverUrl) return '';
  try {
    const url = new URL(coverUrl);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each catalog item must be an object');
  const sourceId = text(input.sourceId, 80).toLowerCase();
  const sourceRef = text(input.sourceRef, 300);
  const sourceName = text(input.sourceName, 120);
  const title = text(input.title, 500);
  if (!sourceId || !sourceRef || !sourceName || !title) throw new Error('sourceId, sourceRef, sourceName and title are required');
  const subjects = Array.isArray(input.subjects) ? [...new Set(input.subjects.map(x => text(x, 80)).filter(Boolean))].slice(0, 30) : [];
  const year = Number(input.publishedYear);
  const price = Number(input.priceMinor ?? 0);
  const rightsStatus = ['pending', 'approved', 'rejected'].includes(input.rightsStatus) ? input.rightsStatus : 'pending';
  const fileStatus = ['metadata_only', 'queued', 'ready', 'unavailable'].includes(input.fileStatus) ? input.fileStatus : 'metadata_only';
  const status = input.status === 'hidden' ? 'hidden' : 'listed';
  if (!Number.isSafeInteger(price) || price < 0) throw new Error('priceMinor must be a non-negative integer');
  return {
    id: stableId(sourceId, sourceRef), sourceId, sourceRef, sourceName, title,
    rightsStatusProvided: Object.hasOwn(input, 'rightsStatus'),
    authors: text(input.authors, 1000), description: text(input.description, 8000),
    language: text(input.language, 80), publishedYear: Number.isInteger(year) && year >= 0 && year <= 2200 ? year : null,
    format: text(input.format, 40).toLowerCase(), subjects: JSON.stringify(subjects), coverUrl: safeCoverUrl(input.coverUrl),
    license: text(input.license, 300), rightsStatus, rightsScope: text(input.rightsScope, 200),
    rightsEvidence: text(input.rightsEvidence, 2000), attribution: text(input.attribution, 1000),
    priceMinor: price, currency: text(input.currency || 'GHS', 3).toUpperCase(), fileStatus,
    // Never accept a public URL as a file key. This is an internal storage identifier only.
    fileKey: String(input.fileKey || '').length <= 500 && String(input.fileKey || '').split('/').every(part => /^[a-zA-Z0-9._-]+$/.test(part) && part !== '.' && part !== '..') ? String(input.fileKey || '') : '',
    status, contentHash: text(input.contentHash, 128),
  };
}

const columns = ['id','source_id','source_ref','source_name','title','authors','description','language','published_year','format','subjects','cover_url','license','rights_status','rights_scope','rights_evidence','attribution','price_minor','currency','file_status','file_key','status','content_hash','created_at','updated_at'];
const insert = db.prepare(`INSERT INTO catalog_books (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
  ON CONFLICT(source_id, source_ref) DO UPDATE SET
  source_name=excluded.source_name,title=excluded.title,authors=excluded.authors,description=excluded.description,
  language=excluded.language,published_year=excluded.published_year,format=excluded.format,subjects=excluded.subjects,cover_url=excluded.cover_url,
  license=excluded.license,rights_status=excluded.rights_status,rights_scope=excluded.rights_scope,
  rights_evidence=excluded.rights_evidence,attribution=excluded.attribution,price_minor=excluded.price_minor,
  currency=excluded.currency,file_status=excluded.file_status,file_key=excluded.file_key,status=excluded.status,
  content_hash=excluded.content_hash,updated_at=excluded.updated_at`);
const deleteFts = db.prepare('DELETE FROM catalog_books_fts WHERE book_id=?');
const addFts = db.prepare('INSERT INTO catalog_books_fts(book_id,title,authors,description,subjects) VALUES(?,?,?,?,?)');
const findAfter = db.prepare('SELECT * FROM catalog_books WHERE source_id=? AND source_ref=?');

export function importBooks(items, { reviewOnly = false } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) throw new Error('items must contain between 1 and 500 books per batch');
  const policy = getRightsPolicy();
  const universalRights = !!(policy.adminConfirmed && policy.license && policy.rightsScope && policy.rightsEvidence);
  const normalized = items.map(item => {
    const book = normalize({
      ...item,
      license: item?.license || (universalRights && !reviewOnly ? policy.license : ''),
      rightsScope: item?.rightsScope || (universalRights && !reviewOnly ? policy.rightsScope : ''),
      rightsEvidence: item?.rightsEvidence || (universalRights && !reviewOnly ? policy.rightsEvidence : ''),
      ...(reviewOnly ? { rightsStatus: 'pending' } : item?.rightsStatus === 'rejected' ? { rightsStatus: 'rejected' } : universalRights ? { rightsStatus: 'approved' } : {}),
    });
    book.rightsStatusProvided = !reviewOnly && Object.hasOwn(item || {}, 'rightsStatus');
    return book;
  });
  let inserted = 0, updated = 0, unchanged = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const b of normalized) {
      const old = findAfter.get(b.sourceId, b.sourceRef);
      if (old && !b.coverUrl) b.coverUrl = old.cover_url;
      if (old && reviewOnly) {
        b.rightsStatus = old.rights_status;
        b.license = old.license;
        b.rightsScope = old.rights_scope;
        b.rightsEvidence = old.rights_evidence;
        b.attribution = old.attribution;
        b.priceMinor = old.price_minor;
        b.currency = old.currency;
        b.fileStatus = old.file_status;
        b.fileKey = old.file_key;
        b.status = old.status;
      } else if (old && !b.rightsStatusProvided) {
        const sameRights = b.license === old.license && b.rightsScope === old.rights_scope && b.rightsEvidence === old.rights_evidence;
        if (old.rights_status === 'rejected' || (old.rights_status === 'approved' && sameRights)) b.rightsStatus = old.rights_status;
      }
      delete b.rightsStatusProvided;
      const material = [b.sourceName,b.title,b.authors,b.description,b.language,b.publishedYear,b.format,b.subjects,b.coverUrl,b.license,b.rightsStatus,b.rightsScope,b.rightsEvidence,b.attribution,b.priceMinor,b.currency,b.fileStatus,b.fileKey,b.status].join('\0');
      const digest = crypto.createHash('sha256').update(material).digest('hex');
      if (old && old.content_hash === digest) { unchanged++; continue; }
      b.contentHash = digest;
      const stamp = now();
      const values = [b.id,b.sourceId,b.sourceRef,b.sourceName,b.title,b.authors,b.description,b.language,b.publishedYear,b.format,b.subjects,b.coverUrl,b.license,b.rightsStatus,b.rightsScope,b.rightsEvidence,b.attribution,b.priceMinor,b.currency,b.fileStatus,b.fileKey,b.status,digest,old?.created_at || stamp,stamp];
      insert.run(...values);
      deleteFts.run(b.id);
      addFts.run(b.id,b.title,b.authors,b.description,JSON.parse(b.subjects).join(' '));
      old ? updated++ : inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { inserted, updated, unchanged, received: normalized.length };
}

function rowToBook(row) {
  if (!row) return null;
  return {
    id: row.id, sourceId: row.source_id, sourceRef: row.source_ref, sourceName: row.source_name,
    title: row.title, authors: row.authors, description: row.description, language: row.language,
    publishedYear: row.published_year, format: row.format, subjects: JSON.parse(row.subjects || '[]'),
    coverUrl: row.cover_url ? `/api/store/catalog/${row.id}/cover` : '',
    license: row.license, rightsScope: row.rights_scope, attribution: row.attribution,
    priceMinor: row.price_minor, currency: row.currency, fileStatus: row.file_status,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getBook(id) {
  return rowToBook(db.prepare("SELECT * FROM catalog_books WHERE id=? AND status='listed' AND rights_status='approved'").get(text(id, 64)));
}

export function getCatalogCoverSource(id) {
  return db.prepare("SELECT cover_url FROM catalog_books WHERE id=? AND status='listed' AND rights_status='approved'").get(text(id, 64))?.cover_url || '';
}

export async function backfillCatalogCovers({ after = '', limit = 5, fetcher = fetchPublic, delayMs = 1000 } = {}) {
  const cursor = text(after, 32);
  if (cursor && !/^[a-f0-9]{32}$/.test(cursor)) throw new Error('after must be a catalog book ID');
  const take = Number(limit);
  if (!Number.isInteger(take) || take < 1 || take > 5) throw new Error('limit must be between 1 and 5');
  if (typeof fetcher !== 'function') throw new Error('Cover lookup fetcher must be a function');
  const rows = db.prepare(`SELECT id,title,authors FROM catalog_books
    WHERE status='listed' AND rights_status='approved' AND cover_url='' AND id>?
    ORDER BY id LIMIT ?`).all(cursor, take);
  const counts = { checked: 0, matched: 0, notFound: 0, failed: 0 };
  const errors = [];
  for (const row of rows) {
    if (counts.checked && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    counts.checked++;
    try {
      const query = new URLSearchParams({ title: row.title });
      const firstAuthor = row.authors.split(/\s*(?:;|&|\band\b)\s*/i).find(Boolean);
      if (firstAuthor) query.set('author', firstAuthor);
      query.set('fields', 'title,author_name,cover_i');
      query.set('limit', '5');
      const response = await fetcher(`https://openlibrary.org/search.json?${query}`, {
        headers: { 'User-Agent': 'Pagehouse/2.0 (catalog cover lookup)', Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        if (response.body) response.body.cancel().catch(() => {});
        throw new Error(`Open Library returned HTTP ${response.status}`);
      }
      const data = JSON.parse((await readCapped(response, 1e6)).toString('utf8'));
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const title = normalizedMatch(row.title);
      const match = docs.find(doc => normalizedMatch(doc.title) === title
        && exactAuthorMatch(row.authors, Array.isArray(doc.author_name) ? doc.author_name : [])
        && Number.isSafeInteger(doc.cover_i) && doc.cover_i > 0);
      if (!match) {
        counts.notFound++;
        continue;
      }
      const coverUrl = `https://covers.openlibrary.org/b/id/${match.cover_i}-L.jpg?default=false`;
      const current = db.prepare("SELECT * FROM catalog_books WHERE id=? AND status='listed' AND rights_status='approved' AND cover_url=''").get(row.id);
      if (!current) continue;
      const material = [
        current.source_name,current.title,current.authors,current.description,current.language,current.published_year,
        current.format,current.subjects,coverUrl,current.license,current.rights_status,current.rights_scope,
        current.rights_evidence,current.attribution,current.price_minor,current.currency,current.file_status,
        current.file_key,current.status,
      ].join('\0');
      const contentHash = crypto.createHash('sha256').update(material).digest('hex');
      db.prepare(`UPDATE catalog_books SET cover_url=?,content_hash=?
        WHERE id=? AND cover_url='' AND status='listed' AND rights_status='approved'`)
        .run(coverUrl, contentHash, row.id);
      counts.matched++;
    } catch (error) {
      counts.failed++;
      if (errors.length < 5) errors.push({ title: row.title, message: String(error.message || error).slice(0, 300) });
    }
  }
  const nextAfter = rows.at(-1)?.id || cursor;
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM catalog_books WHERE status='listed' AND rights_status='approved' AND cover_url=''").get().n;
  return { ...counts, nextAfter, remaining, done: rows.length < take, errors };
}

export function searchCatalog({ q = '', subjects = [], limit = 20, offset = 0 } = {}) {
  const query = text(q, 200);
  const subjectTerms = Array.isArray(subjects) ? [...new Set(subjects.map(x => text(x, 80).toLowerCase()).filter(Boolean))].slice(0, 30) : [];
  const take = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  const skip = Math.max(0, Math.min(1000000, Math.floor(Number(offset) || 0)));
  const subjectFilter = subjectTerms.length
    ? ` AND EXISTS (SELECT 1 FROM json_each(b.subjects) AS s WHERE lower(s.value) IN (${subjectTerms.map(() => '?').join(',')}))`
    : '';
  let rows, total;
  if (!query) {
    total = db.prepare(`SELECT COUNT(*) AS n FROM catalog_books b WHERE b.status='listed' AND b.rights_status='approved'${subjectFilter}`).get(...subjectTerms).n;
    rows = db.prepare(`SELECT b.* FROM catalog_books b WHERE b.status='listed' AND b.rights_status='approved'${subjectFilter} ORDER BY b.updated_at DESC,b.id LIMIT ? OFFSET ?`).all(...subjectTerms, take, skip);
  } else {
    // FTS MATCH is parameterized; quote every token to avoid interpreting user input as FTS operators.
    const tokens = query.match(/[\p{L}\p{N}]+/gu) || [];
    if (!tokens.length) return { items: [], total: 0, limit: take, offset: skip };
    const match = tokens.slice(0, 12).map(t => `"${t.replaceAll('"','""')}"`).join(' AND ');
    total = db.prepare(`SELECT COUNT(*) AS n FROM catalog_books_fts f JOIN catalog_books b ON b.id=f.book_id WHERE catalog_books_fts MATCH ? AND b.status='listed' AND b.rights_status='approved'${subjectFilter}`).get(match, ...subjectTerms).n;
    rows = db.prepare(`SELECT b.* FROM catalog_books_fts f JOIN catalog_books b ON b.id=f.book_id WHERE catalog_books_fts MATCH ? AND b.status='listed' AND b.rights_status='approved'${subjectFilter} ORDER BY bm25(catalog_books_fts),b.updated_at DESC LIMIT ? OFFSET ?`).all(match, ...subjectTerms, take, skip);
  }
  return { items: rows.map(rowToBook), total, limit: take, offset: skip };
}

export function pendingRightsBooks({ limit = 50, offset = 0 } = {}) {
  const take = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
  const skip = Math.max(0, Math.min(1000000, Math.floor(Number(offset) || 0)));
  const total = db.prepare("SELECT COUNT(*) AS n FROM catalog_books WHERE rights_status='pending'").get().n;
  const eligibleTotal = db.prepare(`SELECT COUNT(*) AS n FROM catalog_books
    WHERE rights_status='pending' AND license<>'' AND rights_scope<>'' AND rights_evidence<>''`).get().n;
  const rows = db.prepare(`SELECT id,source_id,source_ref,source_name,title,authors,license,rights_scope,rights_evidence,status
    FROM catalog_books WHERE rights_status='pending' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(take, skip);
  return {
    items: rows.map(row => ({
      id: row.id, sourceId: row.source_id, sourceRef: row.source_ref, sourceName: row.source_name,
      title: row.title, authors: row.authors, license: row.license, rightsScope: row.rights_scope,
      rightsEvidence: row.rights_evidence, status: row.status,
    })),
    total, eligibleTotal, limit: take, offset: skip,
  };
}

export function pendingRightsBookIds() {
  const rows = db.prepare(`SELECT id FROM catalog_books
    WHERE rights_status='pending' AND license<>'' AND rights_scope<>'' AND rights_evidence<>'' ORDER BY updated_at DESC,id`).all();
  return { ids: rows.map(row => row.id), total: rows.length };
}

export function approvePendingBooks(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500) {
    throw new Error('ids must contain between 1 and 500 book IDs');
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length || uniqueIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) {
    throw new Error('ids must be unique catalog book IDs');
  }
  const find = db.prepare('SELECT * FROM catalog_books WHERE id=?');
  const update = db.prepare("UPDATE catalog_books SET rights_status='approved',content_hash=?,updated_at=? WHERE id=? AND rights_status='pending'");
  let approved = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const records = uniqueIds.map(id => {
      const row = find.get(id);
      if (!row || row.rights_status !== 'pending') throw new Error(`Book ${id} is not pending review`);
      if (!row.license || !row.rights_scope || !row.rights_evidence) {
        throw new Error(`Book "${row.title}" is missing its license, rights scope, or evidence`);
      }
      return row;
    });
    for (const row of records) {
      const material = [
        row.source_name,row.title,row.authors,row.description,row.language,row.published_year,row.format,row.subjects,row.cover_url,
        row.license,'approved',row.rights_scope,row.rights_evidence,row.attribution,row.price_minor,row.currency,
        row.file_status,row.file_key,row.status,
      ].join('\0');
      const digest = crypto.createHash('sha256').update(material).digest('hex');
      const result = update.run(digest, now(), row.id);
      if (result.changes !== 1) throw new Error(`Book "${row.title}" changed during review; refresh the queue and try again`);
    }
    approved = records.length;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { approved };
}

export function catalogStats() {
  return db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN rights_status='approved' AND status='listed' THEN 1 ELSE 0 END),0) AS publishable,
    COALESCE(SUM(CASE WHEN rights_status='pending' THEN 1 ELSE 0 END),0) AS rights_pending,
    COALESCE(SUM(CASE WHEN file_status='ready' THEN 1 ELSE 0 END),0) AS files_ready
    FROM catalog_books`).get();
}
