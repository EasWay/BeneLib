import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
fs.mkdirSync(path.dirname(process.env.PAGEHOUSE_DB_PATH), { recursive: true });
const legacyDb = new DatabaseSync(process.env.PAGEHOUSE_DB_PATH);
legacyDb.exec(`CREATE TABLE catalog_rights_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license TEXT NOT NULL DEFAULT '',
  rights_scope TEXT NOT NULL DEFAULT '',
  rights_evidence TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
)`);
legacyDb.prepare('INSERT INTO catalog_rights_policy(id,license,rights_scope,rights_evidence,updated_at) VALUES(1,?,?,?,?)')
  .run('CC BY 4.0', 'redistribution', 'Publisher license record', '2026-01-01T00:00:00.000Z');
legacyDb.close();
const store = await import('../src/pagehouse.js');

const clean = {
  sourceId: 'open-catalog', sourceRef: 'work-001', sourceName: 'Open Catalog',
  title: 'The Ghanaian Reader', authors: 'Ama Mensah', description: 'A guide to Ghanaian history',
  language: 'en', publishedYear: 2020, format: 'epub', subjects: ['Ghana', 'History'],
  coverUrl: 'https://covers.example.org/reader.jpg',
  license: 'CC BY 4.0', rightsStatus: 'approved', rightsScope: 'commercial redistribution',
  rightsEvidence: 'Publisher license record', attribution: 'Open Catalog', priceMinor: 250,
};

