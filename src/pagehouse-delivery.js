// Paid source delivery has two gates. Rights: the book's source must hold an approved, unexpired licence for sale
// and redistribution (Admin → Source licences, see sourceLicensed() in pagehouse.js). Delivery: the source must be
// in SOURCES below, with a resolver in sources.js that finds the file. A source missing either is not for sale.
import { db, sourceLicensed, deliverableSources } from './pagehouse.js';
import { resolveCatalogBook, currentUA, freshLibgenLink } from './sources.js';
import { fetchPublic } from './netguard.js';
import { convertEpubBufferToPdf } from './epub-pdf.js';
import { supabaseConfigured, uploadStorageObject, downloadStorageObject, upsertRows } from './supabase.js';

const DAY = 864e5;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const CHECK_BATCH = 5;
const CHECK_DELAY_MS = 1100;
const stamp = () => new Date().toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIBGEN_HOSTS = ['libgen.li', 'libgen.bz', 'libgen.gl', 'libgen.la', 'libgen.vg', 'libgen.lc', 'libgen.rs', 'libgen.is', 'libgen.st', 'booksdl.lc', 'booksdl.org'];
const ZLIB_HOSTS = ['z-library.sk', '1lib.sk', 'z-lib.gd', 'z-lib.gl', 'libb.la', 'zlib.li', 'ncdn.ec', 'fcdn.sk', 'zlibcdn.com', 'zlibcdn2.com', ...LIBGEN_HOSTS];

const SOURCES = {
  gutenberg: { hosts: ['gutenberg.org'], label: 'Project Gutenberg' },
  archive: { hosts: ['archive.org'], label: 'Internet Archive' },
  'internet-archive': { hosts: ['archive.org'], label: 'Internet Archive' },
  openstax: { hosts: ['openstax.org', 'assets.openstax.org'], label: 'OpenStax' },
  libretexts: { hosts: ['libretexts.org', 'commons.libretexts.org', 'batch.libretexts.org', 'downloads.libretexts.org'], label: 'LibreTexts' },
  memoryoftheworld: { hosts: ['memoryoftheworld.org'], label: 'Memory of the World' },
  'memory-of-the-world': { hosts: ['memoryoftheworld.org'], label: 'Memory of the World' },
  libgen: { hosts: LIBGEN_HOSTS, label: 'Library Genesis' },
  'library-genesis': { hosts: LIBGEN_HOSTS, label: 'Library Genesis' },
  annas: { hosts: LIBGEN_HOSTS, label: "Anna's Archive" },
  'anna-s-archive': { hosts: LIBGEN_HOSTS, label: "Anna's Archive" },
  royallib: { hosts: ['royallib.com'], label: 'RoyalLib' },
  zlibrary: { hosts: ZLIB_HOSTS, label: 'Z-Library' },
  'z-library': { hosts: ZLIB_HOSTS, label: 'Z-Library' },
};

for (const id of Object.keys(SOURCES)) deliverableSources.add(id);
const SOURCE_IDS = Object.keys(SOURCES);
// The deliverable sources that are licensed right now, as SQL placeholders and values.
const licensedDeliverable = () => SOURCE_IDS.filter(id => sourceLicensed(id));
const inList = ids => ids.map(() => '?').join(',');

db.exec(`
  CREATE TABLE IF NOT EXISTS store_download_checks (
    book_id TEXT PRIMARY KEY REFERENCES catalog_books(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    content_type TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    retry_after TEXT NOT NULL DEFAULT ''
  );
`);

// Fails closed: a row without its source_id is never ready.
export function bookRightsReady(book) {
  return !!book?.source_id && book.status === 'listed';
}

// Why a book cannot be sold, for checkout errors.
export function saleBlockReason(book) {
  if (!book || book.status !== 'listed') return 'A selected book is not available for sale';
  return '';
}

const cleanUrl = (value, hosts) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!hosts.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
    return url;
  } catch { return null; }
};

function parseSourceRef(value, host) {
  const url = cleanUrl(value, [host]);
  return url ? url : null;
}

