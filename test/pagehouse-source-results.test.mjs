import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-source-results-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
const catalog = await import('../src/pagehouse.js');
const { catalogItemFromResult, sourceIdsForName } = await import('../src/pagehouse-import.js');
const { db } = catalog;

// A search result as sources.js returns it.
const result = (extra = {}) => ({ id: 'abc123', title: 'Arrow of God', author: 'Chinua Achebe', year: '1964', format: '.epub', language: 'English',
  source: 'Z-Library', pageUrl: 'https://z-library.example/book/1', coverUrl: 'https://covers.example/1.jpg', ...extra });
const open = r => { const ids = sourceIdsForName(r.source); return catalog.listSourceResult(catalogItemFromResult(r, ids[0], r.source), ids); };

try {
  assert.deepEqual(sourceIdsForName('Z-Library'), ['zlibrary', 'z-library']);
  assert.deepEqual(sourceIdsForName("Anna's Archive"), ['annas', 'anna-s-archive']);

  // New result: listed as an approved catalogue book, opened like any other without requiring policy setup.
  const first = open(result());
  assert.equal(first.created, true);
  assert.equal(first.book.title, 'Arrow of God');
  assert.equal(first.book.authors, 'Chinua Achebe');
  assert.equal(first.book.publishedYear, 1964);
  assert.equal(first.book.format, 'epub');
  assert.equal(first.book.sourceId, 'zlibrary');
  assert.equal(first.book.coverUrl, `/api/store/catalog/${first.book.id}/cover`);
  assert.equal(first.book.fileStatus, 'ready');
  assert.equal(catalog.getBook(first.book.id).id, first.book.id, 'publicly visible');

  // Opening it again (a new search gives it a new result id) finds the same book; nothing is overwritten.
  db.prepare("UPDATE catalog_books SET price_minor=500,file_status='ready',file_key='x.pdf' WHERE id=?").run(first.book.id);
  const again = open(result({ id: 'def456', title: 'Arrow of God (changed by source)' }));
  assert.equal(again.created, false);
  assert.equal(again.book.id, first.book.id);
  assert.equal(again.book.priceMinor, 500, 'admin price and file survive');
  assert.equal(again.book.title, 'Arrow of God');

  // Filed earlier under the older slug id: found, not duplicated.
  catalog.importBooks([{ sourceId: 'library-genesis', sourceRef: 'https://libgen.example/x', sourceName: 'Library Genesis', title: 'Old Record' }]);
  const old = open(result({ source: 'Library Genesis', pageUrl: 'https://libgen.example/x', title: 'Old Record' }));
  assert.equal(old.created, false);
  assert.equal(old.book.sourceId, 'library-genesis');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM catalog_books WHERE source_ref='https://libgen.example/x'").get().n, 1);

  // Hidden books stay out.
  catalog.importBooks([
    { sourceId: 'zlibrary', sourceRef: 'https://z.example/hidden', sourceName: 'Z-Library', title: 'Hidden', status: 'hidden' },
  ]);
  assert.throws(() => open(result({ pageUrl: 'https://z.example/hidden', title: 'Hidden' })), e => e.statusCode === 410);

  // A result without a page link is still filed stably (by title and author), and unsafe links are dropped.
  const noLink = open(result({ pageUrl: '', downloadUrl: 'javascript:alert(1)', coverUrl: 'file:///etc/passwd', title: 'No Link Book' }));
  assert.match(db.prepare('SELECT source_ref FROM catalog_books WHERE id=?').get(noLink.book.id).source_ref, /^search:[a-f0-9]{64}$/);
  assert.equal(noLink.book.coverUrl, '');
  assert.equal(open(result({ pageUrl: '', title: 'No Link Book', id: 'zzz' })).book.id, noLink.book.id);
  console.log('pagehouse source results tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
