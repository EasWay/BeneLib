// Supabase Database (PostgREST) & Storage integration for Pagehouse (Render + Vercel deployment).
// Keeps the local SQLite database synchronized with Supabase PostgreSQL across restarts on ephemeral
// hosts like Render, and stores/serves converted PDF books and database snapshots in Supabase Storage.
// Fails soft when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set so local development and unit
// tests run without network dependencies.

const SUPABASE_URL = () => String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
const SUPABASE_BUCKET = () => String(process.env.SUPABASE_STORAGE_BUCKET || 'pagehouse-books').trim();

export function supabaseConfigured() {
  const url = SUPABASE_URL();
  const key = SUPABASE_KEY();
  return Boolean(url && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && key);
}

function authHeaders(extra = {}) {
  const key = SUPABASE_KEY();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

// ── Supabase Storage (PDFs, covers, and SQLite state backup) ────────────────

let bucketEnsured = false;
export async function ensureStorageBucket(fetchImpl = fetch) {
  if (!supabaseConfigured() || bucketEnsured) return false;
  const bucket = SUPABASE_BUCKET();
  try {
    const res = await fetchImpl(`${SUPABASE_URL()}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) { bucketEnsured = true; return true; }
    const create = await fetchImpl(`${SUPABASE_URL()}/storage/v1/bucket`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
      signal: AbortSignal.timeout(8000),
    });
    bucketEnsured = create.ok || create.status === 409;
    return bucketEnsured;
  } catch {
    return false;
  }
}

export async function uploadStorageObject(objectPath, buffer, contentType = 'application/pdf', fetchImpl = fetch) {
  if (!supabaseConfigured()) return false;
  await ensureStorageBucket(fetchImpl);
  const bucket = SUPABASE_BUCKET();
  const cleanPath = String(objectPath || '').replace(/^\/+/, '');
  try {
    const res = await fetchImpl(`${SUPABASE_URL()}/storage/v1/object/${encodeURIComponent(bucket)}/${cleanPath}`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': contentType,
        'x-upsert': 'true',
      }),
      body: buffer,
      signal: AbortSignal.timeout(45000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function downloadStorageObject(objectPath, fetchImpl = fetch) {
  if (!supabaseConfigured()) return null;
  const bucket = SUPABASE_BUCKET();
  const cleanPath = String(objectPath || '').replace(/^\/+/, '');
  try {
    const res = await fetchImpl(`${SUPABASE_URL()}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${cleanPath}`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function createSignedStorageUrl(objectPath, expiresInSeconds = 3600, fetchImpl = fetch) {
  if (!supabaseConfigured()) return '';
  const bucket = SUPABASE_BUCKET();
  const cleanPath = String(objectPath || '').replace(/^\/+/, '');
  try {
    const res = await fetchImpl(`${SUPABASE_URL()}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${cleanPath}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data?.signedURL ? `${SUPABASE_URL()}/storage/v1${data.signedURL}` : '';
  } catch {
    return '';
  }
}

// ── Supabase PostgREST Table Sync ───────────────────────────────────────────

const TABLES = [
  { name: 'catalog_books', conflict: 'id' },
  { name: 'catalog_rights_policy', conflict: 'id' },
  { name: 'store_settings', conflict: 'key' },
  { name: 'store_source_licences', conflict: 'source_id' },
  { name: 'store_download_checks', conflict: 'book_id' },
  { name: 'libraries', conflict: 'id' },
  { name: 'library_passkeys', conflict: 'credential_id' },
  { name: 'store_orders', conflict: 'id' },
  { name: 'store_order_items', conflict: 'order_id,book_id' },
  { name: 'store_download_sessions', conflict: 'order_id,book_id,token_expires_at' },
  { name: 'store_payment_events', conflict: 'event_hash' },
  { name: 'book_requests', conflict: 'id' },
  { name: 'email_outbox', conflict: 'id' },
];

export async function upsertRows(table, rows, onConflict = 'id', fetchImpl = fetch) {
  if (!supabaseConfigured() || !Array.isArray(rows) || !rows.length) return { synced: 0 };
  const batchSize = 250;
  let synced = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    try {
      const url = `${SUPABASE_URL()}/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(onConflict)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) synced += chunk.length;
      else if (res.status === 404) break;
    } catch {
      // Soft fail so live checkout/download traffic is never interrupted
    }
  }
  return { synced };
}

export async function fetchAllRows(table, fetchImpl = fetch) {
  if (!supabaseConfigured()) return [];
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    try {
      const url = `${SUPABASE_URL()}/rest/v1/${encodeURIComponent(table)}?select=*&limit=${pageSize}&offset=${offset}`;
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: authHeaders({ Accept: 'application/json' }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
      offset += rows.length;
    } catch {
      break;
    }
  }
  return all;
}

// Pushes all local SQLite tables to Supabase PostgreSQL + backs up a SQLite snapshot to Supabase Storage.
export async function pushDatabaseToSupabase(db, fetchImpl = fetch) {
  if (!supabaseConfigured()) return { configured: false, tables: {} };
  const summary = {};
  for (const { name, conflict } of TABLES) {
    try {
      const rows = db.prepare(`SELECT * FROM ${name}`).all().map(r => ({ ...r }));
      if (rows.length) {
        const res = await upsertRows(name, rows, conflict, fetchImpl);
        summary[name] = res.synced;
      } else {
        summary[name] = 0;
      }
    } catch {
      summary[name] = 0;
    }
  }
  // Also upload a JSON snapshot of all tables to Supabase Storage so hydration works even before SQL tables are created
  let snapshotSaved = false;
  try {
    const dump = {};
    for (const { name } of TABLES) {
      try { dump[name] = db.prepare(`SELECT * FROM ${name}`).all().map(r => ({ ...r })); } catch { dump[name] = []; }
    }
    const buf = Buffer.from(JSON.stringify(dump), 'utf8');
    snapshotSaved = await uploadStorageObject('_snapshots/pagehouse-db.json', buf, 'application/json', fetchImpl);
  } catch {}
  return { configured: true, tables: summary, snapshotSaved };
}

// Hydrates local SQLite database from Supabase PostgreSQL (or Storage snapshot fallback) on startup.
export async function pullDatabaseFromSupabase(db, fetchImpl = fetch) {
  if (!supabaseConfigured()) return { configured: false, hydrated: 0 };
  let totalHydrated = 0;
  for (const { name } of TABLES) {
    try {
      const rows = await fetchAllRows(name, fetchImpl);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(',');
      const updates = cols.map(c => `${c}=excluded.${c}`).join(',');
      const stmt = db.prepare(`INSERT INTO ${name} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO UPDATE SET ${updates}`);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of rows) {
          stmt.run(...cols.map(c => r[c] ?? null));
          totalHydrated++;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
      }
    } catch {
      // Table may not exist yet on remote
    }
  }
  // Fallback to Storage snapshot if SQL tables returned 0 rows
  if (totalHydrated === 0) {
    try {
      const snapBuf = await downloadStorageObject('_snapshots/pagehouse-db.json', fetchImpl);
      if (snapBuf) {
        const dump = JSON.parse(snapBuf.toString('utf8'));
        for (const { name } of TABLES) {
          const rows = dump?.[name];
          if (!Array.isArray(rows) || !rows.length) continue;
          const cols = Object.keys(rows[0]);
          const placeholders = cols.map(() => '?').join(',');
          const updates = cols.map(c => `${c}=excluded.${c}`).join(',');
          const stmt = db.prepare(`INSERT INTO ${name} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO UPDATE SET ${updates}`);
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const r of rows) {
              stmt.run(...cols.map(c => r[c] ?? null));
              totalHydrated++;
            }
            db.exec('COMMIT');
          } catch {
            db.exec('ROLLBACK');
          }
        }
      }
    } catch {}
  }
  // Rebuild FTS index if catalog_books were hydrated
  try {
    const booksCount = db.prepare('SELECT COUNT(*) AS n FROM catalog_books').get()?.n || 0;
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM catalog_books_fts').get()?.n || 0;
    if (booksCount > 0 && ftsCount < booksCount) {
      db.exec('DELETE FROM catalog_books_fts');
      const addFts = db.prepare('INSERT INTO catalog_books_fts(book_id,title,authors,description,subjects) VALUES(?,?,?,?,?)');
      const books = db.prepare('SELECT id,title,authors,description,subjects FROM catalog_books').all();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const b of books) {
          let subj = '';
          try { subj = JSON.parse(b.subjects || '[]').join(' '); } catch {}
          addFts.run(b.id, b.title, b.authors, b.description, subj);
        }
        db.exec('COMMIT');
      } catch {
        db.exec('ROLLBACK');
      }
    }
  } catch {}
  return { configured: true, hydrated: totalHydrated };
}

export function supabaseStatus() {
  return {
    configured: supabaseConfigured(),
    url: SUPABASE_URL() || null,
    bucket: SUPABASE_BUCKET(),
  };
}