const ALL_DELIVERY_HOSTS = [...new Set([
  'gutenberg.org', 'archive.org', 'openstax.org', 'assets.openstax.org',
  'libretexts.org', 'commons.libretexts.org', 'batch.libretexts.org', 'downloads.libretexts.org',
  'memoryoftheworld.org', 'royallib.com', ...ZLIB_HOSTS,
])];

export async function resolveBook(book, resolver = resolveCatalogBook) {
  const source = SOURCES[book?.source_id];
  if (!source) return null;
  const resolved = await resolver(book);
  const file = cleanUrl(resolved?.url || '', ALL_DELIVERY_HOSTS);
  const format = String(resolved?.format || '').toLowerCase().replace(/^\./, '');
  if (!file || !['pdf', 'epub', 'zip', 'txt'].includes(format)) return null;
  const primaryMatch = cleanUrl(file.href, source.hosts);
  const hosts = primaryMatch ? source.hosts : ALL_DELIVERY_HOSTS;
  const out = { url: file.href, format, size: Number(resolved.size) || 0, hosts };
  if (Array.isArray(resolved?.fallbacks) && resolved.fallbacks.length) {
    const fb = resolved.fallbacks
      .map(item => {
        const u = cleanUrl(item?.url || '', ALL_DELIVERY_HOSTS);
        const f = String(item?.format || '').toLowerCase().replace(/^\./, '');
        return u && ['pdf', 'epub', 'zip', 'txt'].includes(f) ? { url: u.href, format: f, size: Number(item.size) || 0 } : null;
      })
      .filter(Boolean);
    if (fb.length) Object.defineProperty(out, 'fallbacks', { value: fb, enumerable: false });
  }
  return out;
}

export function isSupportedSource(sourceId) {
  return Object.hasOwn(SOURCES, sourceId);
}

export function deliveryHosts(sourceId) {
  return SOURCES[sourceId]?.hosts || [];
}

export function fileSignatureOk(format, bytes) {
  const ext = String(format || '').toLowerCase().replace(/^\./, '');
  if (ext === 'pdf') return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (['epub', 'zip'].includes(ext)) return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])
    && [0x04, 0x06, 0x08].includes(bytes[3]);
  if (ext === 'txt') return bytes.length > 0 && !bytes.subarray(0, Math.min(bytes.length, 512)).includes(0);
  return false;
}

async function prefixFrom(response, limit = 8192) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The source returned no file body');
  const chunks = [];
  let length = 0;
  while (length < limit) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    length += chunk.length;
    if (length >= 8) break;
  }
  const prefix = Buffer.concat(chunks);
  return {
    prefix,
    stream: (async function* () {
      try {
        for (const chunk of chunks) yield chunk;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          yield Buffer.from(value);
        }
      } finally { reader.releaseLock(); }
    })(),
    cancel: () => reader.cancel().catch(() => {}),
  };
}

function totalSize(response) {
  const range = response.headers.get('content-range')?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  const value = Number(range?.[1] || response.headers.get('content-length'));
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_FILE_BYTES ? value : 0;
}

function setCheck(bookId, status, { size = 0, contentType = '', error = '', retryMs = 0 } = {}) {
  if (error) console.warn(`[delivery] book ${String(bookId).slice(0, 8)} ${status}: ${String(error).slice(0, 200)}`);
  const checkedAt = stamp();
  db.prepare(`INSERT INTO store_download_checks(book_id,checked_at,size,content_type,error,retry_after)
    VALUES(?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET checked_at=excluded.checked_at,
    size=excluded.size,content_type=excluded.content_type,error=excluded.error,retry_after=excluded.retry_after`)
    .run(bookId, checkedAt, size, contentType.slice(0, 150), error.slice(0, 300),
      retryMs ? new Date(Date.now() + retryMs).toISOString() : '');
  db.prepare('UPDATE catalog_books SET file_status=?,updated_at=? WHERE id=?')
    .run(status, checkedAt, bookId);
}

