import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-categories-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
const catalog = await import('../src/pagehouse.js');

// The storefront's categoryFor(), copied from public/pagehouse.html: the server must file books the same way.
const page = fs.readFileSync(new URL('../public/pagehouse.html', import.meta.url), 'utf8');
const categoryFor = new Function(`${page.match(/function categoryFor\(b\)\{[\s\S]*?\n\}/)[0]}; return categoryFor;`)();

const book = (ref, title, authors = '', extra = {}) => ({ sourceId: 'catalog', sourceRef: ref, sourceName: 'Catalog', title, authors,
  license: 'L', rightsScope: 'S', rightsEvidence: 'E', rightsStatus: 'approved', ...extra });
const fixtures = [
  book('1', 'Introductory Statistics'), book('2', 'Meditations', 'Marcus Aurelius', { subjects: ['Stoicism'] }),
  book('3', 'The Prince: on Power and Politics'), book('4', 'A History of Ghana'), book('5', 'Things Fall Apart', 'Chinua Achebe'),
  book('6', 'Philosophy of Physics'), // learning wins over mind: same order as the page
  book('7', 'Hidden Politics', '', { status: 'hidden' }), book('8', 'Second Hidden Politics', '', { status: 'hidden' }),
  book('9', 'Software Wars', '', { coverUrl: 'https://covers.example/9.jpg' }),
];
try {
  catalog.importBooks(fixtures);
  const overview = catalog.categoryOverview({ perCategory: 3 });
  const totals = Object.fromEntries(overview.categories.map(c => [c.key, c.total]));
  assert.deepEqual(totals, { learning: 2, mind: 1, society: 2, identity: 1, stories: 1 }, 'hidden and pending books are not counted');
  // Every published book is in the category the page would give it.
  for (const c of overview.categories) {
    const all = catalog.searchCatalog({ category: c.key, limit: 50 });
    assert.equal(all.total, c.total);
    for (const b of all.items) assert.equal(categoryFor({ title: b.title, authors: b.authors, subjects: b.subjects }), c.key, `${b.title} → ${c.key}`);
  }
  // Books with cover art lead a category's preview.
  assert.equal(overview.categories.find(c => c.key === 'society').books[0].title, 'Software Wars');
  // Category combines with text search; unknown categories are ignored.
  assert.equal(catalog.searchCatalog({ q: 'politics', category: 'society' }).total, 1);
  assert.equal(catalog.searchCatalog({ category: "x' OR 1=1 --" }).total, 7);
  console.log('pagehouse categories tests passed');
} finally {
  catalog.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
