import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-delivery-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
process.env.PAGEHOUSE_FILES_DIR = path.join(root, 'private-files');
process.env.PAGEHOUSE_TOKEN_SECRET = 'test-only-token-key-with-32-bytes-minimum';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_local';
fs.mkdirSync(process.env.PAGEHOUSE_FILES_DIR, { recursive: true });

const catalog = await import('../src/pagehouse.js');
const delivery = await import('../src/pagehouse-delivery.js');
const payments = await import('../src/pagehouse-payments.js');
catalog.saveRightsPolicy({
  license: 'CC BY 4.0', rightsScope: 'commercial redistribution',
  rightsEvidence: 'Test fixture license', confirmUniversalRights: true,
});
catalog.saveSourceLicence('gutenberg', { licensor: 'Test Press', licence: 'Test agreement', rightsScope: 'Test scope', evidence: 'Test fixture', permitsSale: true, permitsRedistribution: true, confirm: true });
catalog.importBooks([{
  sourceId: 'gutenberg', sourceRef: 'https://www.gutenberg.org/ebooks/1', sourceName: 'Project Gutenberg',
  title: 'Delivery fixture', authors: 'A Writer', format: 'pdf', license: 'CC BY 4.0',
  rightsStatus: 'approved', rightsScope: 'commercial redistribution', rightsEvidence: 'Test fixture license',
  fileStatus: 'metadata_only', fileKey: '',
}]);
const id = catalog.searchCatalog({ q: 'Delivery fixture' }).items[0].id;
const bytes = Buffer.from('%PDF-1.7\nfixture book');
const resolver = async () => ({ url: 'https://www.gutenberg.org/books/1.pdf', format: 'pdf', hosts: ['gutenberg.org'] });
const response = (data, headers = {}) => new Response(data, { headers: { 'Content-Length': String(data.length), ...headers } });