async function fetchWithMirrorFallback(resolved, init, fetcher, timeoutMs = 12000) {
  const candidates = [{ url: resolved.url, format: resolved.format, size: resolved.size }, ...(resolved.fallbacks || [])];
  let lastRes = null, lastUrl = resolved.url;
  for (const candidate of candidates) {
    let url = candidate.url;
    const md5 = (url.match(/[?&]md5=([a-f0-9]{32})/i) || [])[1]?.toLowerCase() || '';
    const failed = [];
    let tries = 0;
    while (tries < 2) {
      tries++;
      try {
        const res = await fetcher(url, {
          ...init,
          signal: init.signal || AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': currentUA(), Accept: '*/*', ...init.headers },
        }, { allowedHosts: resolved.hosts });
        lastRes = res; lastUrl = url;
        if (res.status < 500 && !/text\/html/i.test(res.headers.get('content-type') || '')) {
          resolved.format = candidate.format || resolved.format;
          resolved.size = candidate.size || resolved.size;
          return { res, url };
        }
        if (res.body) res.body.cancel().catch(() => {});
      } catch (err) {
        if (!lastRes && candidates.length === 1 && tries >= 2) throw err;
      }
      if (!md5) break;
      failed.push(new URL(url).origin);
      const next = await freshLibgenLink(md5, failed);
      const cleanNext = cleanUrl(next || '', resolved.hosts);
      if (!cleanNext) break;
      url = cleanNext.href;
    }
  }
  if (!lastRes) throw new Error('The source file could not be fetched');
  return { res: lastRes, url: lastUrl };
}

async function performCheck(bookId, fetcher = fetchPublic, resolver = resolveCatalogBook) {
  const book = db.prepare('SELECT * FROM catalog_books WHERE id=?').get(bookId);
  if (!book || !bookRightsReady(book) || !isSupportedSource(book.source_id)) return { status: 'not_for_sale' };
  if (book.file_key) return { status: 'ready', local: true };
  try {
    const resolved = await resolveBook(book, resolver);
    if (!resolved) {
      setCheck(book.id, 'queued', { error: 'No downloadable file is available from this source record', retryMs: DAY });
      return { status: 'queued' };
    }
    const { res: response } = await fetchWithMirrorFallback(resolved, {
      headers: { Range: 'bytes=0-8191' },
    }, fetcher, 12000);
    if (![200, 206].includes(response.status)) {
      if (response.body) response.body.cancel().catch(() => {});
      setCheck(book.id, 'queued',
        { error: `File host returned HTTP ${response.status}`, retryMs: DAY });
      return { status: 'queued' };
    }
    if (/text\/html/i.test(response.headers.get('content-type') || '')) {
      if (response.body) response.body.cancel().catch(() => {});
      setCheck(book.id, 'queued', { contentType: response.headers.get('content-type') || '', error: 'Stale link: the site sent a page instead of the file', retryMs: DAY });
      return { status: 'queued' };
    }
    const prefix = await prefixFrom(response);
    let format = resolved.format;
    let signatureOk = fileSignatureOk(format, prefix.prefix);
    if (!signatureOk) {
      for (const candidate of ['pdf', 'epub', 'zip']) {
        if (fileSignatureOk(candidate, prefix.prefix)) { format = candidate; signatureOk = true; break; }
      }
    }
    await prefix.cancel();
    if (!signatureOk) {
      setCheck(book.id, 'queued', { contentType: response.headers.get('content-type') || '', error: 'File header did not match the book format', retryMs: DAY });
      return { status: 'queued' };
    }
    if (format && format !== book.format) db.prepare('UPDATE catalog_books SET format=? WHERE id=?').run(format, book.id);
    const size = totalSize(response) || resolved.size || 0;
    setCheck(book.id, 'ready', { size, contentType: response.headers.get('content-type') || '' });
    return { status: 'ready', size };
  } catch (error) {
    setCheck(book.id, 'queued', { error: String(error.message || error), retryMs: DAY });
    return { status: 'queued', error: String(error.message || error) };
  }
}

export function candidateIds({ force = false, limit = CHECK_BATCH } = {}) {
  const sources = SOURCE_IDS;
  if (!sources.length) return [];
  const take = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : CHECK_BATCH;
  const rows = db.prepare(`SELECT b.id FROM catalog_books b LEFT JOIN store_download_checks c ON c.book_id=b.id
    WHERE b.status='listed'
      AND b.source_id IN (${inList(sources)})
      AND b.file_key=''
      AND (?=1 OR COALESCE(c.checked_at,'')='' OR
        (b.file_status='queued' AND (COALESCE(c.retry_after,'')='' OR c.retry_after<=?)) OR
        (b.file_status='ready' AND c.checked_at<=?))
    ORDER BY CASE b.file_status WHEN 'queued' THEN 0 WHEN 'metadata_only' THEN 1 ELSE 2 END,c.checked_at,b.id
    LIMIT ?`);
  const freshCutoff = new Date(Date.now() - 7 * DAY).toISOString();
  return rows.all(...sources, force ? 1 : 0, stamp(), freshCutoff, take).map(row => row.id);
}

let activeRun = null;
let lastRun = null;
let checkLock = Promise.resolve();
let lastHost = '';
let lastHostCheck = 0;

async function checkSerial(bookId, fetcher = fetchPublic, resolver = resolveCatalogBook) {
  const run = checkLock.then(async () => {
    const before = db.prepare('SELECT source_id FROM catalog_books WHERE id=?').get(bookId);
    const hostKey = before?.source_id || '';
    if (lastHost === hostKey) await wait(Math.max(0, CHECK_DELAY_MS - (Date.now() - lastHostCheck)));
    lastHost = hostKey;
    lastHostCheck = Date.now();
    return performCheck(bookId, fetcher, resolver);
  });
  checkLock = run.catch(() => {});
  return run;
}

export async function recheckStale(bookIds, fetcher = fetchPublic, resolver = resolveCatalogBook) {
  if (!Array.isArray(bookIds) || bookIds.length > 10) throw new Error('Invalid book selection');
  for (const id of bookIds) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) continue;
    const row = db.prepare(`SELECT b.id,b.source_id,b.file_status,b.file_key,b.status,b.rights_status,b.license,b.rights_scope,b.rights_evidence,
      c.checked_at FROM catalog_books b
      LEFT JOIN store_download_checks c ON c.book_id=b.id WHERE b.id=?`).get(id);
    if (row?.file_key) continue;
    const sourceId = db.prepare('SELECT source_id FROM catalog_books WHERE id=?').get(id)?.source_id;
    if (!row || !bookRightsReady(row) || !isSupportedSource(sourceId)) continue;
    if (row.checked_at && Date.parse(row.checked_at) > Date.now() - 7 * DAY && row.file_status === 'ready') continue;
    await checkSerial(id, fetcher, resolver).catch(() => {});
  }
}

export async function checkBook(bookId, { fetcher = fetchPublic, resolver = resolveCatalogBook } = {}) {
  return performCheck(bookId, fetcher, resolver);
}

export function deliveryStats() {
  const rows = db.prepare(`SELECT source_id,MAX(source_name) AS source_name,COUNT(*) AS total,
    SUM(CASE WHEN status='listed' AND file_status<>'unavailable' THEN 1 ELSE 0 END) AS ready,
    SUM(CASE WHEN status='listed' AND file_status='unavailable' THEN 1 ELSE 0 END) AS unavailable
    FROM catalog_books GROUP BY source_id ORDER BY source_name COLLATE NOCASE`).all();
  const sources = rows.map(row => {
    const deliverable = isSupportedSource(row.source_id);
    const ready = deliverable ? row.ready : 0;
    const unavailable = deliverable ? row.unavailable : 0;
    return { ...row, licensed: true, deliverable, ready, unavailable, not_for_sale: row.total - ready - unavailable };
  });
  return { sources, run: activeRun ? { ...activeRun } : lastRun ? { ...lastRun } : null };
}

export function startDeliveryChecks({ force = true, limit = 50 } = {}) {
  if (activeRun) return { ...activeRun, reused: true };
  const ids = candidateIds({ force, limit });
  const run = { status: 'running', total: ids.length, checked: 0, ready: 0, unavailable: 0, errors: 0, startedAt: stamp() };
  activeRun = run;
  void (async () => {
    try {
      for (const id of ids) {
        const result = await checkSerial(id);
        run.checked++;
        if (result.status === 'ready') run.ready++;
        else if (result.status === 'unavailable') run.unavailable++;
        else if (result.error) run.errors++;
        run.updatedAt = stamp();
      }
      run.status = 'completed';
      run.finishedAt = stamp();
    } catch (error) {
      run.status = 'failed';
      run.error = String(error.message || error).slice(0, 300);
      run.finishedAt = stamp();
    }
  })().finally(() => { lastRun = { ...run }; activeRun = null; });
  return { ...run, reused: false };
}

export async function runScheduledChecks() {
  if (activeRun) return { skipped: true };
  const ids = candidateIds({ force: false, limit: CHECK_BATCH });
  if (!ids.length) return { checked: 0 };
  const run = { status: 'running', total: ids.length, checked: 0, ready: 0, unavailable: 0, errors: 0, startedAt: stamp() };
  activeRun = run;
  try {
    for (const id of ids) {
      const result = await checkSerial(id);
      run.checked++;
      if (result.status === 'ready') run.ready++;
      else if (result.status === 'unavailable') run.unavailable++;
      else if (result.error) run.errors++;
    }
    run.status = 'completed';
    run.finishedAt = stamp();
    return { checked: run.checked };
  } catch (error) {
    run.status = 'failed';
    run.error = String(error.message || error).slice(0, 300);
    throw error;
  } finally {
    lastRun = { ...run };
    activeRun = null;
  }
}

export async function streamBook(grant, req, res, payments, fetcher = fetchPublic, resolver = resolveCatalogBook) {
  const book = db.prepare(`SELECT b.*,c.size AS checked_size,c.content_type FROM catalog_books b
    LEFT JOIN store_download_checks c ON c.book_id=b.id WHERE b.id=?`).get(grant.bookId);
  if (!book || !bookRightsReady(book) || !isSupportedSource(book.source_id)) {
    return { error: 'This book is not available for sale', statusCode: 404 };
  }
  let resolved;
  try { resolved = await resolveBook({ ...book, source_id: grant.sourceId, source_ref: grant.sourceRef }, resolver); }
  catch (error) { setCheck(book.id, 'queued', { error: String(error.message || error), retryMs: DAY }); return { error: 'The file could not be checked. Try again later.', statusCode: 502 }; }
  if (!resolved) { setCheck(book.id, 'queued', { error: 'No downloadable file is available from this source record', retryMs: DAY }); return { error: 'This book is not available for delivery', statusCode: 404 }; }

  const requestRange = req.headers.range || '';
  let range = null;
  if (requestRange) {
    const match = requestRange.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) return { error: 'Only a single byte range is supported', statusCode: 416 };
    range = { start: Number(match[1]), end: match[2] ? Number(match[2]) : null };
    if (!Number.isSafeInteger(range.start) || (range.end !== null && (!Number.isSafeInteger(range.end) || range.end < range.start))) return { error: 'Invalid byte range', statusCode: 416 };
  }

  // If the book's PDF is already cached in Supabase Storage, serve it directly without hitting the external source.
  if (!range && supabaseConfigured()) {
    const cachedPdf = await downloadStorageObject(`books/${book.id}.pdf`).catch(() => null);
    if (cachedPdf && fileSignatureOk('pdf', cachedPdf)) {
      if (!await payments.reserveDownload(grant)) {
        return { error: 'Download link is invalid, expired or out of downloads', statusCode: 404 };
      }
      const filename = `${String(book.title || 'book').replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 100) || 'book'}.pdf`;
      const safeFilename = filename.replace(/[^\x20-\x7e]|["\\;]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(cachedPdf.length),
        'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      });
      const { Readable } = await import('node:stream');
      const { pipeline } = await import('node:stream/promises');
      try { await pipeline(Readable.from([cachedPdf]), res); }
      catch (error) { if (!res.destroyed) throw error; }
      if (!res.destroyed) payments.completeRemoteDownload(grant);
      return { streamed: true };
    }
  }

  let response, prefix;
  try {
    if (range) {
      const { res: probe, url: workingUrl } = await fetchWithMirrorFallback(resolved, { headers: { Range: 'bytes=0-7' } }, fetcher, 15000);
      resolved.url = workingUrl;
      if (![200, 206].includes(probe.status)) {
        if (probe.body) probe.body.cancel().catch(() => {});
        setCheck(book.id, 'queued', { error: `File host returned HTTP ${probe.status}`, retryMs: DAY });
        return { error: 'The source file is unavailable; it has been queued for a recheck', statusCode: 502 };
      }
      if (/text\/html/i.test(probe.headers.get('content-type') || '')) {
        if (probe.body) probe.body.cancel().catch(() => {});
        setCheck(book.id, 'queued', { error: 'Stale link: the site sent a page instead of the file', retryMs: DAY });
        return { error: 'The source did not return a valid book file; it has been queued for a recheck', statusCode: 502 };
      }
      const magic = await prefixFrom(probe, 8);
      let valid = fileSignatureOk(resolved.format, magic.prefix);
      if (!valid) {
        for (const candidate of ['pdf', 'epub', 'zip']) {
          if (fileSignatureOk(candidate, magic.prefix)) { resolved.format = candidate; valid = true; break; }
        }
      }
      await magic.cancel();
      if (!valid) {
        setCheck(book.id, 'queued', { error: 'File header did not match the book format', retryMs: DAY });
        return { error: 'The source did not return a valid book file; it has been queued for a recheck', statusCode: 502 };
      }
      response = await fetcher(resolved.url, {
        headers: { Range: requestRange, 'User-Agent': currentUA(), Accept: '*/*' },
        signal: AbortSignal.timeout(60 * 60 * 1000),
      }, { allowedHosts: resolved.hosts });
      if (response.status !== 206) {
        if (response.body) response.body.cancel().catch(() => {});
        return { error: 'The source does not support download resuming', statusCode: 416 };
      }
      const contentRange = response.headers.get('content-range') || '';
      const parsed = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      if (!parsed || Number(parsed[1]) !== range.start || (range.end !== null && Number(parsed[2]) > range.end)) {
        if (response.body) response.body.cancel().catch(() => {});
        return { error: 'The source returned an invalid byte range', statusCode: 502 };
      }
    } else {
      const { res: fullRes, url: workingUrl } = await fetchWithMirrorFallback(resolved, {}, fetcher, 60 * 60 * 1000);
      response = fullRes;
      resolved.url = workingUrl;
      if (response.status !== 200) {
        if (response.body) response.body.cancel().catch(() => {});
        setCheck(book.id, 'queued', { error: `File host returned HTTP ${response.status}`, retryMs: DAY });
        return { error: 'The source file is unavailable; it has been queued for a recheck', statusCode: 502 };
      }
      if (/text\/html/i.test(response.headers.get('content-type') || '')) {
        if (response.body) response.body.cancel().catch(() => {});
        setCheck(book.id, 'queued', { error: 'Stale link: the site sent a page instead of the file', retryMs: DAY });
        return { error: 'The source did not return a valid book file; it has been queued for a recheck', statusCode: 502 };
      }
      prefix = await prefixFrom(response);
      let valid = fileSignatureOk(resolved.format, prefix.prefix);
      if (!valid) {
        for (const candidate of ['pdf', 'epub', 'zip']) {
          if (fileSignatureOk(candidate, prefix.prefix)) { resolved.format = candidate; valid = true; break; }
        }
      }
      if (!valid) {
        await prefix.cancel();
        setCheck(book.id, 'queued', { error: 'File header did not match the book format', retryMs: DAY });
        return { error: 'The source did not return a valid book file; it has been queued for a recheck', statusCode: 502 };
      }
    }
  } catch (error) {
    if (response?.body) response.body.cancel().catch(() => {});
    setCheck(book.id, 'queued', { error: String(error.message || error), retryMs: DAY });
    return { error: 'The source file could not be fetched; it has been queued for a recheck', statusCode: 502 };
  }

  const size = totalSize(response) || resolved.size || 0;
  if (size > MAX_FILE_BYTES) {
    if (prefix) await prefix.cancel();
    if (response.body) response.body.cancel().catch(() => {});
    setCheck(book.id, 'unavailable', { size, error: 'File exceeds the delivery size limit' });
    return { error: 'This file is too large to deliver', statusCode: 413 };
  }

  let convertedPdf = null;
  if (!range && (resolved.format === 'epub' || resolved.format === 'zip')) {
    try {
      const chunks = [];
      let totalRead = 0;
      for await (const chunk of prefix.stream) {
        totalRead += chunk.length;
        if (totalRead > MAX_FILE_BYTES) throw new Error('File exceeds the delivery size limit');
        chunks.push(Buffer.from(chunk));
      }
      prefix = null;
      const epubBuf = Buffer.concat(chunks);
      convertedPdf = await convertEpubBufferToPdf(epubBuf, { title: book.title || '', author: book.authors || '' });
      resolved.format = 'pdf';
      db.prepare("UPDATE catalog_books SET format='pdf' WHERE id=?").run(book.id);
    } catch (error) {
      setCheck(book.id, 'queued', { error: String(error.message || error), retryMs: DAY });
      return { error: 'The book file could not be converted to PDF; it has been queued for a recheck', statusCode: 502 };
    }
  }

  if (!await payments.reserveDownload(grant)) {
    if (prefix) await prefix.cancel();
    if (response.body) response.body.cancel().catch(() => {});
    return { error: 'Download link is invalid, expired or out of downloads', statusCode: 404 };
  }

  const filename = `${String(book.title || 'book').replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 100) || 'book'}.${resolved.format}`;
  const safeFilename = filename.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  const headers = {
    'Content-Type': resolved.format === 'pdf' ? 'application/pdf' : resolved.format === 'txt' ? 'text/plain; charset=utf-8' : resolved.format === 'zip' ? 'application/zip' : 'application/epub+zip',
    'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  if (convertedPdf) {
    if (supabaseConfigured()) {
      uploadStorageObject(`books/${book.id}.pdf`, convertedPdf, 'application/pdf').catch(() => {});
      const updatedBook = db.prepare('SELECT * FROM catalog_books WHERE id=?').get(book.id);
      if (updatedBook) upsertRows('catalog_books', [{ ...updatedBook }], 'id').catch(() => {});
    }
    headers['Content-Length'] = String(convertedPdf.length);
    res.writeHead(200, headers);
    setCheck(book.id, 'ready', { size: convertedPdf.length, contentType: 'application/pdf' });
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    try { await pipeline(Readable.from([convertedPdf]), res); }
    catch (error) { if (!res.destroyed) throw error; }
    if (!res.destroyed) payments.completeRemoteDownload(grant);
    return { streamed: true };
  }
  let reachesEnd = !range;
  if (range) {
    const length = response.headers.get('content-length');
    if (length) headers['Content-Length'] = length;
    headers['Content-Range'] = response.headers.get('content-range');
    const parsedRange = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    reachesEnd = !!(parsedRange && size && Number(parsedRange[2]) === size - 1);
    res.writeHead(206, headers);
  } else {
    // fetch() decodes gzip/br bodies, so an upstream length would no longer match the bytes we send.
    if (size && !response.headers.get('content-encoding')) headers['Content-Length'] = String(size);
    res.writeHead(200, headers);
  }
  let delivered = 0;
  const stream = (async function* () {
    try {
      if (prefix) {
        for await (const chunk of prefix.stream) { delivered += chunk.length; yield chunk; }
      } else {
        for await (const chunk of response.body || []) { delivered += chunk.length; yield Buffer.from(chunk); }
      }
      if (reachesEnd && (size || delivered)) {
        setCheck(book.id, 'ready', { size: size || delivered, contentType: response.headers.get('content-type') || '' });
      }
    } catch (error) {
      setCheck(book.id, 'queued', { error: String(error.message || error), retryMs: 0 });
      throw error;
    }
  })();
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  try { await pipeline(Readable.from(stream), res); }
  catch (error) {
    if (!res.destroyed) throw error;
  }
  if (!res.destroyed && reachesEnd) payments.completeRemoteDownload(grant);
  return { streamed: true };
}
