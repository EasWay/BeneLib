import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
fs.mkdirSync(path.dirname(process.env.PAGEHOUSE_DB_PATH), { recursive: true });
const store = await import('../src/pagehouse.js');

const clean = {
  sourceId: 'open-catalog', sourceRef: 'work-001', sourceName: 'Open Catalog',
  title: 'The Ghanaian Reader', authors: 'Ama Mensah', description: 'A guide to Ghanaian history',
  language: 'en', publishedYear: 2020, format: 'epub', subjects: ['Ghana', 'History'],
  coverUrl: 'https://covers.example.org/reader.jpg',
  attribution: 'Open Catalog', priceMinor: 250,
};

try {
  // All imported books are automatically published, priced, and ready for sale without rights or licence gates.
  assert.deepEqual(store.importBooks([clean]), { inserted: 1, updated: 0, unchanged: 0, received: 1 });
  assert.deepEqual(store.importBooks([clean]), { inserted: 0, updated: 0, unchanged: 1, received: 1 });

  const found = store.searchCatalog({ q: 'Ghanaian history' });
  assert.equal(found.total, 1);
  const book = store.getBook(found.items[0].id);
  assert.equal(book.title, clean.title);
  assert.equal(book.fileStatus, 'ready');
  assert.equal(book.sourceLicensed, true);
  assert.equal(book.coverUrl, '/api/store/catalog/' + book.id + '/cover');

  const changed = { ...clean, description: 'Updated Ghanaian history reference' };
  assert.deepEqual(store.importBooks([changed]), { inserted: 0, updated: 1, unchanged: 0, received: 1 });
  assert.equal(store.searchCatalog({ q: 'history' }).items[0].title, clean.title);
  assert.equal(store.searchCatalog({ subjects: ['history'] }).items[0].title, clean.title);
  assert.equal(store.searchCatalog({ subjects: ['biology'] }).total, 0);
  assert.equal(store.searchCatalog({ limit: 1, offset: 0 }).items.length, 1);

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

  assert.equal(store.catalogStats().rights_pending, 0);
  assert.equal(store.catalogStats().publishable, 2);
  assert.equal(store.catalogStats().files_ready, 2);
  assert.throws(() => store.importBooks([{ ...clean, sourceRef: '' }]), /sourceId, sourceRef/);
  assert.throws(() => store.importBooks(Array(501).fill(clean)), /between 1 and 500/);
  console.log('Pagehouse catalog persistence: ok');
} finally {
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
