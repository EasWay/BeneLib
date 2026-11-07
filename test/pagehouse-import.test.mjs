import assert from 'node:assert/strict';
import { getCatalogImportStatus, startCatalogImport } from '../src/pagehouse-import.js';

const batches = [];
const searches = [];
const started = startCatalogImport({
  limit: 1,
  disabledSources: ['libgen', 'archive', 'gutenberg', 'openstax', 'libretexts', 'memoryoftheworld', 'royallib', 'zlibrary', 'annas'],
  search: async (source, query) => {
    searches.push({ source, query });
    return [{ title: 'Review-only result', author: 'A. Writer', pageUrl: 'https://example.org/book', coverUrl: 'https://example.org/cover.jpg' }];
  },
  importBatch: async items => {
    batches.push(items);
    return { inserted: items.length, updated: 0, unchanged: 0 };
  },
});
assert.equal(started.status, 'running');
assert.equal(started.limit, 1);
assert.deepEqual(started.sources, ['mobilism']);
assert.equal(startCatalogImport({
  limit: 1,
  search: async () => [],
  importBatch: async () => ({ inserted: 0, updated: 0, unchanged: 0 }),
}).reused, true, 'manual and scheduled invocations reuse a run already in progress');

for (let i = 0; i < 50 && getCatalogImportStatus().status === 'running'; i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
const status = getCatalogImportStatus();
assert.equal(status.status, 'completed');
assert.equal(status.received, 1);
assert.equal(status.inserted, 1);
assert.equal(searches.length, 1);
assert.equal(batches[0][0].sourceId, 'mobilism');
assert.equal(batches[0][0].rightsStatus, 'approved');
assert.equal(batches[0][0].fileStatus, 'ready');
assert.equal(batches[0][0].coverUrl, 'https://example.org/cover.jpg');

assert.throws(() => startCatalogImport({ limit: 5001, search: async () => [], importBatch: async () => ({}) }), /limit must be between/);
assert.throws(() => startCatalogImport({ disabledSources: ['libgen', 'archive', 'gutenberg', 'openstax', 'libretexts', 'memoryoftheworld', 'royallib', 'zlibrary', 'annas', 'mobilism'], search: async () => [], importBatch: async () => ({}) }), /All e-book sources/);

const chunkSizes = [];
const capped = startCatalogImport({
  limit: 501,
  disabledSources: ['libgen', 'archive', 'gutenberg', 'openstax', 'libretexts', 'memoryoftheworld', 'royallib', 'zlibrary', 'annas'],
  search: async () => Array.from({ length: 600 }, (_, i) => ({ title: `Book ${i}`, pageUrl: `https://example.org/book/${i}` })),
  importBatch: async items => {
    chunkSizes.push(items.length);
    return { inserted: items.length, updated: 0, unchanged: 0 };
  },
});
assert.equal(capped.limit, 501);
for (let i = 0; i < 100 && getCatalogImportStatus().status === 'running'; i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.equal(getCatalogImportStatus().status, 'completed');
assert.equal(getCatalogImportStatus().received, 501, 'a run never exceeds its requested cap');
assert.deepEqual(chunkSizes, [500, 1], 'catalog batches stay within the API limit');

startCatalogImport({
  limit: 1,
  disabledSources: ['libgen', 'gutenberg', 'openstax', 'libretexts', 'memoryoftheworld', 'royallib', 'zlibrary', 'annas'],
  search: async source => {
    if (source === 'archive') throw new Error('source unavailable');
    return [{ title: 'Result despite another source failure', pageUrl: 'https://example.org/result' }];
  },
  importBatch: async items => ({ inserted: items.length, updated: 0, unchanged: 0 }),
});
for (let i = 0; i < 100 && getCatalogImportStatus().status === 'running'; i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.equal(getCatalogImportStatus().status, 'completed', 'one unavailable source does not fail the whole run');
assert.equal(getCatalogImportStatus().errors.length, 1, 'source failures are surfaced in run status');
console.log('Pagehouse scheduled catalog import: ok');