try {
  // The background checker's queue (it used to throw "datatype mismatch": the LIMIT value was never passed).
  assert.deepEqual(delivery.candidateIds({ limit: 5 }), [id], 'an unchecked open-source book is queued for checking');
  const checked = await delivery.checkBook(id, {
    resolver,
    fetcher: async (url, init, options) => {
      assert.equal(url, 'https://www.gutenberg.org/books/1.pdf');
      assert.deepEqual(options.allowedHosts, ['gutenberg.org']);
      assert.match(init.headers.Range, /^bytes=0-/);
      return response(bytes, { 'Content-Type': 'application/pdf' });
    },
  });
  assert.equal(checked.status, 'ready');
  assert.equal(catalog.db.prepare('SELECT file_status FROM catalog_books WHERE id=?').get(id).file_status, 'ready');
  assert.equal(catalog.db.prepare('SELECT size FROM store_download_checks WHERE book_id=?').get(id).size, bytes.length);
  assert.equal(delivery.deliveryStats().sources[0].ready, 1);

  const orderId = '12345678-1234-1234-1234-123456789abc';
  const orderReference = `PH-${'c'.repeat(36)}`;
  const expiresAt = new Date(Date.now() + 864e5).toISOString();
  catalog.db.prepare(`INSERT INTO store_orders(id,reference,idempotency_key,email,amount_minor,currency,status,created_at)
    VALUES(?,?,?,?,500,'GHS','paid',?)`).run(orderId, orderReference, 'delivery-resume-test-key', 'reader@example.test', new Date().toISOString());
  catalog.db.prepare(`INSERT INTO store_order_items(order_id,book_id,title_snapshot,price_minor,file_key_snapshot,
    source_id_snapshot,source_ref_snapshot,format_snapshot,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(orderId, id, 'Delivery fixture', 500, '', 'gutenberg', 'https://www.gutenberg.org/ebooks/1', 'pdf', expiresAt);
  const purchase = payments.getOrderForBuyer(orderReference, 'reader@example.test');
  const token = purchase.items[0].downloadUrl.split('/').pop();
  const paidGrant = payments.getDownloadGrant(token);
  assert.ok(paidGrant);
  assert.equal(payments.reserveDownload(paidGrant), true);
  assert.equal(payments.reserveDownload(paidGrant), true, 'an incomplete transfer resumes within the hour');
  assert.equal(catalog.db.prepare('SELECT download_count FROM store_order_items WHERE order_id=?').get(orderId).download_count, 1);
  payments.completeRemoteDownload(paidGrant);
  assert.equal(payments.reserveDownload(paidGrant), true, 'a completed transfer starts a new use');
  assert.equal(catalog.db.prepare('SELECT download_count FROM store_order_items WHERE order_id=?').get(orderId).download_count, 2);

  const grant = {
    ...paidGrant,
    title: 'Delivery fixture', sourceId: 'gutenberg', sourceRef: 'https://www.gutenberg.org/ebooks/1', format: 'pdf',
  };
  const outgoing = new PassThrough();
  outgoing.writeHead = (statusCode, headers) => { outgoing.statusCode = statusCode; outgoing.headers = headers; };
  let reserved = 0, completed = 0;
  const streamed = await delivery.streamBook(grant, { headers: {} }, outgoing, {
    reserveDownload: () => { reserved++; return true; },
    completeRemoteDownload: () => { completed++; },
  }, async () => response(bytes, { 'Content-Type': 'application/pdf' }), resolver);
  const delivered = [];
  for await (const chunk of outgoing) delivered.push(chunk);
  assert.deepEqual(Buffer.concat(delivered), bytes);
  assert.equal(outgoing.statusCode, 200);
  assert.equal(reserved, 1);
  assert.equal(completed, 1);
  assert.equal(streamed.streamed, true);

  // An EPUB source file is automatically converted to PDF before delivery.
  const epubResolver = async () => ({ url: 'https://www.gutenberg.org/ebooks/1.epub3.images', format: 'epub', hosts: ['gutenberg.org'] });
  const fakeEpubZip = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]);
  const epubOut = new PassThrough();
  epubOut.writeHead = (statusCode, headers) => { epubOut.statusCode = statusCode; epubOut.headers = headers; };
  const epubStreamed = await delivery.streamBook({ ...grant, format: 'epub' }, { headers: {} }, epubOut, {
    reserveDownload: () => true,
    completeRemoteDownload() {},
  }, async () => response(fakeEpubZip, { 'Content-Type': 'application/epub+zip' }), epubResolver);
  const epubDelivered = [];
  for await (const chunk of epubOut) epubDelivered.push(chunk);
  const pdfResult = Buffer.concat(epubDelivered);
  assert.equal(epubOut.statusCode, 200);
  assert.equal(epubOut.headers['Content-Type'], 'application/pdf');
  assert.match(epubOut.headers['Content-Disposition'], /\.pdf"/);
  assert.equal(pdfResult.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(epubStreamed.streamed, true);

  catalog.db.prepare("UPDATE catalog_books SET file_status='ready' WHERE id=?").run(id);
  const blocked = new PassThrough();
  blocked.writeHead = () => { throw new Error('an error page must not be sent'); };
  reserved = 0;
  const invalid = await delivery.streamBook(grant, { headers: {} }, blocked, {
    reserveDownload: () => { reserved++; return true; },
    completeRemoteDownload() {},
  }, async () => response(Buffer.from('<html>Sign in</html>'), { 'Content-Type': 'text/html' }), resolver);
  assert.equal(invalid.statusCode, 502);
  assert.equal(reserved, 0, 'an HTML/login response does not use a download');
  assert.equal(catalog.db.prepare('SELECT file_status FROM catalog_books WHERE id=?').get(id).file_status, 'queued');
  assert.equal(catalog.db.prepare('SELECT download_count FROM store_order_items WHERE order_id=?').get(orderId).download_count, 2);

  assert.equal(delivery.deliveryStats().sources[0].licensed, true);
  assert.equal(delivery.deliveryStats().sources[0].ready, 1);
  assert.equal(delivery.deliveryStats().sources[0].not_for_sale, 0);
  assert.equal(delivery.bookRightsReady({ rights_status: 'approved', status: 'listed', license: 'x', rights_scope: 'x', rights_evidence: 'x' }), false, 'a row without its source never passes');
  assert.equal(delivery.fileSignatureOk('pdf', Buffer.from('<html>')), false);

  const { resolveCatalogBook } = await import('../src/sources.js');
  for (const src of ['gutenberg', 'archive', 'internet-archive', 'openstax', 'libretexts', 'memoryoftheworld', 'memory-of-the-world', 'libgen', 'library-genesis', 'annas', 'anna-s-archive', 'royallib', 'zlibrary', 'z-library']) {
    assert.equal(delivery.isSupportedSource(src), true, `${src} is a supported delivery source`);
  }
  assert.deepEqual(await delivery.resolveBook({
    source_id: 'gutenberg', source_ref: 'https://www.gutenberg.org/ebooks/1513', format: 'epub',
  }, resolveCatalogBook), {
    url: 'https://www.gutenberg.org/ebooks/1513.epub3.images', format: 'epub', size: 0, hosts: ['gutenberg.org'],
  });
  assert.deepEqual(await delivery.resolveBook({
    source_id: 'libretexts',
    source_ref: 'https://bio.libretexts.org/Bookshelves/Agriculture_and_Horticulture/Crop_Genetics_(Suza_and_Lamkey)',
    cover_url: 'https://bio.libretexts.org/@api/deki/pages/106358/files/=mindtouch.page%2523thumbnail',
    format: 'pdf',
  }, resolveCatalogBook), {
    url: 'https://downloads.libretexts.org/api/v1/download/bio-106358/pdf', format: 'pdf', size: 0,
    hosts: ['libretexts.org', 'commons.libretexts.org', 'batch.libretexts.org', 'downloads.libretexts.org'],
  });
  assert.deepEqual(await delivery.resolveBook({
    source_id: 'memoryoftheworld',
    source_ref: 'https://library.memoryoftheworld.org/files/anybody/Author/Book/Book.pdf',
    format: 'pdf',
  }, resolveCatalogBook), {
    url: 'https://library.memoryoftheworld.org/files/anybody/Author/Book/Book.pdf', format: 'pdf', size: 0,
    hosts: ['memoryoftheworld.org'],
  });
  assert.deepEqual(await delivery.resolveBook({
    source_id: 'openstax',
    source_ref: 'https://assets.openstax.org/oscms-prodcms/media/documents/Psychology2e_WEB.pdf',
    format: 'pdf',
  }, resolveCatalogBook), {
    url: 'https://assets.openstax.org/oscms-prodcms/media/documents/Psychology2e_WEB.pdf', format: 'pdf', size: 0,
    hosts: ['openstax.org', 'assets.openstax.org'],
  });
  assert.deepEqual(await delivery.resolveBook({
    source_id: 'royallib',
    source_ref: 'https://royallib.com/get/epub/author/book.zip',
    format: 'epub',
  }, resolveCatalogBook), {
    url: 'https://royallib.com/get/epub/author/book.zip', format: 'zip', size: 0,
    hosts: ['royallib.com'],
  });
  assert.equal(catalog.sourceLicensed('library-genesis'), true, 'legacy slug alias is ready for sale');

  console.log('Pagehouse streamed delivery and rights gates: ok');
} finally {
  catalog.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
