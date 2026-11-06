import fs from 'node:fs';
import path from 'node:path';

const readCredentialFile = file => {
  if (!file) return {};
  if (!path.isAbsolute(file)) throw new Error('PAGEHOUSE_IMPORT_ENV_FILE must be an absolute path');
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new Error('Import credential file must be accessible only to its owner (chmod 600)');
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(PAGEHOUSE_ADMIN_USERNAME|PAGEHOUSE_ADMIN_PASSWORD)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
};

const fileCredentials = readCredentialFile(process.env.PAGEHOUSE_IMPORT_ENV_FILE || '');
const credentials = {
  PAGEHOUSE_ADMIN_USERNAME: process.env.PAGEHOUSE_ADMIN_USERNAME ?? fileCredentials.PAGEHOUSE_ADMIN_USERNAME,
  PAGEHOUSE_ADMIN_PASSWORD: process.env.PAGEHOUSE_ADMIN_PASSWORD ?? fileCredentials.PAGEHOUSE_ADMIN_PASSWORD,
};
const username = credentials.PAGEHOUSE_ADMIN_USERNAME || '';
const password = credentials.PAGEHOUSE_ADMIN_PASSWORD || '';
if (!!username !== !!password) throw new Error('Set both PAGEHOUSE_ADMIN_USERNAME and PAGEHOUSE_ADMIN_PASSWORD, or neither');

const base = new URL(process.env.PAGEHOUSE_IMPORT_URL || 'http://127.0.0.1:8080');
if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error('PAGEHOUSE_IMPORT_URL must be an HTTP(S) URL without embedded credentials');
const origin = base.origin;
const request = async (route, { method = 'GET', body, cookie = '' } = {}) => {
  const response = await fetch(new URL(route, origin), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status} from ${route}`);
  return { payload, response };
};

let cookie = '';
if (username) {
  const { response } = await request('/api/login', { method: 'POST', body: { username, password } });
  cookie = String(response.headers.get('set-cookie') || '').split(';', 1)[0];
  if (!cookie) throw new Error('Admin login succeeded but no session cookie was returned');
}

const { payload: started } = await request('/api/store/admin/catalog/import-run', {
  method: 'POST', body: { limit: 5000 }, cookie,
});
if (!started.id || !['running', 'completed'].includes(started.status)) throw new Error('Server returned an invalid import status');

let status = started;
while (status.status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 10000));
  ({ payload: status } = await request('/api/store/admin/catalog/import-run', { cookie }));
  if (status.id !== started.id) throw new Error('The active import changed while this client was monitoring it');
}
if (status.status !== 'completed') throw new Error(status.error || `Import finished with status "${status.status}"`);
console.log(`Catalog import complete: ${status.received} results; ${status.inserted} new, ${status.updated} updated, ${status.unchanged} unchanged; ${status.errors.length} source search errors.`);
if (status.errors.length) {
  for (const error of status.errors.slice(0, 5)) console.error(`${error.source}: ${error.message}`);
  process.exitCode = 1;
}
