import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-requests-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.PAGEHOUSE_DB_PATH = path.join(root, 'data', 'catalog.sqlite');
process.env.PAGEHOUSE_FILES_DIR = path.join(root, 'private-files');
process.env.PAGEHOUSE_TOKEN_SECRET = 'test-only-token-key-with-32-bytes-minimum';
const catalog = await import('../src/pagehouse.js');
await import('../src/pagehouse-payments.js');
const requests = await import('../src/pagehouse-requests.js');
const { db } = catalog;
const DAY = 24 * 60 * 60 * 1000;

const book = (ref, title, authors, extra = {}) => ({
  sourceId: 'catalog', sourceRef: ref, sourceName: 'Catalog', title, authors,
  license: 'Test', rightsStatus: 'approved', rightsScope: 'test', rightsEvidence: 'fixture',
  priceMinor: 500, currency: 'GHS', fileStatus: 'ready', fileKey: `${ref}.pdf`, ...extra,
});

try {
  // Normalisation and similarity.
  assert.equal(requests.normalizeTitle('The Café of Lost Youth!'), 'cafe of lost youth');
  assert.equal(requests.titleSimilarity('The Book of Disquiet', 'Book of Disquiet'), 1);
  assert.ok(requests.titleSimilarity('Things Fall Apart', 'Things Fall Apartt') >= 0.8);
  assert.ok(requests.titleSimilarity('Things Fall Apart', 'Arrow of God') < 0.5);
  assert.ok(requests.catalogSurnames('Peter L. Berger, Thomas Luckmann').has('luckmann'));
  assert.ok(requests.catalogSurnames('Herbert, Frank').has('herbert'));

  // Validation.
  assert.throws(() => requests.createRequest({ name: 'Reader', title: '', author: 'X', email: 'a@b.co' }), /title/);
  assert.throws(() => requests.createRequest({ name: 'Reader', title: 'Book', author: '', email: 'a@b.co' }), /author/);
  assert.throws(() => requests.createRequest({ name: 'Reader', title: 'Book', author: 'X', email: 'nope' }), /email/);
  assert.throws(() => requests.createRequest({ title: 'Book', author: 'X', email: 'a@b.co' }), /your name/);
  assert.throws(() => requests.createRequest({ name: '   ', title: 'Book', author: 'X', email: 'a@b.co' }), /your name/);
  const bot = requests.createRequest({ title: 'Spam', author: 'Spam', email: 'bot@example.test', website: 'http://spam' });
  assert.match(bot.reference, /^RQ-/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_requests').get().n, 0, 'honeypot submissions are not stored');

  // Already on the shelves: matched on submission, subtitle and accents ignored.
  catalog.importBooks([book('afam', 'Things Fall Apart (African Writers Series)', 'Chinua Achebe')]);
  const instant = requests.createRequest({ title: 'things fall apart', author: 'Achebe', email: 'Reader@Example.test', name: 'Ama' });
  assert.equal(instant.status, 'matched');
  assert.equal(instant.book.title, 'Things Fall Apart (African Writers Series)');

  // Not yet available: stays open; asking again returns the same request.
  const open = requests.createRequest({ name: 'Reader', title: 'Arrow of God', author: 'Chinua Achebe', email: 'reader@example.test' });
  assert.equal(open.status, 'open');
  const again = requests.createRequest({ name: 'Reader', title: 'Arrow of God', author: 'C. Achebe', email: 'reader@example.test' });
  assert.equal(again.reference, open.reference);
  assert.equal(again.duplicate, true);

  // Status needs the matching email.
  assert.equal(requests.getRequestForRequester(open.reference, 'other@example.test'), null);
  assert.equal(requests.getRequestForRequester(open.reference, 'READER@example.test').title, 'Arrow of God');

  // Three open requests per email.
  requests.createRequest({ name: 'Reader', title: 'No Longer at Ease', author: 'Achebe', email: 'reader@example.test' });
  requests.createRequest({ name: 'Reader', title: 'Anthills of the Savannah', author: 'Achebe', email: 'reader@example.test' });
  assert.throws(() => requests.createRequest({ name: 'Reader', title: 'Girls at War', author: 'Achebe', email: 'reader@example.test' }), e => e.statusCode === 429);

  // Wrong author or a hidden book does not match.
  catalog.importBooks([book('arrow-wrong', 'Arrow of God', 'Someone Else'), book('arrow-pending', 'Arrow of God', 'Chinua Achebe', { status: 'hidden', sourceRef: 'arrow-pending' })]);
  assert.equal(requests.sweepRequests().matched, 0, 'wrong author or unpublished books do not match');

  // The nightly harvest publishes it: the sweep matches the open request.
  catalog.importBooks([book('arrow', 'Arrow of God', 'Chinua Achebe')]);
  const swept = requests.sweepRequests();
  assert.equal(swept.matched, 1);
  const matched = requests.getRequestForRequester(open.reference, 'reader@example.test');
  assert.equal(matched.status, 'matched');
  assert.equal(matched.book.title, 'Arrow of God');

  // Buying the matched book fulfils the request.
  const orderId = 'order-1';
  db.prepare("INSERT INTO store_orders(id,reference,idempotency_key,email,amount_minor,currency,status,created_at) VALUES(?,?,?,?,500,'GHS','paid',?)")
    .run(orderId, 'PH-' + '0'.repeat(36), 'idem-key-0000000001', 'reader@example.test', new Date().toISOString());
  db.prepare("INSERT INTO store_order_items(order_id,book_id,title_snapshot,price_minor,file_key_snapshot) VALUES(?,?,?,?,?)")
    .run(orderId, matched.book.id, 'Arrow of God', 500, 'arrow.pdf');
  assert.equal(requests.sweepRequests().fulfilled, 1);
  assert.equal(requests.getRequestForRequester(open.reference, 'reader@example.test').status, 'fulfilled');

  // Matched without purchase closes after 14 days; open expires after 30; both purge after 90 more.
  const later = Date.now() + 31 * DAY;
  const result = requests.sweepRequests(later);
  assert.equal(result.closed, 1, 'instant match closes after 14 days without purchase');
  assert.equal(result.expired, 2, 'unmatched requests expire after 30 days');
  assert.equal(requests.getRequestForRequester(instant.reference, 'reader@example.test').status, 'closed');
  // A free slot opens once requests expire.
  assert.equal(requests.createRequest({ name: 'Reader', title: 'Girls at War', author: 'Achebe', email: 'reader@example.test' }, later).status, 'open');
  assert.equal(requests.sweepRequests(later + 91 * DAY).purged, 3);

  // A withdrawn book sends its request back to open.
  const second = requests.createRequest({ name: 'Reader', title: 'Things Fall Apart', author: 'Achebe', email: 'second@example.test' });
  assert.equal(second.status, 'matched');
  catalog.importBooks([book('afam', 'Things Fall Apart (African Writers Series)', 'Chinua Achebe', { status: 'hidden' })]);
  const reopened = requests.sweepRequests();
  assert.equal(reopened.reopened, 1);
  assert.equal(requests.getRequestForRequester(second.reference, 'second@example.test').status, 'open');

  // Admin list and close.
  const list = requests.listRequests({ status: 'open' });
  assert.ok(list.items.some(r => r.reference === second.reference && r.email === 'second@example.test'));
  requests.closeRequest(list.items.find(r => r.reference === second.reference).id);
  assert.equal(requests.getRequestForRequester(second.reference, 'second@example.test').status, 'closed');

  // FTS syntax in user input is treated as text.
  assert.equal(requests.createRequest({ name: 'Reader', title: 'NEAR(" OR *', author: 'x" OR "y', email: 'fts@example.test' }).status, 'open');
  console.log('pagehouse requests tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
