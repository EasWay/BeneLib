import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REF = /^PH-[a-f0-9]{36}$/;
const DEFAULT_SECRET = 'sk_test_pagehouse_simulator_only';
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const html = (res, status, content) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(content);
};
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function bodyJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32 * 1024) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON request'); }
}

function requestAuthorized(req, secret) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createPaystackSimulator({
  port = 8788,
  apiSecret = DEFAULT_SECRET,
  webhookSecret = '',
  webhookUrl = 'http://127.0.0.1:8080/webhooks/paystack',
  publicUrl = '',
  callbackUrl = '',
  fetchImpl = fetch,
} = {}) {
  const transactions = new Map();
  // Only send the browser back to a page on this machine or the configured callbackUrl.
  const configuredCallbackHost = (() => { try { return callbackUrl ? new URL(callbackUrl).host : ''; } catch { return ''; } })();
  const localUrl = value => {
    try {
      const u = new URL(value);
      if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return u.href;
      if (configuredCallbackHost && (u.protocol === 'https:' || u.protocol === 'http:') && u.host === configuredCallbackHost) return u.href;
      return '';
    } catch { return ''; }
  };
  const backTo = t => { if (!t.callback) return ''; const u = new URL(t.callback); u.searchParams.set('trxref', t.reference); u.searchParams.set('reference', t.reference); return u.href; };
  const baseUrl = () => publicUrl || `http://127.0.0.1:${server.address()?.port || port}`;

  async function sendWebhook(transaction) {
    const event = {
      event: transaction.status === 'success' ? 'charge.success' : 'charge.failed',
      data: { reference: transaction.reference, status: transaction.status, amount: transaction.amount, currency: transaction.currency },
    };
    const raw = JSON.stringify(event);
    const headers = { 'Content-Type': 'application/json' };
    if (webhookSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = crypto.createHmac('sha512', webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
      headers['Paystack-Signature'] = `t=${timestamp},v1=${signature}`;
    } else {
      headers['x-paystack-signature'] = crypto.createHmac('sha512', apiSecret).update(raw).digest('hex');
    }
    try {
      const response = await fetchImpl(webhookUrl, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(5000) });
      return { delivered: response.ok, status: response.status };
    } catch (error) {
      return { delivered: false, error: String(error.message || error).slice(0, 200) };
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    let match;
    try {
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });

      if (req.method === 'POST' && ['/transaction/initialize', '/charge'].includes(url.pathname)) {
        if (!requestAuthorized(req, apiSecret)) return json(res, 401, { status: false, message: 'Invalid simulator secret' });
        const body = await bodyJson(req);
        const reference = String(body.reference || '');
        if (!REF.test(reference) || !Number.isSafeInteger(body.amount) || body.amount < 1 || body.currency !== 'GHS') {
          return json(res, 400, { status: false, message: 'Invalid transaction request' });
        }
        const mobile = url.pathname === '/charge';
        const transaction = {
          reference, amount: body.amount, currency: body.currency, status: mobile ? 'pending' : 'pending',
          channel: mobile ? 'momo' : 'card', email: String(body.email || '').slice(0, 254), createdAt: Date.now(),
          ...(mobile ? { phone: String(body.mobile_money?.phone || '').slice(0, 20), provider: String(body.mobile_money?.provider || '').slice(0, 5) } : {}),
          // Like Paystack: the request's callback_url wins, then the default set for the "dashboard".
          callback: localUrl(body.callback_url) || localUrl(callbackUrl) || '',
        };
        transactions.set(reference, transaction);
        const destination = `${baseUrl()}/${mobile ? 'phone' : 'pay'}/${reference}`;
        return json(res, 200, { status: true, data: mobile
          ? { reference, status: 'pending', display_text: `Open the local phone approval page: ${destination}` }
          : { authorization_url: destination, reference, access_code: crypto.randomBytes(12).toString('hex') } });
      }

      if (req.method === 'GET' && (match = url.pathname.match(/^\/transaction\/verify\/(PH-[a-f0-9]{36})$/))) {
        if (!requestAuthorized(req, apiSecret)) return json(res, 401, { status: false, message: 'Invalid simulator secret' });
        const transaction = transactions.get(match[1]);
        if (!transaction) return json(res, 404, { status: false, message: 'Transaction not found' });
        return json(res, 200, { status: true, data: { ...transaction } });
      }

      // The "phone": every MoMo prompt waiting for approval, refreshed every 2 seconds. Keep it open in a tab.
      if (req.method === 'GET' && url.pathname === '/phone') {
        const waiting = [...transactions.values()].filter(t => t.channel === 'momo' && t.status === 'pending').reverse();
        const rows = waiting.map(t => `<section><p><b>GHS ${(t.amount / 100).toFixed(2)}</b> to Pagehouse<br><small>${esc(t.phone)} · ${esc(t.provider.toUpperCase())} · ${esc(t.email)}</small></p><form method="post" action="/sim/settle/${t.reference}"><button name="status" value="success">Approve</button><button name="status" value="failed">Decline</button></form></section>`).join('');
        return html(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="2"><title>MoMo phone (simulator)</title><style>body{font:16px system-ui;background:#14201a;color:#fff;margin:0;padding:24px}main{max-width:380px;margin:4vh auto}section{background:#fff;color:#14201a;border-radius:16px;padding:16px 18px;margin:12px 0}button{padding:12px 16px;margin:4px 8px 0 0;border-radius:999px;border:0;cursor:pointer}button[value=success]{background:#1e4a38;color:#fff}</style><main><h1>MoMo phone</h1><p><small>Simulator. No PIN, no real money.</small></p>${rows || '<p>No payment prompts. Pay with Mobile Money in Pagehouse and it appears here.</p>'}</main>`);
      }

      if (req.method === 'GET' && (match = url.pathname.match(/^\/(pay|phone)\/(PH-[a-f0-9]{36})$/))) {
        const transaction = transactions.get(match[2]);
        if (!transaction || (match[1] === 'phone' && transaction.channel !== 'momo') || (match[1] === 'pay' && transaction.channel !== 'card')) {
          return html(res, 404, '<h1>Transaction not found</h1>');
        }
        const method = match[1] === 'phone' ? 'Mobile Money' : 'Card';
        const body = `<main><h1>Local Paystack simulator</h1><p>${method} checkout for ${esc(transaction.email)}</p><p>Amount: GHS ${(transaction.amount / 100).toFixed(2)}</p><p>Status: ${esc(transaction.status)}</p>${transaction.status === 'pending'
          ? `<form method="post" action="/sim/settle/${transaction.reference}"><button name="status" value="success">Approve ${method} payment</button><button name="status" value="failed">Decline payment</button></form>`
          : '<p>Payment decision saved. Return to the Pagehouse checkout.</p>'}<p><small>This local simulator does not collect card or mobile-money credentials.</small></p></main>`;
        return html(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local Paystack simulator</title><style>body{font:16px system-ui;background:#f4f1eb;color:#25251f;margin:0;padding:24px}main{max-width:560px;margin:8vh auto;background:white;padding:28px;border-radius:12px}button{padding:12px 16px;margin:8px 8px 8px 0;cursor:pointer}</style>${body}`);
      }

      if (req.method === 'POST' && (match = url.pathname.match(/^\/sim\/settle\/(PH-[a-f0-9]{36})$/))) {
        const transaction = transactions.get(match[1]);
        if (!transaction) return json(res, 404, { error: 'Transaction not found' });
        let body;
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/x-www-form-urlencoded')) {
          const text = await new Promise((resolve, reject) => {
            let value = '';
            req.setEncoding('utf8');
            req.on('data', chunk => { value += chunk; if (value.length > 2000) reject(new Error('Request is too large')); });
            req.on('end', () => resolve(value));
            req.on('error', reject);
          });
          body = Object.fromEntries(new URLSearchParams(text));
        } else body = await bodyJson(req);
        if (!['success', 'failed'].includes(body.status)) return json(res, 400, { error: 'status must be success or failed' });
        transaction.status = body.status;
        transaction.settledAt = Date.now();
        const webhook = await sendWebhook(transaction);
        if (type.includes('application/x-www-form-urlencoded')) {
          if (transaction.channel === 'card' && backTo(transaction)) { res.writeHead(303, { Location: backTo(transaction), 'Cache-Control': 'no-store' }); return res.end(); }
          if (transaction.channel === 'momo') { res.writeHead(303, { Location: '/phone', 'Cache-Control': 'no-store' }); return res.end(); }
          return html(res, 200, `<!doctype html><meta charset="utf-8"><title>Payment decision</title><main><h1>${body.status === 'success' ? 'Payment approved' : 'Payment declined'}</h1><p>${webhook.delivered ? 'Signed webhook delivered.' : `Webhook not delivered: ${esc(webhook.error || webhook.status)}`}</p><p>You can return to Pagehouse.</p></main>`);
        }
        return json(res, 200, { status: transaction.status, webhook });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, 400, { error: String(error.message || error).slice(0, 200) });
    }
  });

  return { server, transactions, webhookUrl };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const port = Number(process.env.PAYSTACK_SIM_PORT) || 8788;
  const simulator = createPaystackSimulator({
    port,
    apiSecret: process.env.PAYSTACK_SECRET_KEY || DEFAULT_SECRET,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || '',
    webhookUrl: process.env.PAYSTACK_SIM_WEBHOOK_URL || `${process.env.PAGEHOUSE_PUBLIC_URL || 'http://localhost:8081'}/webhooks/paystack`,
    publicUrl: process.env.PAYSTACK_SIM_PUBLIC_URL || `http://localhost:${port}`,
    callbackUrl: process.env.PAGEHOUSE_CALLBACK_URL || `${process.env.PAGEHOUSE_PUBLIC_URL || 'http://localhost:8081'}/#checkout`,
  });
  simulator.server.listen(port, '127.0.0.1', () => console.info(`Local Paystack simulator on http://localhost:${port} · MoMo phone: http://localhost:${port}/phone · webhooks to ${simulator.webhookUrl}`));
}
