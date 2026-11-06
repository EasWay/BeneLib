import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagehouse-import-cli-'));
const seen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    seen.push({ path: req.url, method: req.method, cookie: req.headers.cookie || '', body });
    if (req.url === '/api/login') {
      res.writeHead(200, { 'Set-Cookie': 'session=admin-session; Path=/' }).end('{"ok":true}');
      return;
    }
    if (req.url === '/api/store/admin/catalog/import-run' && req.method === 'POST') {
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        id: 'test-run', status: 'completed', received: 4, inserted: 2, updated: 1, unchanged: 1, errors: [],
      }));
      return;
    }
    res.writeHead(404).end('{}');
  });
});

const run = env => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/pagehouse-import.mjs'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr }));
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const openRun = await run({ PAGEHOUSE_IMPORT_URL: base });
  assert.equal(openRun.code, 0, openRun.stderr);
  assert.match(openRun.stdout, /4 results; 2 new/);
  assert.deepEqual(JSON.parse(seen.at(-1).body), { limit: 5000 });

  const credentials = path.join(root, 'credentials');
  fs.writeFileSync(credentials, 'PAGEHOUSE_ADMIN_USERNAME=admin\nPAGEHOUSE_ADMIN_PASSWORD=secret\n', { mode: 0o600 });
  const signedRun = await run({ PAGEHOUSE_IMPORT_URL: base, PAGEHOUSE_IMPORT_ENV_FILE: credentials });
  assert.equal(signedRun.code, 0, signedRun.stderr);
  assert.equal(seen.at(-2).path, '/api/login');
  assert.equal(JSON.parse(seen.at(-2).body).username, 'admin');
  assert.equal(seen.at(-1).cookie, 'session=admin-session');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { limit: 5000 });
  console.log('Pagehouse import CLI: ok');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