try {
  assert.deepEqual(store.getRightsPolicy(), {
    license: 'CC BY 4.0', rightsScope: 'redistribution', rightsEvidence: 'Publisher license record',
    updatedAt: '2026-01-01T00:00:00.000Z', adminConfirmed: false,
  }, 'existing policies migrate as unconfirmed');
  assert.throws(() => store.saveRightsPolicy({ license: 'CC BY 4.0' }), /together/);
  const legacy = { ...clean, sourceRef: 'work-legacy', title: 'Legacy pending book', license: '', rightsScope: '', rightsEvidence: '', rightsStatus: 'pending' };
  store.importBooks([legacy]);
  assert.deepEqual(
    { ...store.db.prepare('SELECT license,rights_scope,rights_evidence FROM catalog_books WHERE source_ref=?').get('work-legacy') },
    { license: '', rights_scope: '', rights_evidence: '' },
    'an unconfirmed legacy policy does not supply rights fields to new imports',
  );
  assert.throws(() => store.saveRightsPolicy({ license: 'CC BY 4.0', rightsScope: 'redistribution', rightsEvidence: 'Publisher license record' }), /Confirm/);
  const defaulted = { ...clean, sourceRef: 'work-default', title: 'Policy defaults', license: '', rightsScope: '', rightsEvidence: '', rightsStatus: 'pending' };
  store.importBooks([defaulted]);
  assert.equal(store.db.prepare('SELECT rights_status FROM catalog_books WHERE source_ref=?').get('work-default').rights_status, 'pending', 'an unconfirmed legacy policy does not auto-approve imports');
  assert.equal(store.searchCatalog({ q: 'Policy defaults' }).total, 0, 'unconfirmed policy books stay hidden');
  assert.throws(() => store.applyRightsPolicyToExisting(), /confirm/);
  store.saveRightsPolicy({ license: 'CC BY 4.0', rightsScope: 'redistribution', rightsEvidence: 'Publisher license record', confirmUniversalRights: true });
  assert.equal(store.getRightsPolicy().adminConfirmed, true);
  store.importBooks([defaulted]);
  assert.equal(store.searchCatalog({ q: 'Policy defaults' }).total, 1, 'complete universal policy automatically publishes future imports');
  assert.equal(store.getBook(store.searchCatalog({ q: 'Policy defaults' }).items[0].id).title, 'Policy defaults');
  assert.deepEqual(
    { ...store.db.prepare('SELECT license,rights_scope,rights_evidence FROM catalog_books WHERE source_ref=?').get('work-default') },
    { license: 'CC BY 4.0', rights_scope: 'redistribution', rights_evidence: 'Publisher license record' },
  );
  assert.equal(store.getBook(store.searchCatalog({ q: 'Policy defaults' }).items[0].id).coverUrl, '/api/store/catalog/' + store.searchCatalog({ q: 'Policy defaults' }).items[0].id + '/cover');
  const explicit = { ...defaulted, sourceRef: 'work-explicit', title: 'Explicit rights', license: 'CC0', rightsScope: 'public domain', rightsEvidence: 'Public domain notice' };
  store.importBooks([explicit]);
  assert.deepEqual(
    { ...store.db.prepare('SELECT license,rights_scope,rights_evidence FROM catalog_books WHERE source_ref=?').get('work-explicit') },
    { license: 'CC0', rights_scope: 'public domain', rights_evidence: 'Public domain notice' },
    'explicit item rights take precedence over defaults',
  );
  assert.equal(store.getRightsPolicy().license, 'CC BY 4.0');
  assert.equal(store.getRightsPolicy().adminConfirmed, true);
  const reviewOnly = {
    ...clean, sourceRef: 'work-review-only', title: 'Review-only import',
    license: '', rightsScope: '', rightsEvidence: '', rightsStatus: 'approved',
  };
  store.importBooks([reviewOnly], { reviewOnly: true });
  const reviewOnlyRow = store.db.prepare('SELECT license,rights_scope,rights_evidence,rights_status FROM catalog_books WHERE source_ref=?').get('work-review-only');
  assert.deepEqual(
    { ...reviewOnlyRow },
    { license: '', rights_scope: '', rights_evidence: '', rights_status: 'pending' },
    'review-only imports do not inherit universal rights or auto-approval',
  );
  store.db.prepare(`UPDATE catalog_books SET license='CC0',rights_scope='reuse',rights_evidence='Source record',
    rights_status='approved',attribution='Curated by admin',price_minor=900,currency='USD',
    file_status='ready',file_key='books/review.epub',status='hidden' WHERE source_ref='work-review-only'`).run();
  store.importBooks([{ ...reviewOnly, title: 'Updated review title' }], { reviewOnly: true });
  const preserved = store.db.prepare(`SELECT license,rights_scope,rights_evidence,rights_status,attribution,price_minor,currency,
    file_status,file_key,status FROM catalog_books WHERE source_ref='work-review-only'`).get();
  assert.deepEqual(
    { ...preserved },
    { license: 'CC0', rights_scope: 'reuse', rights_evidence: 'Source record', rights_status: 'approved', attribution: 'Curated by admin',
      price_minor: 900, currency: 'USD', file_status: 'ready', file_key: 'books/review.epub', status: 'hidden' },
    'review-only refreshes preserve admin rights, approval, pricing, file state, and visibility',
  );
  const backfill = store.applyRightsPolicyToExisting();
  assert.deepEqual(backfill, { total: 4, updated: 1, unchanged: 3, approved: 0 });
  assert.deepEqual(
    { ...store.db.prepare('SELECT license,rights_scope,rights_evidence,rights_status FROM catalog_books WHERE source_ref=?').get('work-legacy') },
    { license: 'CC BY 4.0', rights_scope: 'redistribution', rights_evidence: 'Publisher license record', rights_status: 'pending' },
  );
  assert.equal(store.applyRightsPolicyToExisting().updated, 0, 'applying policy again does not rewrite records');
  const pendingQueue = store.pendingRightsBooks({ limit: 1 });
  assert.equal(pendingQueue.total, 1);
  assert.equal(pendingQueue.eligibleTotal, 1);
  assert.equal(pendingQueue.items.length, 1);
  const legacyId = store.db.prepare('SELECT id FROM catalog_books WHERE source_ref=?').get('work-legacy').id;
  assert.deepEqual(store.pendingRightsBookIds(), { ids: [legacyId], total: 1 }, 'bulk selection includes all pending books with complete rights details');
  assert.deepEqual(store.approvePendingBooks([legacyId]), { approved: 1 });
  assert.equal(store.getBook(legacyId).title, 'Legacy pending book', 'approved and listed books become public');
  const { rightsStatus: _rightsStatus, ...legacyWithoutDecision } = legacy;
  assert.deepEqual(store.importBooks([legacyWithoutDecision]), { inserted: 0, updated: 0, unchanged: 1, received: 1 });
  assert.equal(store.getBook(legacyId).title, 'Legacy pending book', 'imports without a rights decision preserve admin approval');
  assert.throws(() => store.approvePendingBooks([legacyId]), /not pending/);
  store.saveRightsPolicy({ license: '', rightsScope: '', rightsEvidence: '' });
  const incomplete = { ...defaulted, sourceRef: 'work-incomplete', title: 'Incomplete evidence', rightsEvidence: '' };
  store.importBooks([incomplete]);
  const incompleteId = store.db.prepare('SELECT id FROM catalog_books WHERE source_ref=?').get('work-incomplete').id;
  assert.throws(() => store.approvePendingBooks([incompleteId]), /missing its license/);
  assert.equal(store.getBook(incompleteId), null, 'books without complete rights evidence cannot be approved');
  assert.throws(() => store.applyRightsPolicyToExisting(), /complete/);
  const noDefault = { ...clean, sourceRef: 'work-no-default', title: 'No default', license: '', rightsScope: '', rightsEvidence: '', rightsStatus: 'pending' };
  store.importBooks([noDefault]);
  assert.equal(store.getRightsPolicy().license, '');
  assert.equal(store.getRightsPolicy().adminConfirmed, false);
  assert.deepEqual(store.importBooks([clean]), { inserted: 1, updated: 0, unchanged: 0, received: 1 });
  assert.deepEqual(store.importBooks([clean]), { inserted: 0, updated: 0, unchanged: 1, received: 1 });
  assert.deepEqual(store.importBooks([{ ...clean, description: 'Metadata refreshed' }], { reviewOnly: true }), { inserted: 0, updated: 1, unchanged: 0, received: 1 });
  assert.equal(store.getBook(store.searchCatalog({ q: 'Ghanaian' }).items.find(book => book.title === clean.title).id).title, clean.title, 'review-only refreshes do not unpublish an already approved record');
  const changed = { ...clean, description: 'Updated Ghanaian history reference' };
  assert.deepEqual(store.importBooks([changed]), { inserted: 0, updated: 1, unchanged: 0, received: 1 });
  assert.equal(store.searchCatalog({ q: 'Ghanaian history' }).total, 4);
  assert.equal(store.searchCatalog({ q: 'history' }).items[0].title, clean.title);
  assert.equal(store.searchCatalog({ subjects: ['history'] }).items[0].title, clean.title);
  assert.equal(store.searchCatalog({ subjects: ['biology'] }).total, 0);
  assert.equal(store.searchCatalog({ limit: 1, offset: 0 }).items.length, 1);
  assert.equal(store.getBook(store.searchCatalog({ q: 'Ghanaian' }).items[0].id).license, clean.license);

  const manyPending = Array.from({ length: 51 }, (_, index) => ({
    sourceId: 'bulk-review', sourceRef: `bulk-${index}`, sourceName: 'Bulk Review Source',
    title: `Bulk review title ${index}`, authors: 'Test Author',
    license: 'CC BY 4.0', rightsScope: 'redistribution', rightsEvidence: 'Publisher permission',
    rightsStatus: 'pending',
  }));
  assert.equal(store.importBooks(manyPending).inserted, 51);
  const pageOfPending = store.pendingRightsBooks({ limit: 25, offset: 0 });
  const allEligiblePending = store.pendingRightsBookIds();
  assert.equal(pageOfPending.items.length, 25);
  assert.equal(pageOfPending.eligibleTotal, 51);
  assert.equal(allEligiblePending.total, 51);
  assert.equal(new Set(allEligiblePending.ids).size, 51, 'global select-all returns every eligible ID, beyond the current page');

  const coverless = { ...clean, sourceRef: 'work-coverless', title: 'A Coverless Trial', description: '', subjects: [], coverUrl: '' };
  store.importBooks([coverless]);
  const coverLookup = await store.backfillCatalogCovers({
    limit: 5, delayMs: 0,
    fetcher: async url => {
      const request = new URL(url);
      assert.equal(request.hostname, 'openlibrary.org');
      assert.equal(request.searchParams.get('title'), coverless.title);
      return new Response(JSON.stringify({ docs: [
        { title: coverless.title, author_name: ['Someone Else'], cover_i: 77 },
        { title: coverless.title, author_name: ['Ama Mensah'], cover_i: 123 },
      ] }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.deepEqual(
    { checked: coverLookup.checked, matched: coverLookup.matched, notFound: coverLookup.notFound, failed: coverLookup.failed, remaining: coverLookup.remaining, done: coverLookup.done },
    { checked: 1, matched: 1, notFound: 0, failed: 0, remaining: 0, done: true },
    'cover backfill accepts only exact title and author matches',
  );
  const coverlessId = store.db.prepare('SELECT id FROM catalog_books WHERE source_ref=?').get('work-coverless').id;
  assert.equal(store.getCatalogCoverSource(coverlessId), 'https://covers.openlibrary.org/b/id/123-L.jpg?default=false');
  assert.deepEqual(store.importBooks([coverless]), { inserted: 0, updated: 0, unchanged: 1, received: 1 });
  assert.ok(store.getCatalogCoverSource(coverlessId), 'later imports without a cover preserve a backfilled cover');

  const pending = { ...clean, sourceRef: 'work-002', title: 'Unreviewed work', rightsStatus: 'pending' };
  store.importBooks([pending]);
  assert.equal(store.searchCatalog({ q: 'Unreviewed' }).total, 0, 'pending-rights rows are not public');
  assert.equal(store.catalogStats().rights_pending, 54);
  assert.throws(() => store.importBooks([{ ...clean, sourceRef: '' }]), /sourceId, sourceRef/);
  assert.throws(() => store.importBooks(Array(501).fill(clean)), /between 1 and 500/);
  console.log('Pagehouse catalog persistence: ok');
} finally {
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
