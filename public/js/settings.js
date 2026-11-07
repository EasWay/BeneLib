// Settings: one page in sections, with a section index. Switches and choices save as soon as they change;
// the forms for logins, qBittorrent and the VPN have their own Save buttons.
import { $, $$, esc, api, icon, prefs, toast, sfx, copy, confirmBox, chevron, sw, segBtns, ago, size, plural, isPhone, anim, priv, patchHtml } from './ui.js';
import { app, bus, refreshSettings, refreshStatus, drawNav, isAdmin, login } from './app.js';
import { applyTemplate, TOKENS } from './rename.js';
import { openVerify } from './verify.js';

const SECTIONS = [
    ['libraries', 'Libraries', '#eeeae2'], ['access', 'Access', '#d5a58b'], ['searching', 'Searching', '#bd8f70'], ['saving', 'Saving to your devices', '#d6ba8e'],
    ['storage', 'Storage', '#a8c0b2'], ['notifications', 'Notifications', '#a76e52'], ['shelves', 'Shelves and names', '#e8c48a'], ['qbittorrent', 'qBittorrent', '#1e4a38'],
    ['vpn', 'VPN tunnel', '#597568'], ['privacy', 'Privacy and backup', '#8ea89a'], ['device', 'This browser', '#bfd2c5'], ['system', 'System', '#87958a'],
    ['catalog', 'Store catalogue', '#d6ba8e'],
];
// Settings (/settings) is everyone's own: this browser and their account. The admin panel (/admin) holds
// everything that runs the server: libraries, accounts and API keys, folders, qBittorrent, the VPN, backups.
let adminPage = false;
const sections = () => SECTIONS.filter(([id]) => id === 'catalog' ? adminPage : (id === 'device') !== adminPage);
const SRC_INFO = {
    libgen: ['eBooks · mirrors tried in order', '#a76e52'], archive: ['eBooks and audiobooks · lending items left out', '#8ea89a'], gutenberg: ['eBooks · public domain', '#8e6a35'],
    openstax: ['Free textbooks', '#87958a'], libretexts: ['Free textbooks and course pages', '#bfd2c5'], memoryoftheworld: ['eBooks', '#bd8f70'], royallib: ['eBooks', '#d6ba8e'],
    audiobookbay: ['Audiobooks · magnet links', '#597568'], librivox: ['Audiobooks · volunteer recordings', '#d5a58b'], audiobooksbee: ['Audiobooks · download pages', '#8ea89a'],
};
const STATE_TEXT = { ok: ['Answering', '#1e4a38'], slow: ['Slow on the last search', '#8e6a35'], error: ['Failed on the last search', '#a33b37'], needsHuman: ['Needs a human', '#8e6a35'], off: ['Switched off', '#87958a'], guest: ['Working as a guest', '#1e4a38'] };
const TOKEN_COLOURS = ['#8ea89a', '#d5a58b', '#87958a', '#e8c48a', '#bd8f70', '#a8c0b2', '#bfd2c5'];
const PILL_COLOURS = ['#d5a58b', '#8ea89a', '#87958a', '#a8c0b2', '#e8c48a', '#bd8f70', '#d6ba8e', '#bfd2c5'];

let root, S, libs, ui, onBus = [], tickTimer = null;
const sv = () => app.settings;

let catalogPolicy = { license: '', rightsScope: '', rightsEvidence: '' };
let catalogQueue = { items: [], total: 0, limit: 25, offset: 0 };
let catalogSelected = new Set();
let catalogEligibleTotal = 0;
let catalogAllEligibleSelected = false;
let catalogSelectAllBusy = false;
let catalogNotice = '';
let catalogError = '';
let catalogBackfillBusy = false;
let bookRequests = { items: [], total: 0, limit: 25, offset: 0, counts: {} };
let bookRequestFilter = 'open';
let emailStatus = null;
let emailBusy = false;
let catalogImportStatus = { status: 'idle' };
let catalogImportPolling = false;
let deliveryStatus = { sources: [], run: null };
let deliveryPolling = false;

export async function mount(el, { path } = {}) {
    root = el;
    adminPage = path === '/admin';
    catalogSelected.clear();
    catalogEligibleTotal = 0;
    catalogAllEligibleSelected = false;
    catalogSelectAllBusy = false;
    catalogNotice = '';
    // Not an admin: the panel asks for the admin sign-in first (in private mode without a password, everyone is).
    if (adminPage && !isAdmin()) return login({ asAdmin: true });
    ui = { libsOpen: false, vpnOpen: false, advOpen: false, linksKind: 'ebooks', pwOpen: false, newKey: null, keyLabel: false, folders: null, qbStatus: null, vpnBusy: false, update: null, conn: null, browser: null, tplFocus: 'ebookTemplate', catalogConfirmed: false };
    const listen = (t, fn) => { bus.addEventListener(t, fn); onBus.push([t, fn]); };
    listen('status', () => { drawSection('libraries', { live: true }); drawSection('vpn', { live: true }); });
    listen('vpn', () => drawSection('vpn', { live: true }));
    listen('status', () => { const el = $('#attn'); if (el) patchHtml(el, attnBar()); });
    listen('hash', e => { if (e.detail === '#attention') goAttention(); });
    libs = adminPage ? await api('/api/libraries').catch(() => null) : null;
    if (adminPage) await loadCatalogAdmin();
    draw();
    if (adminPage && catalogImportStatus.status === 'running') void pollCatalogImport();
    if (location.hash === '#attention') setTimeout(goAttention, 60);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('focusin', e => { if (e.target.dataset.tpl) ui.tplFocus = e.target.dataset.tpl; });
    if (adminPage) { checkFolders(); if (sv().qbit.enabled) testQbit(true); }
    // Keeps "Checked 12 seconds ago" honest.
    tickTimer = setInterval(() => { const c = $('#vpn-checked'); if (c && app.status && app.status.vpn.checkedAt) c.textContent = 'Checked ' + ago(app.status.vpn.checkedAt); }, 5000);
}
export function unmount() { for (const [t, fn] of onBus) bus.removeEventListener(t, fn); onBus = []; clearInterval(tickTimer); }
export function relayout() { draw(); }

function draw() {
    root.innerHTML = `<main class="page narrow">
        <h1 class="h-page">${adminPage ? 'Admin <span class="serif" style="color:var(--brass)">panel</span>' : 'Your <span class="serif" style="color:var(--brass)">settings</span>'}</h1>
        ${adminPage ? `<div id="attn">${attnBar()}</div>
        <nav class="sec-index hscroll" aria-label="Sections">${sections().map(([id, label, c]) => `<a href="/admin#${id}" style="background:${c}">${label}</a>`).join('')}</nav>` : ''}
        ${sections().map(([id]) => `<div id="sec-${id}" class="secwrap">${section(id)}</div>`).join('')}
        ${adminPage ? '<a class="btn outline lg" href="/settings" style="align-self:flex-start">Back to your settings</a>' : `<section class="sset adminlink"><div class="card rows">${row('Admin panel', isAdmin() ? 'Libraries, accounts and API keys, folders, qBittorrent, the VPN, backups and everything else that runs this server.' : 'For the person who runs this Quiet Chapters server: sign in as the admin to continue.', '<a class="btn yellow" href="/admin">Visit admin panel</a>')}</div></section>`}
        </main>
        <footer class="site"><a class="ph-lockup" href="/" aria-label="Quiet Chapters"><span class="ph-mark" aria-hidden="true">QC</span><span>Quiet Chapters</span></a>
        <span>Quiet Chapters · ${esc((app.status && app.status.version) || '')} · ${esc(location.host)}</span></footer>`;
}
// What the Settings badge counts, and where it lives on this page: a library card, the library list, or the VPN.
function attention() {
    const s = app.status || {}, n = (s.needs || [])[0];
    const cards = { annas: '.needcards .yellow', zlibrary: '[data-form="zlib"]', mobilism: '[data-form="mobilism"]' };
    if (n) return { label: n.name, sel: cards[n.id] || '#libs-list', open: !cards[n.id] };
    return s.attention ? { label: 'VPN tunnel', sel: '#vpn' } : null;
}
function attnBar() {
    const a = attention(), n = (app.status && app.status.attention) || 0;
    return a ? `<button type="button" class="attn" data-act="attention"><span class="nb" style="background:var(--coral)">${n}</span><span>${n === 1 ? 'One thing needs' : n + ' things need'} you: <b>${esc(a.label)}</b></span><span class="go">Take me there →</span></button>` : '';
}
function goAttention() {
    const a = attention(); if (!a) return;
    if (a.open && !ui.libsOpen) { ui.libsOpen = true; drawSection('libraries'); }
    const t = $(a.sel, root); if (!t) return;
    t.scrollIntoView({ behavior: prefs.motion ? 'smooth' : 'auto', block: 'center' });
    anim(t, [{ boxShadow: '0 0 0 0 rgba(255,138,101,0)' }, { boxShadow: '0 0 0 6px rgba(255,138,101,0.9)' }, { boxShadow: '0 0 0 0 rgba(255,138,101,0)' }], { duration: 1400, delay: 300 });
}
// Live status updates must not wipe a half-typed password, so a section being typed in waits.
function drawSection(id, { live = false } = {}) {
    const el = $('#sec-' + id); if (!el) return;
    const a = document.activeElement;
    if (live && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    // A live redraw only changes what differs, so open lists keep their place and do not replay their reveal.
    if (live) patchHtml(el, section(id)); else keepFocus(() => { el.innerHTML = section(id); });
}
// A redraw replaces the control that was pressed; the keyboard moves on to its replacement.
function keepFocus(redraw) {
    const a = document.activeElement;
    const sel = a && a !== document.body && root.contains(a) ? ['act', 'set', 'seg', 'src', 'local', 'id', 'v', 'catalogBook', 'catalogSelectAll', 'catalogConfirm'].filter(k => a.dataset[k] !== undefined).map(k => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join('') : '';
    redraw();
    if (!sel || a.isConnected) return;
    const n = $(sel, root); if (n && !n.disabled) n.focus({ preventScroll: true });
}
function section(id) { return ({ libraries, access, searching, saving, storage, notifications, shelves, qbittorrent, vpn, privacy, device, system, catalog })[id](); }

const row = (title, desc, control, extra = '') => `<div class="row"><div class="rt"><b>${title}</b>${desc ? `<span class="desc">${desc}</span>` : ''}${extra}</div>${control}</div>`;
const note = text => `<span class="note">${icon('info', 16, 2.2)}<span>${text}</span></span>`;
const swk = (key, on, label) => sw(on, label, `data-set="${key}"`);
const seg = (key, opts, value, label) => `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${segBtns(opts, value, `data-seg="${key}"`)}</div>`;
// On /settings the sections sit straight under the page title, so they are h2; in the admin panel they follow its h2s.
const head = (id, title, lede) => { const h = adminPage ? 'h3' : 'h2'; return `<section class="sset" id="${id}"><${h} class="h-sub">${title}</${h}>${lede || ''}`; };

async function loadCatalogAdmin({ policy = true } = {}) {
    catalogError = '';
    try {
        if (policy) catalogPolicy = await api('/api/store/admin/rights-policy');
        catalogImportStatus = await api('/api/store/admin/catalog/import-run');
        deliveryStatus = await api('/api/store/admin/delivery');
        const offset = catalogQueue.offset || 0;
        catalogQueue = await api(`/api/store/admin/catalog/pending-rights?limit=25&offset=${offset}`);
        catalogEligibleTotal = catalogQueue.eligibleTotal || 0;
        await loadBookRequests();
        emailStatus = await api('/api/store/admin/email');
        storePricing = await api('/api/store/admin/pricing');
        sourceLicences = await api('/api/store/admin/source-licences');
        const lastOffset = Math.max(0, Math.floor(Math.max(0, catalogQueue.total - 1) / catalogQueue.limit) * catalogQueue.limit);
        if (catalogQueue.offset > lastOffset) {
            catalogQueue = await api(`/api/store/admin/catalog/pending-rights?limit=25&offset=${lastOffset}`);
        }
    } catch (err) {
        catalogError = err.message || 'Could not load store catalogue administration';
    }
}

async function loadBookRequests() {
    bookRequests = await api(`/api/store/admin/requests?status=${encodeURIComponent(bookRequestFilter)}&limit=25&offset=${bookRequests.offset || 0}`);
    if (bookRequests.offset && bookRequests.offset >= bookRequests.total) { bookRequests.offset = 0; bookRequests = await api(`/api/store/admin/requests?status=${encodeURIComponent(bookRequestFilter)}&limit=25&offset=0`); }
}

async function refreshBookRequests() {
    try { await loadBookRequests(); } catch (err) { catalogError = err.message || 'Could not load book requests'; }
    drawSection('catalog');
}
let storePricing = null;
const cedis = minor => (minor / 100).toFixed(2);
function pricingCard() {
    if (!storePricing) return '';
    return `<form class="card rows" data-form="store-price">
            <h4 class="h-sub" style="margin:0">Book price</h4>
            <p class="desc">One price for every book. New checkouts use it straight away; paid orders keep what they paid.</p>
            <div class="btnrow" style="flex-wrap:wrap;align-items:flex-end">
                <label class="field" style="flex:1;min-width:180px">Price (GHS)<input class="input" name="price" type="number" inputmode="decimal" min="0.10" max="100000" step="0.01" required value="${cedis(storePricing.priceMinor)}"></label>
                <button class="btn yellow" type="submit">Save price</button>
            </div>
            <p class="desc">Now GHS ${cedis(storePricing.priceMinor)}${storePricing.updatedAt ? ` · changed ${esc(new Date(storePricing.updatedAt).toLocaleString())}` : ' · default'}</p>
        </form>`;
}
const EMAIL_KIND = { 'request-received': 'Request received', 'request-matched': 'Book found', 'request-expired': 'Request expired', 'owner-request': 'Owner alert', 'order-receipt': 'Order receipt', test: 'Test' };
let sourceLicences = { sources: [] };
let licenceOpen = '';
const LICENCE_STATUS = {
    approved: ['', 'Licensed'], unlicensed: ['bad', 'Not licensed'], revoked: ['bad', 'Revoked'],
    expired: ['bad', 'Expired'], incomplete: ['bad', 'Incomplete'],
};
function licenceForm(src) {
    const l = src.licence || {};
    const live = src.status === 'approved';
    return `<form class="rows" data-form="source-licence" data-source="${esc(src.sourceId)}" style="gap:10px;margin-top:6px">
        <label class="field">Licensor (rights holder or distributor)<input class="input" name="licensor" maxlength="200" required value="${esc(live ? l.licensor : '')}" placeholder="For example, Ingram Content Group"></label>
        <label class="field">Licence or agreement<input class="input" name="licence" maxlength="300" required value="${esc(live ? l.licence : '')}" placeholder="For example, eBook distribution agreement"></label>
        <label class="field">Agreement reference <span class="desc">(optional)</span><input class="input" name="agreementRef" maxlength="200" value="${esc(live ? l.agreementRef : '')}" placeholder="Contract or account number"></label>
        <label class="field">Rights scope<input class="input" name="rightsScope" maxlength="300" required value="${esc(live ? l.rightsScope : '')}" placeholder="Territories, formats, any limits"></label>
        <label class="field">Evidence<textarea class="input" name="evidence" maxlength="2000" required rows="3" placeholder="Where the signed agreement or licence terms are kept">${esc(live ? l.evidence : '')}</textarea></label>
        <label class="field">Expires <span class="desc">(optional)</span><input class="input" type="date" name="expiresAt" value="${esc(live && l.expiresAt ? l.expiresAt.slice(0, 10) : '')}"></label>
        <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" name="permitsSale" required style="width:20px;height:20px;flex:none" ${live ? 'checked' : ''}><span class="desc">Permits selling these books</span></label>
        <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" name="permitsRedistribution" required style="width:20px;height:20px;flex:none" ${live ? 'checked' : ''}><span class="desc">Permits delivering the files to buyers</span></label>
        <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" name="confirm" required style="width:20px;height:20px;flex:none"><span class="desc">I hold this licence for every book from ${esc(src.sourceName)}.</span></label>
        <div class="btnrow"><button class="btn yellow" type="submit">${live ? 'Save licence' : 'Approve licence'}</button><button class="btn outline-ink" type="button" data-act="licence-close">Cancel</button></div>
    </form>`;
}
function sourceLicencesCard() {
    const list = sourceLicences.sources || [];
    const rows = list.map(src => {
        const [cls, label] = LICENCE_STATUS[src.status] || ['bad', src.status];
        const l = src.licence;
        const detail = src.status === 'approved' && l
            ? `${esc(l.licensor)} · ${esc(l.licence)}${l.expiresAt ? ` · until ${esc(new Date(l.expiresAt).toLocaleDateString())}` : ''}`
            : src.status === 'expired' && l ? `Expired ${esc(new Date(l.expiresAt).toLocaleDateString())}`
            : src.status === 'revoked' && l ? `Revoked ${esc(new Date(l.revokedAt).toLocaleDateString())}` : 'Purchases blocked';
        return `<article class="card rows" style="gap:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
                <span><b>${esc(src.sourceName)}</b> <span class="desc">${src.books.toLocaleString()} books</span></span>
                <span class="status ${cls}" style="height:30px;font-size:13px"><span class="d"></span>${label}</span>
            </div>
            <span class="desc" style="overflow-wrap:anywhere">${detail}${src.status === 'approved' && !src.deliverable ? ' · No delivery route yet, so still not buyable' : ''}</span>
            ${licenceOpen === src.sourceId ? licenceForm(src) : `<div class="btnrow">
                <button type="button" class="btn outline-ink" data-act="licence-open" data-source="${esc(src.sourceId)}">${src.status === 'approved' ? 'Edit licence' : 'Add licence'}</button>
                ${src.status === 'approved' ? `<button type="button" class="btn outline-ink" data-act="licence-revoke" data-source="${esc(src.sourceId)}">Revoke</button>` : ''}
            </div>`}
        </article>`;
    }).join('');
    const live = list.filter(x => x.status === 'approved').length;
    return `<div class="card rows" style="margin-top:20px">
        <b>Source licences · ${live} of ${list.length} licensed</b>
        <p class="desc">Each source needs its own licence for sale and delivery. Books from an unlicensed, expired or revoked source cannot be bought or downloaded.</p>
        ${rows || '<p class="desc">No sources yet.</p>'}
    </div>`;
}
function deliveryCard() {
    const sources = deliveryStatus.sources || [];
    const run = deliveryStatus.run;
    return `<div class="card rows" style="margin-top:20px">
        <b>Delivery</b>
        <p class="desc">All books from supported sources are published and ready for sale. Files are streamed directly from the source, never saved here.</p>
        ${sources.length ? `<div class="rows" style="gap:8px">${sources.map(source => `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <b>${esc(source.source_name)}</b><span class="desc">${source.ready} ready · ${source.not_for_sale} not for sale · ${source.unavailable} unavailable</span>
        </div>`).join('')}</div>` : '<p class="desc">No catalog books yet.</p>'}
        ${run?.status === 'running' ? `<p class="desc" role="status">Check in progress · ${run.checked || 0} of ${run.total || 0} checked · ${run.ready || 0} ready · ${run.unavailable || 0} unavailable</p>` : run?.status === 'completed' ? `<p class="desc" role="status">Last check: ${run.checked} checked · ${run.ready} ready · ${run.unavailable} unavailable${run.errors ? ` · ${run.errors} need a retry` : ''}.</p>` : run?.status === 'failed' ? `<p class="desc" role="alert">Last check failed: ${esc(run.error || 'Unknown error')}</p>` : ''}
        <button type="button" class="btn outline-ink" data-act="delivery-check" ${run?.status === 'running' ? 'disabled' : ''}>${run?.status === 'running' ? 'Checking…' : 'Check now'}</button>
    </div>`;
}
function emailCard() {
    const e = emailStatus;
    if (!e) return '';
    const setup = e.configured
        ? `<p class="desc">Sending as <b>${esc(e.from)}</b> through ${esc(e.server)} · ${e.sentToday} of ${e.dailyLimit} sent today.${e.ownerAlerts ? ' Owner alerts are on.' : ' Set PAGEHOUSE_OWNER_EMAIL to get an email for each new request.'}${e.publicUrl ? '' : ' Set PAGEHOUSE_PUBLIC_URL so emails can link to the store and to downloads.'}</p>`
        : `<div class="banner coral" role="status">Emails are queued but not sent: ${esc(e.problem)}. Set the SMTP settings on the server (see .env.example) and restart it. Nothing queued is lost.</div>`;
    const recent = e.recent.length ? `<ul class="desc" style="margin:0;padding-left:18px;display:grid;gap:4px">${e.recent.map(m => `<li>${esc(EMAIL_KIND[m.kind] || m.kind)} to ${esc(m.to)} · <b>${esc(m.status)}</b>${m.attempts > 1 ? ` after ${m.attempts} tries` : ''}${m.error ? ` · ${esc(m.error)}` : ''}</li>`).join('')}</ul>` : '<p class="desc">No emails yet.</p>';
    return `<form class="card rows" data-form="email-test" style="margin-top:20px">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><b>Email</b><button type="button" class="btn outline-ink" data-act="email-refresh">Refresh</button></div>
                ${setup}
                <p class="desc">Customers get an email when their request is received, when the book is found, and when it expires unfound, plus a receipt with download links when they pay. ${e.counts.pending} waiting · ${e.counts.sent} sent · ${e.counts.failed} failed.</p>
                ${recent}
                <div class="btnrow" style="flex-wrap:wrap;align-items:flex-end">
                    <label class="field" style="flex:1;min-width:220px">Send a test to<input class="input" type="email" name="to" placeholder="you@example.com" autocomplete="email"></label>
                    <button class="btn yellow" type="submit" ${emailBusy ? 'disabled' : ''}>${emailBusy ? 'Sending…' : 'Send test email'}</button>
                    ${e.counts.failed ? `<button type="button" class="btn outline-ink" data-act="email-retry">Retry ${e.counts.failed} failed</button>` : ''}
                </div>
            </form>`;
}
const REQUEST_STATUS = { open: 'Looking', matched: 'Matched', fulfilled: 'Bought', closed: 'Closed', expired: 'Expired' };
function bookRequestsCard() {
    const c = bookRequests.counts || {};
    const tabs = [['open', 'Open'], ['matched', 'Matched'], ['fulfilled', 'Bought'], ['', 'All']]
        .map(([v, label]) => `<button type="button" class="btn ${bookRequestFilter === v ? 'yellow' : 'outline-ink'}" data-act="requests-filter" data-v="${v}" aria-pressed="${bookRequestFilter === v}">${label}${v ? ` (${c[v] || 0})` : ''}</button>`).join('');
    const items = bookRequests.items || [];
    const rows = items.length ? items.map(r => `<article class="card rows" style="gap:6px">
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><b>${esc(r.title)}</b><span class="desc">${esc(REQUEST_STATUS[r.status] || r.status)}</span></div>
            <span class="desc" style="overflow-wrap:anywhere">${esc(r.author)}${r.isbn ? ` · ISBN ${esc(r.isbn)}` : ''} · ${esc(r.name ? `${r.name} <${r.email}>` : r.email)} · ${esc(new Date(r.createdAt).toLocaleDateString())}</span>
            ${r.matchedTitle ? `<span class="desc">Matched to “${esc(r.matchedTitle)}”</span>` : ''}
            ${['open', 'matched'].includes(r.status) ? `<div><button type="button" class="btn outline-ink" data-act="requests-close" data-id="${esc(r.id)}">Close request</button></div>` : ''}
        </article>`).join('') : '<p class="desc">No requests here.</p>';
    const page = Math.floor((bookRequests.offset || 0) / (bookRequests.limit || 25)) + 1, pages = Math.max(1, Math.ceil((bookRequests.total || 0) / (bookRequests.limit || 25)));
    return `<div class="card rows" style="margin-top:20px">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><b>Book requests</b><button type="button" class="btn outline-ink" data-act="requests-sweep">Match now</button></div>
                <p class="desc">Titles customers asked for. Open requests are matched against published books every hour and after each approval, expire after 30 days, and close 14 days after a match if the book is not bought. Email notifications are not connected, so customers check status on the storefront.</p>
                <div class="btnrow" style="flex-wrap:wrap">${tabs}</div>
                ${rows}
                ${pages > 1 ? `<div style="display:flex;align-items:center;justify-content:center;gap:12px">
                    <button type="button" class="btn outline-ink" data-act="requests-prev" ${(bookRequests.offset || 0) <= 0 ? 'disabled' : ''}>Previous</button>
                    <span class="desc">Page ${page} of ${pages}</span>
                    <button type="button" class="btn outline-ink" data-act="requests-next" ${page >= pages ? 'disabled' : ''}>Next</button></div>` : ''}
            </div>`;
}

async function pollCatalogImport() {
    if (catalogImportPolling) return;
    catalogImportPolling = true;
    try {
        while (catalogImportStatus.status === 'running') {
            await new Promise(resolve => setTimeout(resolve, 2000));
            catalogImportStatus = await api('/api/store/admin/catalog/import-run');
            if ($('#sec-catalog')) drawSection('catalog');
        }
        if (catalogImportStatus.status === 'completed') {
            catalogNotice = `Source import finished: ${catalogImportStatus.received} results imported; ${catalogImportStatus.inserted} new, ${catalogImportStatus.updated} updated, ${catalogImportStatus.unchanged} unchanged. All titles are published and ready for sale.`;
            await loadCatalogAdmin({ policy: false });
        } else if (catalogImportStatus.status === 'failed') {
            catalogError = `Source import failed: ${catalogImportStatus.error || 'Unknown error'}`;
        }
    } catch (err) {
        catalogError = `Could not read source import status: ${err.message || 'request failed'}`;
    } finally {
        catalogImportPolling = false;
        if ($('#sec-catalog')) drawSection('catalog');
    }
}

async function pollDeliveryChecks() {
    if (deliveryPolling) return;
    deliveryPolling = true;
    try {
        while (deliveryStatus.run?.status === 'running') {
            await new Promise(resolve => setTimeout(resolve, 1500));
            deliveryStatus = await api('/api/store/admin/delivery');
            if ($('#sec-catalog')) drawSection('catalog');
        }
    } catch (err) {
        catalogError = `Could not read delivery-check status: ${err.message || 'request failed'}`;
    } finally {
        deliveryPolling = false;
        if ($('#sec-catalog')) drawSection('catalog');
    }
}

function catalog() {
    return head('catalog', 'Store catalogue', '<p class="lede" style="max-width:720px">Manage store pricing, automated source imports, delivery checks, customer requests, and covers.</p>') + `
        ${catalogError ? `<div class="banner coral" role="alert">${esc(catalogError)}</div>` : ''}
        ${catalogNotice ? `<div class="banner mint" role="status">${esc(catalogNotice)}</div>` : ''}
        ${pricingCard()}
        ${deliveryCard()}
        <section class="sset" style="margin-top:20px">
            <div class="card rows">
                <b>Automated source import</b>
                <p class="desc">Searches enabled e-book sources with rotating queries, up to 5,000 results per run. Imported books are automatically published, priced, and ready for sale.</p>
                ${catalogImportStatus.status === 'running' ? `<p class="desc" role="status">Import in progress · ${catalogImportStatus.received || 0} found · ${catalogImportStatus.inserted || 0} new · ${catalogImportStatus.updated || 0} updated · ${catalogImportStatus.queries || 0} queries</p>` : catalogImportStatus.status === 'completed' ? `<p class="desc" role="status">Last run: ${catalogImportStatus.received || 0} found · ${catalogImportStatus.inserted || 0} new · ${catalogImportStatus.updated || 0} updated · ${catalogImportStatus.unchanged || 0} unchanged.</p>` : catalogImportStatus.status === 'failed' ? `<p class="desc" role="alert">Last run failed: ${esc(catalogImportStatus.error || 'Unknown error')}</p>` : ''}
                ${catalogImportStatus.errors?.length ? `<div class="desc" role="alert">${catalogImportStatus.errors.length} source search error${catalogImportStatus.errors.length === 1 ? '' : 's'} in the last run:<ul>${catalogImportStatus.errors.slice(0, 5).map(error => `<li>${esc(error.source)}: ${esc(error.message)}</li>`).join('')}</ul></div>` : ''}
                <button type="button" class="btn outline-ink" data-act="catalog-import-run" ${catalogImportStatus.status === 'running' ? 'disabled' : ''}>${catalogImportStatus.status === 'running' ? 'Import running…' : 'Run source import now'}</button>
            </div>
            ${bookRequestsCard()}
            ${emailCard()}
            <div class="card rows" style="margin-top:20px">
                <b>Published book covers</b>
                <p class="desc">Look up missing covers in Open Library. Only exact title and author matches are saved, and existing covers are never replaced.</p>
                <button type="button" class="btn outline-ink" data-act="catalog-backfill-covers" ${catalogBackfillBusy ? 'disabled' : ''}>${catalogBackfillBusy ? 'Finding covers…' : 'Backfill missing covers'}</button>
            </div>
        </section></section>`;
}

// ── Libraries ────────────────────────────────────────────────────────────────
function libraries() {
    const st = (libs && libs.list) || [];
    const by = Object.fromEntries(st.map(l => [l.id, l]));
    const off = new Set(sv().sources.off);
    const answering = st.filter(l => !['annas', 'zlibrary', 'mobilism'].includes(l.id));
    const needYou = st.filter(l => ['needsHuman', 'error'].includes(l.state) || (l.id === 'mobilism' && !libs.mobilism.login)).length;
    const links = sv().justLinks.ebooks.length + sv().justLinks.audiobooks.length;
    const a = libs ? libs.annas : {}, z = libs ? libs.zlib : {}, m = libs ? libs.mobilism : {};
    const annasState = off.has('annas') ? 'Switched off' : a.needsVerify ? 'Needs a human' : 'Answering';
    const mirrorInfo = mirrorList('annas');
    const mirrors = mirrorInfo.length ? mirrorInfo.map(d => d.host) : ['annas-archive.gl', 'annas-archive.pk', 'annas-archive.gd'];
    const mirror = (a.mirror || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const order = mirror && mirrors.includes(mirror) ? [mirror, ...mirrors.filter(x => x !== mirror)] : mirrors;
    const cardSwitch = (src, label) => `<button type="button" class="switch" role="switch" aria-checked="${!off.has(src) && !(src === 'mobilism' && !m.login)}" aria-label="${label} on or off" data-src="${src}"></button>`;
    const zState = off.has('zlibrary') ? 'Switched off' : z.needsVerify ? 'Needs a human' : z.login ? (z.error ? 'Login failed' : 'Signed in') : 'Working as a guest';
    const mState = off.has('mobilism') ? 'Switched off' : !m.login ? 'Off, needs a free account' : m.error ? 'Login failed' : 'Signed in';
    return `<section class="sset" id="libraries" style="gap:10px">
        <h2 class="h-sec">Libraries</h2>
        <p class="lede" style="max-width:640px">Where Quiet Chapters looks when you search. These are third-party sites, so use them at your own risk. Your logins stay on this machine and are only ever sent to their own site.</p></section>
    <section aria-label="Needs attention" class="needcards" style="margin-top:20px">
        <div class="pastel yellow on-paper" style="box-shadow:0 20px 50px rgba(255,213,74,0.25)">
            <div class="ph"><span class="label" style="color:#6B4A00">${annasState}</span>${cardSwitch('annas', "Anna's Archive")}</div>
            <b class="name">Anna's Archive</b>
            <span class="desc" style="color:#4A3500">${a.needsVerify ? "It wants proof you're a person. Quiet Chapters won't solve that for you: open the server's browser here, pass the check yourself, and it's remembered." : 'Answering for now. If it starts asking for proof that you are a person, pass the check here and it is remembered.'}</span>
            ${a.browser === false ? '<span class="desc" style="color:#4A3500;font-weight:700">The background browser is not installed, so the check cannot be opened. Use the image with the browser, or install Chromium.</span>' : ''}
            <button type="button" class="btn dark" data-act="verify" ${a.browser === false ? ' disabled' : ''}>Open verification view</button>
            <span class="mirrors">${order.map((h, i) => { const st = (mirrorInfo.find(d => d.host === h) || {}).status; return `<span title="${st ? 'SLUM: ' + st : ''}"${st ? ` style="box-shadow:inset 0 0 0 2px ${MIRROR_COLOURS[st] || 'transparent'}"` : ''}>${i + 1} ${i ? '.' + h.split('.').pop() : esc(h)}</span>`; }).join('')}</span></div>
        <form class="pastel mint on-paper" data-form="zlib" autocomplete="off">
            <div class="ph"><span class="label" style="color:#0B5E43">${zState}</span>${cardSwitch('zlibrary', 'Z-Library')}</div>
            <b class="name">Z-Library</b>
            <span class="desc" style="color:#38463f">Works without an account. Add yours for faster searches and direct downloads, within your daily limit.</span>
            ${z.error ? `<span class="err" style="color:#8A2A12">${esc(z.error)}</span>` : ''}
            ${z.needsVerify ? `<span class="desc" style="color:#38463f">Its bot check wants proof you're a person. Pass it once in the server's browser and it's remembered.</span><button type="button" class="btn dark" data-act="verify" data-site="zlibrary"${a.browser === false ? ' disabled' : ''}>Open verification view</button>` : ''}
            <label class="field">Email<input class="input priv" type="email" name="email" value="${esc(z.email || '')}" autocomplete="off"></label>
            <label class="field">Password<input class="input" type="password" name="password" placeholder="${z.login ? 'Saved. Type to replace it.' : ''}" autocomplete="off"></label>
            <div class="btnrow"><button type="submit" class="btn dark" style="flex:1">Save login</button>${z.login ? '<button type="button" class="btn outline-ink" data-act="forget-zlib">Forget</button>' : ''}</div></form>
        <form class="pastel lilac on-paper" data-form="mobilism" autocomplete="off">
            <div class="ph"><span class="label" style="color:#3B2A80">${mState}</span>${cardSwitch('mobilism', 'Mobilism')}</div>
            <b class="name">Mobilism</b>
            <span class="desc" style="color:#38463f">Only members can search it. Add a free account and it joins in.</span>
            ${m.error ? `<span class="err" style="color:#8A2A12">${esc(m.error)}</span>` : ''}
            <label class="field">Username<input class="input priv" name="username" value="${esc(m.username || '')}" autocomplete="off"></label>
            <label class="field">Password<input class="input" type="password" name="password" placeholder="${m.login ? 'Saved. Type to replace it.' : ''}" autocomplete="off"></label>
            <div class="btnrow"><button type="submit" class="btn dark" style="flex:1">Save and test</button>${m.login ? '<button type="button" class="btn outline-ink" data-act="forget-mobilism">Forget</button>' : ''}</div></form>
    </section>
    ${slumCard()}
    <div class="libsum" style="margin-top:20px"><span class="dots"><span><i style="background:#5EEAB4"></i>${answering.filter(l => !off.has(l.id)).length} answering</span><span><i style="background:#FFD54A"></i>${needYou} need${needYou === 1 ? 's' : ''} you</span><span><i style="background:#B7A4FF"></i>${links} links</span></span>
        <button type="button" class="disclose" data-act="libs" aria-expanded="${ui.libsOpen}" aria-controls="libs-list">${ui.libsOpen ? 'Hide the list' : 'Manage libraries'}${chevron(16)}</button></div>
    ${ui.libsOpen ? `<div class="reveal" id="libs-list" style="display:flex;flex-direction:column;gap:40px;margin-top:20px">
        <section aria-label="Working libraries" class="sset" style="gap:16px">
            <div class="items-h"><h3 class="h-sub" style="font-size:26px">Awake and answering <span class="count">${answering.filter(l => !off.has(l.id)).length}</span></h3><span class="desc" style="font-size:14px">Switch off any you never use and searches get quicker.</span></div>
            <div class="libgrid">${answering.map(l => {
                const [info, colour] = SRC_INFO[l.id] || ['', '#FBF8FF'];
                const [stText, stCol] = STATE_TEXT[l.state] || STATE_TEXT.ok;
                return `<div class="lib" style="border-top-color:${colour}"><div class="lh"><b>${esc(l.name)}</b>${sw(!off.has(l.id), l.name, `data-src="${l.id}"`)}</div>
                    <span class="desc" style="font-size:14px">${esc(info)}</span><span class="lst" style="color:${stCol}">${stText}${l.ms != null && l.state !== 'off' ? ' · ' + (l.ms < 1000 ? l.ms + ' ms' : (l.ms / 1000).toFixed(1) + ' s') : ''}</span></div>`;
            }).join('')}</div></section>
        <section aria-label="Link-only sites" class="sset" id="links" style="gap:16px">
            <div class="items-h"><h3 class="h-sub" style="font-size:26px">Just links <span class="count">${links}</span></h3><span class="desc" style="font-size:14px">Sites we can only point you to. Your browser visits them, Quiet Chapters never does.</span></div>
            <div class="seg" role="radiogroup" aria-label="Which list">${segBtns([['ebooks', 'eBooks', false], ['audiobooks', 'Audiobooks', false]], ui.linksKind, 'data-act="linkskind"')}</div>
            <div class="linkpills">${sv().justLinks[ui.linksKind].map((l, i) => `<span class="jl" style="background:${PILL_COLOURS[i % 8]}" title="${esc(l.url)}">${esc(l.name)}<button type="button" aria-label="Remove ${esc(l.name)}" data-act="rmlink" data-i="${i}">×</button></span>`).join('') || '<span class="desc">No sites in this list.</span>'}</div>
            <form class="addsite" data-form="addlink"><label class="field">Name<input class="input" name="name" placeholder="My local library" required maxlength="60"></label>
                <label class="field">Search page address, with {q} where the words go<input class="input mono" name="url" placeholder="https://library.example.org/?s={q}" required style="font-size:15px"></label>
                <button type="submit" class="btn yellow">Add site</button></form>
            ${linksChanged() ? `<button type="button" class="btn outline sm" data-act="resetlinks" style="align-self:flex-start">Reset to the original list</button>` : ''}
        </section></div>` : ''}
    <section class="sset" id="settings" style="margin-top:56px"><h2 class="h-sec">Preferences</h2></section>`;
}

// The Just links list for the open tab differs from the one RaveBSD ships with.
const linksChanged = () => { const d = sv().defaults && sv().defaults.justLinks; return !!d && JSON.stringify(sv().justLinks[ui.linksKind]) !== JSON.stringify(d[ui.linksKind]); };
// ── Mirrors from SLUM ────────────────────────────────────────────────────────
const MIRROR_COLOURS = { up: '#5EEAB4', degraded: '#FFD54A', protected: '#8FD0FF', down: '#FF8A65', unknown: 'rgba(255,255,255,0.3)' };
const MIRROR_TEXT = { up: 'up', degraded: 'slow', protected: 'bot check', down: 'down', unknown: 'not watched' };
const mirrorList = k => ((app.status && app.status.mirrors && app.status.mirrors.groups) || {})[k] || [];
function slumCard() {
    const m = (app.status && app.status.mirrors) || { on: sv().sources.slum, groups: {} };
    const names = { libgen: 'LibGen', annas: "Anna's Archive", zlibrary: 'Z-Library' };
    const state = !m.on ? 'Off. Quiet Chapters uses its built-in mirror lists and learns from its own searches.'
        : m.error ? `${esc(m.error)}. Using the built-in lists until it answers.`
        : m.at ? `Checked ${ago(m.at)}. Working mirrors are tried first; ones that are down go last.` : 'Checking…';
    return `<div class="card" style="margin-top:14px;display:flex;flex-direction:column;gap:14px;padding:20px 22px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 20px">
            <div class="rt" style="flex:1 1 300px;display:flex;flex-direction:column;gap:4px"><b style="font-size:19px;font-weight:800">Pick mirrors with SLUM</b>
            <span class="desc">The <a class="u" href="https://open-slum.org" target="_blank" rel="noopener noreferrer" style="font-size:inherit">Shadow Library Uptime Monitor</a> watches these sites' mirrors. Quiet Chapters reads its page every 30 minutes; nothing about your searches is sent. ${state}</span></div>
            <span style="display:flex;align-items:center;gap:10px">${m.on ? '<button type="button" class="btn outline xs" data-act="slum-check">Check now</button>' : ''}${swk('sources.slum', m.on, 'Pick mirrors with SLUM')}</span></div>
        ${m.on && Object.keys(m.groups || {}).length ? `<div style="display:flex;flex-direction:column;gap:10px">${Object.entries(names).filter(([k]) => (m.groups[k] || []).length).map(([k, n]) => `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px"><b style="font-size:14px;min-width:120px">${n}</b>${m.groups[k].slice().sort((a, b) => ({ up: 0, degraded: 1, protected: 2, unknown: 2.5, down: 3 }[a.status] - { up: 0, degraded: 1, protected: 2, unknown: 2.5, down: 3 }[b.status])).map(d => `<span class="chip" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px"><i style="width:8px;height:8px;border-radius:50%;background:${MIRROR_COLOURS[d.status]}"></i>${esc(d.host)} · ${MIRROR_TEXT[d.status] || d.status}</span>`).join('')}</div>`).join('')}</div>` : ''}
        </div>`;
}

// ── Access ───────────────────────────────────────────────────────────────────
function access() {
    const a = sv().access, mode = a.mode, forced = a.publicForced, on = app.status && app.status.passwordOn;
    const keys = a.apiKeys || [], users = a.users || [];
    const MODES = [
        ['private', 'Just me', 'One person runs and uses it. A password is optional.'],
        ['family', 'Friends and family', 'Everyone signs in with an account you make. Users search, download and share the shelf; admins also run the server.'],
        ['public', 'Public', 'Open to the internet. Visitors search and keep their own downloads for a while; you sign in as admin for everything else. No API keys.'],
    ];
    const pwForm = (submit) => `<form class="fields reveal" data-form="password" style="padding:0 26px 22px">
        <label class="field">Username<input class="input priv" name="username" value="${esc((app.session && app.session.username) || 'admin')}" autocomplete="username"></label>
        <label class="field">New password<input class="input" type="password" name="password" autocomplete="new-password" required minlength="8"></label>
        <label class="field">Once more<input class="input" type="password" name="password2" autocomplete="new-password" required></label>
        <div style="flex:1 1 100%;display:flex;gap:12px"><button type="submit" class="btn yellow">${submit}</button><button type="button" class="btn outline" data-act="pw-cancel">Cancel</button></div></form>`;
    const modeRow = `<div class="row" style="flex-direction:column;align-items:stretch;gap:12px">
        <div class="rt" style="flex:none"><b>Who uses this Quiet Chapters</b><span class="desc">${forced ? 'Public, because PUBLIC_INSTANCE=1 is set on the server.' : esc(MODES.find(m => m[0] === mode)[2])}</span></div>
        <div class="seg" role="radiogroup" aria-label="Who uses it">${segBtns(MODES.map(([v, t]) => [v, t]), mode, 'data-act="mode"' + (forced ? ' disabled' : ''))}</div>
        ${mode === 'private' && !on ? '<span class="desc">Friends and family, and public, need an admin account: turn on the password below first.</span>' : ''}</div>`;
    const privateRows = `
        ${row('Ask for a password', 'Optional. Leave it off if your network, Tailscale or a proxy already controls who gets in.', sw(on || ui.pwOpen === 'on', 'Ask for a password', 'data-act="pw-toggle"'))}
        ${!on && ui.pwOpen === 'on' ? pwForm('Turn on the password') : ''}
        ${on ? row('Username and password', `Signed in as ${priv(esc((app.session && app.session.username) || ''))}`, `<button type="button" class="btn outline" data-act="pw-change">Change</button>`) + (ui.pwOpen === 'change' ? pwForm('Save password') : '') : ''}`;
    const accountRows = `<div class="row" style="flex-direction:column;align-items:stretch;gap:12px">
        <div class="rt" style="flex:none"><b>Accounts</b><span class="desc">${mode === 'public' ? 'Admins only: visitors need no account.' : 'Users search, download and share the shelf. Admins also run the server.'} Each person can change their own password in Settings, under This browser.</span></div>
        ${users.map(u => `<div class="keyrow"><b>${priv(esc(u.username))}</b><span class="mono">${u.role === 'admin' ? 'admin' : 'user'}</span><span style="font-size:14px;color:var(--text2)">${u.changedAt ? 'password set ' + esc(ago(u.changedAt)) : ''}</span>
            <span class="btnrow" style="gap:8px"><button type="button" class="btn outline xs" data-act="user-pw" data-id="${esc(u.id)}">New password</button>${u.role === 'admin' && users.filter(x => x.role === 'admin').length === 1 ? '' : `<button type="button" class="btn outline xs" data-act="user-rm" data-id="${esc(u.id)}">Remove</button>`}</span></div>
            ${ui.userPw === u.id ? `<form class="btnrow reveal" data-form="userpw" data-id="${esc(u.id)}"><input class="input" type="password" name="password" placeholder="New password for ${esc(u.username)}" minlength="8" required autocomplete="new-password" style="flex:1 1 220px"><button type="submit" class="btn yellow">Set it</button></form>` : ''}`).join('')}
        <form class="btnrow" data-form="user" autocomplete="off" style="flex-wrap:wrap"><input class="input" name="username" placeholder="Username" required maxlength="60" style="flex:1 1 160px" autocomplete="off">
            <input class="input" type="password" name="password" placeholder="Starting password" required minlength="8" style="flex:1 1 160px" autocomplete="new-password">
            ${mode === 'public' ? '<input type="hidden" name="role" value="admin">' : '<span class="selwrap paper"><select name="role" aria-label="Role"><option value="user">User</option><option value="admin">Admin</option></select>' + chevron(14) + '</span>'}
            <button type="submit" class="btn yellow">Add account</button></form></div>`;
    const visitorRows = mode !== 'public' ? '' : `
        ${row('Visitors can download to the server', 'Off: they can search and open the sources, nothing more.', swk('visitors.downloads', sv().visitors.downloads, 'Visitors can download to the server'))}
        ${row('Space for each visitor', 'What one visitor may keep on the server at a time. A book someone already fetched is shared, not fetched again.', `<label style="display:flex;align-items:center;gap:8px;font:500 15px var(--mono);color:var(--text2)"><input type="number" class="input num" data-num="visitors.quotaMB" aria-label="Megabytes per visitor" value="${sv().visitors.quotaMB}" min="1">MB</label>`)}
        ${row('Space for all visitors together', 'When visitors hold this much between them, new downloads wait until older ones are cleared.', `<label style="display:flex;align-items:center;gap:8px;font:500 15px var(--mono);color:var(--text2)"><input type="number" class="input num" data-num="visitors.totalMB" aria-label="Megabytes for all visitors" value="${sv().visitors.totalMB}" min="1">MB</label>`)}
        ${row('Keep their books for', 'Then they are cleared from the server, unless another visitor still holds them.', `<label style="display:flex;align-items:center;gap:8px;font:500 15px var(--mono);color:var(--text2)"><input type="number" class="input num" data-num="visitors.keepDays" aria-label="Days" value="${sv().visitors.keepDays}" min="1" max="365">days</label>`)}`;
    const keyRows = mode === 'public' ? '' : `<div class="row" style="flex-direction:column;align-items:stretch;gap:12px">
            <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px"><div class="rt"><b>API keys</b><span class="desc">For your scripts. Send one as <span class="mono" style="font-size:14px">X-API-Key</span> to <span class="mono" style="font-size:14px">/api/v1/search</span>.</span></div>
            <button type="button" class="btn yellow" data-act="key-new">Make a key</button></div>
            ${ui.keyLabel ? `<form class="btnrow reveal" data-form="key"><input class="input" name="label" placeholder="What is it for? (Home Assistant)" maxlength="60" style="flex:1 1 220px" required><button type="submit" class="btn yellow">Make it</button></form>` : ''}
            ${ui.newKey ? `<div class="newkey reveal" role="status"><b>Copy it now. It is shown only once.</b><code>${esc(ui.newKey)}</code><div class="btnrow"><button type="button" class="btn dark sm" data-act="key-copy">Copy key</button><button type="button" class="btn outline-ink sm" data-act="key-done">Done</button></div></div>` : ''}
            ${keys.map(k => `<div class="keyrow"><b>${esc(k.label)}</b><span class="mono">${esc(k.prefix)}…${esc(k.suffix)}</span><span style="font-size:14px;color:var(--text2)">${k.lastUsed ? 'used ' + esc(ago(k.lastUsed)) : 'not used yet'}</span><button type="button" class="btn outline xs" data-act="key-revoke" data-id="${esc(k.id)}">Revoke</button></div>`).join('')}
        </div>`;
    const everywhere = on ? row('Sign out everywhere', `Ends every signed-in session on every device${users.length > 1 ? ', for all accounts' : ''}. Passwords stay the same; this browser stays signed in.`, '<button type="button" class="btn outline" data-act="sessions-end">Sign out everywhere</button>') : '';
    return head('access', 'Access') + `<div class="card rows">${modeRow}${mode === 'private' ? privateRows : accountRows}${everywhere}${visitorRows}${keyRows}</div></section>`;
}

// ── This browser: for everyone, whatever their role ─────────────────────────
function device() {
    const s = app.session || {};
    const myPw = ui.myPw ? `<form class="fields reveal" data-form="mypw" style="padding:0 26px 22px">
        <label class="field">Current password<input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field">New password<input class="input" type="password" name="password" autocomplete="new-password" required minlength="8"></label>
        <label class="field">Once more<input class="input" type="password" name="password2" autocomplete="new-password" required></label>
        <div style="flex:1 1 100%;display:flex;gap:12px"><button type="submit" class="btn yellow">Save password</button><button type="button" class="btn outline" data-act="mypw">Cancel</button></div></form>` : '';
    return head('device', 'This browser', '<p class="lede" style="max-width:640px">Only for this browser on this device.</p>') + `<div class="card rows">
        ${row('Sound effects', 'A soft page rustle when you pick a book and a click-clack when you pick a cassette. For this browser only.', sw(prefs.sound, 'Sound effects', 'data-local="sound"'))}
        ${row('Animations', 'The search bar turns into a loading bar, then glides up as your results are uncovered. Turn this off to jump straight to the loading bar and show results as soon as they’re in. For this browser only.', sw(prefs.motion, 'Animations', 'data-local="motion"'))}
        ${s.mode === 'public' ? '' : `${row('Show folders and account names', 'File locations, usernames, email addresses and server addresses are blurred until you click them, in case this page is on a shared screen or in a screenshot. Turn this on to always show them. For this browser only.', sw(prefs.showPrivate, 'Show folders and account names', 'data-local="showPrivate"'))}`}
        ${notifyRow()}
        ${s.username ? row('Your account', `Signed in as ${priv(esc(s.username))}${s.role === 'admin' ? ' (admin)' : ''}`, '<button type="button" class="btn outline" data-act="signout">Sign out</button>') : ''}
        ${s.username && s.mode !== 'private' ? row('Your password', 'Your other browsers are signed out when it changes.', '<button type="button" class="btn outline" data-act="mypw">Change</button>') + myPw : ''}
        </div></section>`;
}

// ── Searching, saving, storage ───────────────────────────────────────────────
function searching() {
    const s = sv().searching;
    return head('searching', 'Searching') + `<div class="card rows">
        ${row('Default results view', 'How a search opens. You can still switch with the icons above the results.', seg('searching.view', [['shelf', 'Shelf'], ['list', 'List']], s.view, 'Default results view'))}
        ${row('Links to show by default', '“Direct links only” hides eBook results that only open a source page, so every result you see can go straight to the server. You can switch it for a single search from the results.', seg('searching.links', [['any', 'Any link'], ['direct', 'Direct links only']], s.links, 'Links to show by default'), note('Audiobook magnets always show, because qBittorrent handles them.'))}
        ${row('Audiobook length to show by default', 'Audiobook searches open already narrowed to full or shortened recordings. You can change it on any search with the Length filter above the results.', seg('searching.length', [['any', 'Any'], ['unabridged', 'Unabridged'], ['abridged', 'Abridged']], s.length, 'Audiobook length to show by default'))}
        </div></section>`;
}
function saving() {
    const s = sv().saving;
    return head('saving', 'Saving to your devices') + `<div class="card rows">
        ${row('Let devices save finished books', 'Books are always filed on the server first. Anyone signed in can then save a copy to the phone or computer they are using. Audiobooks come as a zip.', swk('saving.allow', s.allow, 'Let devices save finished books'))}
        ${row('Save books to client device automatically', 'When the server has finished downloading and renaming an eBook, it is sent on to the device you searched from, with no extra tap.', swk('saving.auto', s.auto, 'Save books to client device automatically'), note('Only eBooks are sent automatically, and only while the page you searched from is still open. Audiobooks take a while to finish, so they wait on the Shelf until you press Save.'))}
        </div></section>`;
}
function storage() {
    const s = sv().storage;
    return head('storage', 'Storage') + `<div class="card rows">
        ${row('Remove from the server once saved to a device', 'A day after a book is saved to a phone or computer, the server copy is deleted. Handy on a small disk. Books nobody has saved yet stay put.', swk('storage.removeAfterSaved', s.removeAfterSaved, 'Remove from the server once saved to a device'))}
        ${row('Warn me when space runs low', 'A banner on the Shelf, and a notification if those are on, once free space drops below this.', `<label style="display:flex;align-items:center;gap:8px;font:500 15px var(--mono);color:var(--text2)"><input type="number" class="input num" data-num="storage.lowSpaceGB" aria-label="Warn below this many GB" value="${s.lowSpaceGB}" min="0" max="100000">GB free</label>`)}
        </div></section>`;
}

// ── Notifications ────────────────────────────────────────────────────────────
// Whether this browser may show them is its own choice, so that row lives under This browser for everyone.
// Which events notify is a server setting, so the switches live in the admin panel.
function notifyRow() {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const status = perm === 'granted' ? 'On for this browser. The admin panel sets which events notify.'
        : perm === 'denied' ? 'This browser has blocked notifications for Quiet Chapters. To allow them, open the site settings from the icon beside the address bar, set Notifications to Allow, then reload this page.'
        : perm === 'unsupported' ? 'This browser cannot show notifications.'
        : !window.isSecureContext ? 'Browsers only allow notifications over HTTPS or on localhost. Open Quiet Chapters through HTTPS (for example with Tailscale or a reverse proxy) to use them.'
        : 'Not asked yet. Your browser asks once.';
    return row('Notifications', esc(status), perm === 'default' && window.isSecureContext ? '<button type="button" class="btn yellow" data-act="notify-allow" style="font-size:16px">Allow notifications</button>' : '');
}
function notifications() {
    const n = sv().notify;
    return head('notifications', 'Notifications', '<p class="lede" style="max-width:640px">Which events notify. Each browser allows them for itself, on <a class="u" href="/settings#device">the Settings page</a> under This browser.</p>') + `<div class="card rows">
        ${row('A download is on the shelf', 'When a book has been downloaded, renamed and filed.', swk('notify.onShelf', n.onShelf, 'A download is on the shelf'))}
        ${row('Space is running low', 'Uses the level you set under Storage.', swk('notify.lowSpace', n.lowSpace, 'Space is running low'))}
        </div></section>`;
}

// ── Shelves and names ────────────────────────────────────────────────────────
const SAMPLES = [
    ['ebook', 'Dune_-_Frank_Herbert_(z-lib.org).epub', { author: 'Frank Herbert', title: 'Dune', year: '1965', ext: 'epub' }, -0.4],
    ['ebook', 'Foundation (Asimov Isaac) [1951].mobi', { author: 'Isaac Asimov', title: 'Foundation', year: '1951', ext: 'mobi' }, 0.5],
    ['audiobook', 'The.Hobbit.Tolkien.64kbps/Part 03.mp3', { author: 'J. R. R. Tolkien', title: 'The Hobbit', year: '2011', narrator: 'Andy Serkis', ext: 'mp3', track: 3, trackCount: 19 }, -0.3],
];
function previews() {
    const s = sv().shelves;
    return SAMPLES.map(([kind, was, b, rot]) => {
        const dir = (kind === 'audiobook' ? s.audioDir : s.ebookDir).replace(/\/+$/, '');
        const name = s.rename ? applyTemplate(kind === 'audiobook' ? s.audioTemplate : s.ebookTemplate, b, { tidy: s.tidy }) : (s.tidy ? was.replace(/_/g, ' ').replace(/\s*\(z-lib\.org\)/, '') : was);
        return `<div class="slip" style="transform:rotate(${rot}deg)"><s>${esc(was)}</s><b>${priv(esc(dir))}/${esc(name)}</b></div>`;
    }).join('');
}
function folderLine() {
    const f = ui.folders;
    if (!f) return '<span class="desc" id="fline" style="font-size:14px">Checking the folders…</span>';
    const bad = ['ebookDir', 'audioDir'].filter(k => !f[k].writable);
    if (bad.length) return `<span class="err" id="fline">${bad.length > 1 ? 'The eBooks and audiobooks folders are' : bad[0] === 'ebookDir' ? 'The eBooks folder is' : 'The audiobooks folder is'} not writable. Check the volume in compose.yaml.</span>`;
    return `<span class="ok" id="fline">Both writable · ${size(Math.min(f.ebookDir.free, f.audioDir.free)) || '0 KB'} free</span>`;
}
function shelves() {
    const s = sv().shelves;
    return head('shelves', 'Shelves and names') + `<div class="card" style="display:flex;flex-direction:column;gap:22px;padding:${isPhone() ? 20 : 26}px">
        <p class="desc" style="margin:0;font-size:16px;line-height:1.55">Everything Quiet Chapters fetches is renamed from what the search result knows (title, author, year, narrator), not from whatever the file was called, and filed here.</p>
        <div class="fields"><label class="field" style="flex-basis:280px">eBooks folder<input class="input mono priv" data-text="shelves.ebookDir" value="${esc(s.ebookDir)}" spellcheck="false"></label>
            <label class="field" style="flex-basis:280px">Audiobooks folder<input class="input mono priv" data-text="shelves.audioDir" value="${esc(s.audioDir)}" spellcheck="false"></label></div>
        ${folderLine()}
        <div style="display:flex;flex-direction:column;gap:16px;padding-top:22px;border-top:1px solid rgba(255,255,255,0.12)">
            <label class="field">How eBooks are named<input class="input mono" data-text="shelves.ebookTemplate" data-tpl="ebookTemplate" value="${esc(s.ebookTemplate)}" spellcheck="false"></label>
            <label class="field">How audiobooks are named<input class="input mono" data-text="shelves.audioTemplate" data-tpl="audioTemplate" value="${esc(s.audioTemplate)}" spellcheck="false"></label>
            <div class="tokens"><span style="font-size:13px;font-weight:600;color:var(--text2);margin-right:4px">Click to add</span>${TOKENS.map((t, i) => `<button type="button" data-act="token" data-v="{${t}}" style="background:${TOKEN_COLOURS[i]}">{${t}}</button>`).join('')}</div></div>
        <div style="display:flex;flex-direction:column;gap:14px"><span class="label" style="color:var(--text2)">What it will do to your files</span><div id="previews" style="display:flex;flex-direction:column;gap:14px">${previews()}</div></div>
        <div class="rows subrows" style="border-top:1px solid rgba(255,255,255,0.12)">
            ${row('Rename and shelve after every download', 'Off keeps the name the file came with, still filed in the folders above.', swk('shelves.rename', s.rename, 'Rename and shelve after every download'))}
            ${row('Tidy up junk in names', 'Drops site tags like (z-lib.org), underscores and characters your disk rejects.', swk('shelves.tidy', s.tidy, 'Tidy up junk in names'))}
            ${row('If it is already on the shelf', 'Same name after renaming.', `<span class="selwrap paper"><select data-sel="shelves.duplicate" aria-label="If it is already on the shelf">${[['skip', 'Skip it and say so'], ['both', 'Keep both'], ['replace', 'Replace it']].map(([v, l]) => `<option value="${v}"${s.duplicate === v ? ' selected' : ''}>${l}</option>`).join('')}</select>${chevron(14)}</span>`)}
            ${row('Keep the downloads list when files move', 'If another app takes the files away, the entry stays, marked as moved. Quiet Chapters never goes looking for them.', swk('shelves.keepMoved', s.keepMoved, 'Keep the downloads list when files move'))}
        </div></div></section>`;
}

// ── qBittorrent ──────────────────────────────────────────────────────────────
function qbittorrent() {
    const q = sv().qbit, st = ui.qbStatus;
    const pill = !q.enabled ? '<span class="status idle"><span class="d"></span>Switched off</span>'
        : !st ? '<span class="status idle"><span class="d"></span>Checking…</span>'
        : st.ok ? `<span class="status"><span class="d"></span>Connected · qBittorrent ${esc(st.version)}</span>` : `<span class="status bad"><span class="d"></span>${esc(st.error || 'Could not reach it')}</span>`;
    return head('qbittorrent', 'qBittorrent') + `<form class="pastel mint on-paper" data-form="qbit" autocomplete="off" style="gap:18px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px"><span style="font-size:18px;line-height:1.5;max-width:560px;color:#1e4a38">Audiobook magnets are handed to qBittorrent. When a torrent finishes, Quiet Chapters renames and shelves it for you.</span>
            <span style="display:flex;align-items:center;gap:12px">${pill}${swk('qbit.enabled', q.enabled, 'Use qBittorrent')}</span></div>
        ${q.enabled ? `<label class="field">Web UI address<input class="input mono priv" name="url" value="${esc(q.url)}" spellcheck="false"></label>
        <div class="fields"><label class="field">Username<input class="input priv" name="username" value="${esc(q.username)}" autocomplete="off"></label>
            <label class="field">Password<input class="input" type="password" name="password" placeholder="${q.hasPassword ? 'Saved. Type to replace it.' : ''}" autocomplete="off"></label>
            <label class="field">Category<input class="input mono" name="category" value="${esc(q.category)}"></label></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end"><label class="field" style="flex:1 1 220px">Downloads folder, as qBittorrent sees it<input class="input mono priv" name="mapFrom" value="${esc(q.mapFrom)}"></label>
            <span aria-hidden="true" style="height:50px;display:flex;align-items:center;font-size:22px;font-weight:800">⇄</span>
            <label class="field" style="flex:1 1 220px">Same folder, as Quiet Chapters sees it<input class="input mono priv" name="mapTo" value="${esc(q.mapTo)}"></label></div>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#0B4A36">Both containers need to share that folder, for example <span class="mono" style="font-size:13px">/srv/downloads:/downloads</span> in each compose file.</p>
        <label class="field">When a torrent finishes<span class="selwrap paper" style="display:flex"><select name="onFinish" style="width:100%;background:rgba(255,255,255,0.85)">${[['copy', 'Copy to the shelf and keep seeding'], ['move', 'Move to the shelf and remove the torrent']].map(([v, l]) => `<option value="${v}"${q.onFinish === v ? ' selected' : ''}>${l}</option>`).join('')}</select>${chevron(14)}</span></label>
        <div class="btnrow"><button type="submit" class="btn dark">Save</button><button type="button" class="btn outline-ink" data-act="qbtest">Test connection</button></div>` : ''}
        </form>
        <div class="card rows">${row('Direct downloads at once', 'Sites throttle fast clients. Low is polite and reliable.', `<input type="number" class="input num" data-num="qbit.directSlots" aria-label="Direct downloads at once" value="${q.directSlots}" min="1" max="6">`)}</div></section>`;
}

// ── VPN ──────────────────────────────────────────────────────────────────────
function vpn() {
    const v = sv().vpn, st = (app.status && app.status.vpn) || {};
    const pill = !v.enabled ? '<span class="status idle"><span class="d"></span>Not in use</span>'
        : st.up ? '<span class="status"><span class="d"></span>Tunnel is up</span>' : st.up === false ? `<span class="status bad"><span class="d"></span>Tunnel is down</span>` : '<span class="status idle"><span class="d"></span>Not checked yet</span>';
    const place = [st.city, st.country].filter(Boolean).join(', ');
    return head('vpn', 'VPN tunnel') + `<form class="pastel lilac on-paper" data-form="vpn" autocomplete="off" style="gap:18px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px"><div class="rt" style="flex:1 1 340px;display:flex;flex-direction:column;gap:6px">
            <span style="display:inline-flex;align-items:center;gap:10px;font-size:24px;font-weight:800;letter-spacing:-0.02em">${icon('shield', 26)}Send everything through Gluetun</span>
            <span style="font-size:16px;line-height:1.5;color:#38463f">Searches, direct downloads and qBittorrent all leave through your Gluetun container, so the sites only ever see the VPN's address, never yours. Quiet Chapters checks the tunnel every minute.</span></div>
            ${swk('vpn.enabled', v.enabled, 'Send everything through Gluetun')}</div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">${pill}${v.enabled && st.checkedAt ? `<span id="vpn-checked" style="font-size:14px;font-weight:600;color:#2E2166">Checked ${ago(st.checkedAt)}</span>` : ''}${v.enabled && st.error && !st.up ? `<span style="font-size:14px;font-weight:600;color:#8A2A12">${esc(st.error)}</span>` : ''}</div>
        <button type="button" class="disclose" data-act="vpn-open" aria-expanded="${ui.vpnOpen}" aria-controls="vpn-details">${ui.vpnOpen ? 'Hide details' : 'Details and setup'}${chevron(16)}</button>
        ${ui.vpnOpen ? `<div class="reveal" id="vpn-details" style="display:flex;flex-direction:column;gap:18px">
            <div class="vpntiles"><div><span class="label">Provider</span><b>${st.org ? priv(esc(st.org)) : '·'}</b></div><div><span class="label">Exit server</span><b>${place ? priv(esc(place)) : '·'}</b></div><div><span class="label">Public address</span><b>${st.ip ? priv(esc(st.ip)) : '·'}</b></div><div><span class="label">Forwarded port</span><b>${st.port || '·'}</b></div></div>
            <label class="field">Gluetun control server<input class="input mono priv" name="controlUrl" value="${esc(v.controlUrl)}" spellcheck="false"></label>
            <label class="field">Control server API key<input class="input" type="password" name="apiKey" placeholder="${v.hasApiKey ? 'Saved. Type to replace it.' : 'Only if the control server asks for one'}" autocomplete="off"></label>
            <div class="btnrow"><button type="submit" class="btn dark">Save</button><button type="button" class="btn outline-ink" data-act="vpn-check"${ui.vpnBusy ? ' disabled' : ''}>Check the tunnel</button><button type="button" class="btn outline-ink" data-act="vpn-switch"${ui.vpnBusy ? ' disabled' : ''}>Switch exit server</button></div></div>` : ''}
        </form>
        ${v.enabled ? `<div class="card rows">
            ${row('Stop if the tunnel drops', 'Searches and downloads pause until Gluetun is back. Nothing falls back to your own connection.', swk('vpn.stopOnDrop', v.stopOnDrop, 'Stop if the tunnel drops'))}
            ${row('Tell me when it drops', 'A badge shows on Settings and a banner on the Shelf while the tunnel is down.', swk('vpn.tellOnDrop', v.tellOnDrop, 'Tell me when it drops'))}</div>` : ''}
        ${ui.vpnOpen ? `<div class="reveal" style="display:flex;flex-direction:column;gap:14px">
            <div class="card" style="display:flex;flex-direction:column;gap:12px;padding:22px 26px"><b style="font-size:19px">What goes through the tunnel</b>
                <div class="tunnelchips"><span>${icon('check', 14, 3)}Searching the libraries</span><span>${icon('check', 14, 3)}Direct downloads</span><span>${icon('check', 14, 3)}qBittorrent</span></div>
                <span class="desc">Opening Quiet Chapters from your devices and saving finished books to them stays on your own network.</span></div>
            <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:22px 26px;background:var(--well);border:1px dashed var(--line)"><b style="font-size:19px">Setting it up</b>
                <span class="desc">Put Quiet Chapters and qBittorrent on Gluetun's network in your compose file. Publish their ports on the gluetun service, and inside the tunnel qBittorrent is then reached at <span class="mono" style="font-size:13px">http://localhost:8080</span>. The switch above only checks the tunnel and pauses things if it drops; the routing itself is this compose setting.</span>
                <pre class="code">ravebsd:\n  network_mode: "service:gluetun"\nqbittorrent:\n  network_mode: "service:gluetun"\ngluetun:\n  environment:\n    HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE: '{"auth":"apikey","apikey":"your-key"}'</pre>
                <span class="desc">With Quiet Chapters on Gluetun's network the control server is <span class="mono" style="font-size:13px">http://localhost:8000</span>. Put the same key in the API key box above.</span></div></div>` : ''}
        </section>`;
}

// ── Privacy, system ──────────────────────────────────────────────────────────
function privacy() {
    return head('privacy', 'Privacy and backup') + `<div class="card rows">
        ${row('Keep stats', 'Numbers only: authors, formats and sizes, never what you typed in the search bar. Switching it off stops the counting and deletes what was counted. See them on the Stats page under Shelf.', swk('statsEnabled', sv().statsEnabled, 'Keep stats'))}
        <div class="row" style="flex-direction:column;align-items:flex-start;gap:4px"><b style="font-size:19px;font-weight:800">What you search for is never saved</b><span class="desc">Not in files, not in logs. Recent results sit in memory for 10 minutes so repeats are quick, then they are gone, and they are gone after a restart too.</span></div>
        ${row('Backup and restore', 'Settings, saved logins, the shelf list and stats in one file (no books). It holds secrets, so keep it private.', `<div class="btnrow" style="gap:10px"><a class="btn" href="/api/backup" download style="background:#8FD0FF;color:var(--ink);box-shadow:0 4px 0 #4C8FCC">Download backup</a><label class="btn outline" style="cursor:pointer">Restore<input type="file" accept="application/json,.json" data-act="restore" class="sr"></label></div>`)}
        </div></section>`;
}
function system() {
    const s = sv(), st = app.status || {};
    const up = ui.update;
    const upLine = !up ? '' : up.error ? `<span class="desc" style="color:#a33b37">${esc(up.error)}</span>` : up.newer ? `<span class="desc" style="color:#8e6a35">Version ${esc(up.latest)} is out. Update with ./update.sh or docker compose pull.</span>` : `<span class="desc" style="color:#1e4a38">Up to date · checked just now</span>`;
    const conn = ui.conn ? (ui.conn.online ? `<span class="desc" style="display:flex;align-items:center;gap:8px;color:#1e4a38"><span style="width:8px;height:8px;border-radius:50%;background:#1e4a38"></span>Online · reachable at <span class="mono" style="font-size:14px">${esc(location.host)}</span> · internet reachable (${ui.conn.ms} ms)</span>` : '<span class="desc" style="color:#a33b37">The server cannot reach the internet.</span>') : `<span class="desc">Reachable at <span class="mono" style="font-size:14px">${esc(location.host)}</span>. Check whether the server can reach the internet.</span>`;
    const sbx = ui.browserSandboxed === false ? " It runs without Chromium's sandbox: this host blocks what the sandbox needs. In Docker, start it with the seccomp-chromium.json profile, as compose.yaml does." : ui.browserSandboxed ? ' Sandboxed.' : '';
    const br = ui.browser == null ? "For Anna's Archive and for Z-Library searches without an account." : ui.browser ? "For Anna's Archive and for Z-Library searches without an account. Ready." + sbx : 'Not installed. Anna\'s Archive checks and Z-Library guest searches need it (the standard Docker image includes it).';
    return head('system', 'System') + `<div class="card rows">
        ${row('Show badges on the nav bar', 'The count on Shelf and the dot on Settings. Switch them off to keep the bar quiet. The details stay inside each page.', swk('system.badges', s.system.badges, 'Show badges on the nav bar'))}
        ${row(`Quiet Chapters <span class="mono" style="font-size:16px;font-weight:500">${esc(st.version || '')}</span>`, '', `<button type="button" class="btn outline" data-act="update">Check now</button>`, upLine)}
        <div class="row" style="padding-top:18px;padding-bottom:18px;flex-wrap:nowrap"><span class="desc">Connection, background browser and how this server introduces itself</span><button type="button" class="disclose" data-act="adv-open" aria-expanded="${ui.advOpen}" aria-controls="sys-adv">${ui.advOpen ? 'Hide' : 'Advanced'}${chevron(16)}</button></div>
        ${ui.advOpen ? `<div class="rows reveal" id="sys-adv" style="border-top:1px solid var(--divider)">
            ${row('Connection', '', '<button type="button" class="btn outline" data-act="conn">Check connection</button>', conn)}
            ${row('Background browser', esc(br), '<button type="button" class="btn outline" data-act="browser-restart">Restart</button>')}
            ${row('How the server identifies its browser', 'Many sites refuse an honest name, so it looks like an ordinary browser by default.', `<span class="selwrap paper"><select data-sel="userAgentMode" aria-label="User agent"${s.userAgentForced ? ' disabled' : ''}><option value="browser"${s.userAgentMode === 'browser' ? ' selected' : ''}>Like a normal browser</option><option value="rave"${s.userAgentMode === 'rave' ? ' selected' : ''}>Use its product name</option></select>${chevron(14)}</span>`, s.userAgentForced ? note('Set by USER_AGENT_MODE on the server.') : '')}</div>` : ''}
        </div>
        ${ui.advOpen ? '<p class="desc" style="margin:0;font-size:14px;line-height:1.6">The port, user and group IDs and mounted folders live in <span class="mono" style="font-size:13px">compose.yaml</span> and <span class="mono" style="font-size:13px">.env</span>, because they need a restart.</p>' : ''}
        </section>`;
}

// ── Saving changes ───────────────────────────────────────────────────────────
async function patch(name, value, { quiet = true } = {}) {
    const [a, b] = name.split('.');
    const body = b ? { [a]: { [b]: value } } : { [a]: value };
    try {
        app.settings = await api('/api/settings', { body });
        bus.dispatchEvent(new CustomEvent('settings', { detail: app.settings }));
        if (!quiet) toast('Saved');
        return true;
    } catch (e) { toast(e.message); return false; }
}
let fTimer;
function checkFolders() {
    clearTimeout(fTimer);
    fTimer = setTimeout(async () => {
        const s = sv().shelves;
        try { ui.folders = await api('/api/folders', { body: { ebookDir: s.ebookDir, audioDir: s.audioDir } }); } catch (e) { ui.folders = null; }
        const el = $('#fline'); if (el) el.outerHTML = folderLine();
    }, 250);
}
async function testQbit(silent) {
    ui.qbStatus = null; if (!silent) drawSection('qbittorrent');
    ui.qbStatus = await api('/api/qbit/test', { body: {} }).catch(e => ({ ok: false, error: e.message }));
    drawSection('qbittorrent');
}
async function reloadLibs() { libs = await api('/api/libraries').catch(() => libs); drawSection('libraries'); refreshStatus(); }
const formData = f => Object.fromEntries(new FormData(f).entries());

async function onChange(e) {
    const t = e.target;
    if (t.dataset.catalogBook) {
        t.checked ? catalogSelected.add(t.dataset.catalogBook) : catalogSelected.delete(t.dataset.catalogBook);
        catalogAllEligibleSelected = false;
        ui.catalogConfirmed = false;
        drawSection('catalog');
        return;
    }
    if (t.hasAttribute('data-catalog-select-all')) {
        ui.catalogConfirmed = false;
        if (!t.checked) {
            catalogSelected.clear();
            catalogAllEligibleSelected = false;
            drawSection('catalog');
            return;
        }
        catalogSelectAllBusy = true;
        catalogError = '';
        drawSection('catalog');
        try {
            const result = await api('/api/store/admin/catalog/pending-rights/eligible-ids');
            if (!Array.isArray(result.ids) || !Number.isInteger(result.total) || result.total !== result.ids.length) {
                throw new Error('The server returned an invalid eligible-book selection');
            }
            catalogSelected = new Set(result.ids);
            catalogEligibleTotal = result.total;
            catalogAllEligibleSelected = result.total > 0;
        } catch (err) {
            catalogAllEligibleSelected = false;
            catalogError = `Could not select all eligible pending books: ${err.message || 'request failed'}`;
        } finally {
            catalogSelectAllBusy = false;
            drawSection('catalog');
        }
        return;
    }
    if (t.hasAttribute('data-catalog-confirm')) {
        ui.catalogConfirmed = t.checked;
        const button = $('[data-act="catalog-approve"]', root);
        if (button) button.disabled = !catalogSelected.size || !ui.catalogConfirmed;
        return;
    }
    if (t.dataset.text) {
        // Folder paths and naming templates save when the box is left.
        if (await patch(t.dataset.text, t.value, { quiet: false })) { if (t.dataset.text.endsWith('Dir')) checkFolders(); $('#previews').innerHTML = previews(); }
        return;
    }
    if (t.dataset.num) { const v = Number(t.value); if (Number.isFinite(v)) { await patch(t.dataset.num, v, { quiet: false }); t.value = t.dataset.num.split('.').reduce((o, k) => o[k], sv()); } return; }
    if (t.dataset.sel) return patch(t.dataset.sel, t.value, { quiet: false });
    if (t.dataset.act === 'restore' && t.files[0]) {
        const text = await t.files[0].text();
        let data; try { data = JSON.parse(text); } catch (err) { toast('That file is not a Quiet Chapters backup'); return; }
        if (!(await confirmBox('Restore this backup?', 'Settings, saved logins, the shelf list and stats are replaced with the ones in the file. Books on disk are not touched.', 'Restore', false))) { t.value = ''; return; }
        try { await api('/api/restore', { body: data }); toast('Restored'); setTimeout(() => location.reload(), 600); } catch (err) { toast(err.message); }
    }
}
function onInput(e) {
    const t = e.target;
    if (t.dataset.tpl || (t.dataset.text && t.dataset.text.endsWith('Dir'))) {
        // Live preview while typing, before anything is saved.
        const s = sv().shelves, key = t.dataset.text.split('.')[1];
        const was = s[key]; s[key] = t.value; $('#previews').innerHTML = previews(); s[key] = was;
    }
}

// Whatever a click asks of the server, a failure ends as a message instead of nothing.
const onClick = e => click(e).catch(err => toast(err.message));
async function click(e) {
    const t = e.target.closest('[data-act], [data-set], [data-seg], [data-src], [data-local]');
    if (!t || !root.contains(t)) return;
    if (t.dataset.set) {
        const on = t.getAttribute('aria-checked') !== 'true';
        const key = t.dataset.set;
        if (key === 'statsEnabled' && !on && !(await confirmBox('Stop counting?', 'Switching stats off also deletes everything counted so far.', 'Switch off'))) return;
        t.setAttribute('aria-checked', on);
        if (!(await patch(key, on))) { t.setAttribute('aria-checked', !on); return; }
        if (key === 'system.badges') drawNav();
        if (key === 'qbit.enabled') { drawSection('qbittorrent'); if (on) testQbit(true); }
        if (key.startsWith('vpn.')) { await refreshStatus(); drawSection('vpn'); }
        if (key.startsWith('shelves.')) $('#previews').innerHTML = previews();
        if (key === 'sources.slum') { await refreshStatus(); drawSection('libraries'); }
        return;
    }
    if (t.dataset.local) {
        const on = t.getAttribute('aria-checked') !== 'true';
        prefs[t.dataset.local] = on;
        t.setAttribute('aria-checked', on);
        // A sample, so it is clear right away whether this device makes sound.
        if (t.dataset.local === 'sound' && on) sfx('book');
        return;
    }
    if (t.dataset.seg) {
        const key = t.dataset.seg, v = t.dataset.v;
        if (await patch(key, v)) {
            if (key === 'searching.view') prefs.view = v;
            const g = t.parentElement; keepFocus(() => { g.innerHTML = segBtns([...g.children].map(b => [b.dataset.v, b.textContent.trim()]), v, `data-seg="${key}"`); });
        }
        return;
    }
    if (t.dataset.src) {
        const id = t.dataset.src, on = t.getAttribute('aria-checked') !== 'true';
        const off = new Set(sv().sources.off); on ? off.delete(id) : off.add(id);
        t.setAttribute('aria-checked', on);
        if (await patch('sources.off', [...off])) reloadLibs();
        return;
    }
    switch (t.dataset.act) {
        case 'catalog-clear-policy': {
            if (!await confirmBox('Clear the universal rights policy?', 'Future imports will no longer be automatically approved by this policy.', 'Clear policy')) return;
            catalogPolicy = await api('/api/store/admin/rights-policy', { method: 'PUT', body: { license: '', rightsScope: '', rightsEvidence: '' } });
            catalogNotice = 'Universal rights policy cleared.';
            drawSection('catalog');
            return;
        }
        case 'catalog-apply-policy': {
            if (!await confirmBox('Apply rights fields to existing books?', 'Missing license, scope and evidence fields will be filled. This does not approve any book.', 'Apply policy')) return;
            const result = await api('/api/store/admin/rights-policy/apply-existing', { body: {} });
            catalogNotice = `Applied policy to ${result.updated} of ${result.total} books. Existing approval status was not changed.`;
            await loadCatalogAdmin({ policy: false });
            drawSection('catalog');
            return;
        }
        case 'catalog-import-run': {
            if (catalogImportStatus.status === 'running') return void pollCatalogImport();
            if (!await confirmBox('Search enabled book sources now?', 'This searches enabled e-book sources using broad rotating queries, up to 5,000 results. New books remain pending rights review; existing records keep their approval and file state.', 'Start import')) return;
            catalogError = '';
            try {
                catalogImportStatus = await api('/api/store/admin/catalog/import-run', { body: { limit: 5000 } });
                catalogNotice = 'Source import started. New books will remain pending rights review.';
                drawSection('catalog');
                await pollCatalogImport();
            } catch (err) {
                catalogError = `Could not start source import: ${err.message || 'request failed'}`;
                drawSection('catalog');
            }
            return;
        }
        case 'licence-open': licenceOpen = t.dataset.source; drawSection('catalog'); return;
        case 'licence-close': licenceOpen = ''; drawSection('catalog'); return;
        case 'licence-revoke': {
            const id = t.dataset.source;
            try {
                await api(`/api/store/admin/source-licences/${encodeURIComponent(id)}/revoke`, { body: {} });
                sourceLicences = await api('/api/store/admin/source-licences');
                deliveryStatus = await api('/api/store/admin/delivery').catch(() => deliveryStatus);
                catalogNotice = 'Licence revoked. Books from that source can no longer be bought or downloaded.'; catalogError = '';
            } catch (err) { catalogError = err.message; }
            drawSection('catalog');
            return;
        }
        case 'delivery-check': {
            catalogError = '';
            try {
                deliveryStatus = await api('/api/store/admin/delivery/check', { body: { limit: 50 } });
                drawSection('catalog');
                await pollDeliveryChecks();
            } catch (err) {
                catalogError = `Could not check delivery: ${err.message || 'request failed'}`;
                drawSection('catalog');
            }
            return;
        }
        case 'catalog-backfill-covers': {
            if (catalogBackfillBusy) return;
            if (!await confirmBox('Find missing book covers?', 'This checks already published books against Open Library. Only exact title and author matches are used; existing covers and publication status are left unchanged.', 'Find covers')) return;
            catalogBackfillBusy = true;
            catalogError = '';
            let after = '', checked = 0, matched = 0, notFound = 0, failed = 0, remaining = 0;
            catalogNotice = 'Starting cover lookup…';
            drawSection('catalog');
            try {
                while (true) {
                    const result = await api('/api/store/admin/catalog/backfill-covers', { body: { after, limit: 5 } });
                    checked += result.checked;
                    matched += result.matched;
                    notFound += result.notFound;
                    failed += result.failed;
                    remaining = result.remaining;
                    after = result.nextAfter;
                    catalogNotice = `Checked ${checked} published books; added ${matched} covers. ${remaining} still need covers.`;
                    drawSection('catalog');
                    if (result.done) break;
                    if (!result.checked || !after) throw new Error('Cover lookup did not advance; stopped to avoid repeating the same books.');
                }
                catalogNotice = `Cover backfill finished: added ${matched} covers from ${checked} books checked. ${notFound} had no exact match, ${failed} lookups failed, and ${remaining} published books still have no cover.`;
            } catch (err) {
                catalogError = `Cover backfill stopped after checking ${checked} books and adding ${matched} covers: ${err.message}`;
            } finally {
                catalogBackfillBusy = false;
                drawSection('catalog');
            }
            return;
        }
        case 'email-refresh': emailStatus = await api('/api/store/admin/email').catch(err => { catalogError = err.message; return emailStatus; }); return drawSection('catalog');
        case 'email-retry': {
            const r = await api('/api/store/admin/email/retry', { body: {} }).catch(err => { catalogError = err.message; });
            if (r) catalogNotice = `${r.requeued} failed email${r.requeued === 1 ? '' : 's'} queued again.`;
            await new Promise(resolve => setTimeout(resolve, 1500));
            emailStatus = await api('/api/store/admin/email').catch(() => emailStatus);
            return drawSection('catalog');
        }
        case 'requests-filter': bookRequestFilter = t.dataset.v || ''; bookRequests.offset = 0; return refreshBookRequests();
        case 'requests-prev': bookRequests.offset = Math.max(0, (bookRequests.offset || 0) - 25); return refreshBookRequests();
        case 'requests-next': bookRequests.offset = (bookRequests.offset || 0) + 25; return refreshBookRequests();
        case 'requests-sweep': {
            const r = await api('/api/store/admin/requests/sweep', { body: {} }).catch(err => { catalogError = err.message; });
            if (r) catalogNotice = `Requests checked: ${r.matched} newly matched, ${r.fulfilled} bought, ${r.expired} expired, ${r.closed} closed.`;
            return refreshBookRequests();
        }
        case 'requests-close': {
            if (!await confirmBox('Close this request?', 'It stops being matched against new books. The customer sees it as closed.', 'Close request')) return;
            await api(`/api/store/admin/requests/${encodeURIComponent(t.dataset.id)}/close`, { body: {} }).catch(err => { catalogError = err.message; });
            return refreshBookRequests();
        }
        case 'catalog-prev': catalogQueue.offset = Math.max(0, catalogQueue.offset - catalogQueue.limit); await loadCatalogAdmin({ policy: false }); return drawSection('catalog');
        case 'catalog-next': catalogQueue.offset += catalogQueue.limit; await loadCatalogAdmin({ policy: false }); return drawSection('catalog');
        case 'catalog-approve': {
            if (!catalogSelected.size || !ui.catalogConfirmed) return;
            const ids = [...catalogSelected];
            if (!await confirmBox(`Approve ${ids.length} selected books?`, 'This confirms their rights evidence permits publication, commercial sale, and download redistribution. Metadata visibility and file readiness are still controlled separately.', 'Approve books')) return;
            let approved = 0;
            try {
                for (let i = 0; i < ids.length; i += 500) {
                    const result = await api('/api/store/admin/catalog/approve', { body: { ids: ids.slice(i, i + 500) } });
                    approved += result.approved;
                }
            } catch (err) {
                catalogNotice = `Approved ${approved} book${approved === 1 ? '' : 's'} before the remaining approval failed: ${err.message}`;
                catalogSelected.clear();
                catalogAllEligibleSelected = false;
                ui.catalogConfirmed = false;
                await loadCatalogAdmin({ policy: false });
                drawSection('catalog');
                return;
            }
            catalogNotice = `Approved ${approved} book${approved === 1 ? '' : 's'}. Listed metadata is now visible in the storefront.`;
            catalogSelected.clear();
            catalogAllEligibleSelected = false;
            ui.catalogConfirmed = false;
            await loadCatalogAdmin({ policy: false });
            drawSection('catalog');
            return;
        }
        case 'attention': return goAttention();
        case 'resetlinks': {
            if (!await confirmBox('Reset the list?', `The ${ui.linksKind === 'audiobooks' ? 'audiobook' : 'eBook'} sites go back to the default list. Sites you added are removed.`, 'Reset', false)) return;
            if (await patch('justLinks.' + ui.linksKind, sv().defaults.justLinks[ui.linksKind])) { drawSection('libraries'); toast('Back to the original list'); }
            return;
        }
        case 'mode': {
            if (t.dataset.v === sv().access.mode) return;
            try {
                app.settings = await api('/api/mode', { body: { mode: t.dataset.v } });
                app.session.mode = t.dataset.v;
                bus.dispatchEvent(new CustomEvent('settings', { detail: app.settings }));
                await refreshStatus();
                toast({ private: 'Just me', family: 'Friends and family', public: 'Public' }[t.dataset.v] + ' mode is on');
                return drawSection('access');
            } catch (err) { return toast(err.message); }
        }
        case 'user-pw': ui.userPw = ui.userPw === t.dataset.id ? null : t.dataset.id; return drawSection('access');
        case 'user-rm': {
            const u = (sv().access.users || []).find(x => x.id === t.dataset.id); if (!u) return;
            if (!(await confirmBox(`Remove ${u.username}?`, 'They are signed out everywhere. What they downloaded stays on the shelf.', 'Remove'))) return;
            try { app.settings = await api('/api/users/' + u.id, { method: 'DELETE' }); drawSection('access'); toast('Account removed'); } catch (err) { toast(err.message); }
            return;
        }
        case 'mypw': ui.myPw = !ui.myPw; drawSection('device'); { const f = ui.myPw && $('[data-form="mypw"] [name=current]'); if (f) f.focus(); } return;
        case 'admin-login': return login({ asAdmin: true });
        case 'sessions-end': {
            if (!(await confirmBox('Sign out everywhere?', 'Every device signed in to Quiet Chapters is signed out, for every account. This browser stays signed in.', 'Sign out everywhere'))) return;
            try { await api('/api/sessions/end', { method: 'POST' }); toast('Everyone else is signed out'); } catch (err) { toast(err.message); }
            return;
        }
        case 'verify': { const z = t.dataset.site === 'zlibrary'; return openVerify(ok => { toast(ok ? `Check passed. ${z ? 'Z-Library' : "Anna's Archive"} answers again.` : 'Not passed yet'); reloadLibs(); }, z ? 'zlibrary' : 'annas'); }
        case 'forget-zlib': case 'forget-mobilism': {
            const src = t.dataset.act.slice(7);
            await api('/api/creds', { body: { [src === 'zlib' ? 'zlib' : 'mobilism']: null } }); toast('Login removed'); return reloadLibs();
        }
        case 'libs': ui.libsOpen = !ui.libsOpen; return drawSection('libraries');
        case 'slum-check': t.disabled = true; await api('/api/slum', { method: 'POST' }).catch(() => {}); await refreshStatus(); return drawSection('libraries');
        case 'linkskind': ui.linksKind = t.dataset.v; return drawSection('libraries');
        case 'rmlink': {
            const list = sv().justLinks[ui.linksKind].filter((_, i) => i !== +t.dataset.i);
            if (await patch('justLinks.' + ui.linksKind, list)) drawSection('libraries');
            return;
        }
        case 'pw-toggle': {
            const on = app.status && app.status.passwordOn;
            if (on) {
                if (!(await confirmBox('Switch the password off?', 'Anyone who can reach this address will be able to use Quiet Chapters without signing in.', 'Switch off'))) return;
                await api('/api/password', { body: { on: false } }); await refreshStatus(); return drawSection('access');
            }
            ui.pwOpen = ui.pwOpen === 'on' ? false : 'on'; drawSection('access');
            const f = $('[data-form="password"] [name=password]'); if (f) f.focus();
            return;
        }
        case 'pw-change': ui.pwOpen = ui.pwOpen === 'change' ? false : 'change'; drawSection('access'); return;
        case 'pw-cancel': ui.pwOpen = false; return drawSection('access');
        case 'key-new': ui.keyLabel = true; ui.newKey = null; drawSection('access'); $('[data-form="key"] input').focus(); return;
        case 'key-copy': return copy(ui.newKey, 'Key copied');
        case 'key-done': ui.newKey = null; return drawSection('access');
        case 'key-revoke': {
            if (!(await confirmBox('Revoke this key?', 'Scripts using it stop working straight away.', 'Revoke'))) return;
            await api('/api/keys/' + t.dataset.id, { method: 'DELETE' }); await refreshSettings(); return drawSection('access');
        }
        case 'notify-allow': await Notification.requestPermission(); return drawSection('device');
        case 'token': {
            const input = $(`[data-tpl="${ui.tplFocus}"]`);
            const pos = input.selectionStart ?? input.value.length;
            input.value = input.value.slice(0, pos) + t.dataset.v + input.value.slice(input.selectionEnd ?? pos);
            input.focus(); input.setSelectionRange(pos + t.dataset.v.length, pos + t.dataset.v.length);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        case 'qbtest': {
            // Test what is in the form, saving it first so the test and the setting agree.
            const f = $('[data-form="qbit"]');
            await saveQbit(f, true);
            return testQbit(false);
        }
        case 'vpn-open': ui.vpnOpen = !ui.vpnOpen; return drawSection('vpn');
        case 'vpn-check': ui.vpnBusy = true; drawSection('vpn'); await api('/api/vpn/check', { method: 'POST' }).catch(() => {}); ui.vpnBusy = false; await refreshStatus(); return drawSection('vpn');
        case 'vpn-switch': ui.vpnBusy = true; drawSection('vpn'); try { await api('/api/vpn/switch', { method: 'POST' }); toast('Switched exit server'); } catch (err) { toast(err.message); } ui.vpnBusy = false; await refreshStatus(); return drawSection('vpn');
        case 'update': ui.update = await api('/api/update').catch(() => ({ error: 'Could not check' })); return drawSection('system');
        case 'adv-open': ui.advOpen = !ui.advOpen; if (ui.advOpen && ui.browser == null) api('/api/browser').then(r => { ui.browser = r.ready; ui.browserSandboxed = r.sandboxed; drawSection('system'); }); return drawSection('system');
        case 'conn': ui.conn = await api('/api/connection').catch(() => ({ online: false })); return drawSection('system');
        case 'browser-restart': { const r = await api('/api/browser/restart', { method: 'POST' }).catch(() => ({ ready: false })); ui.browser = r.ready; toast(r.ready ? 'Background browser restarted' : 'The background browser is not available'); return drawSection('system'); }
        case 'signout': await api('/api/logout', { method: 'POST' }); location.href = '/'; return;
    }
}

async function saveQbit(f, quiet) {
    const d = formData(f);
    if (!d.password) delete d.password;
    try { app.settings = await api('/api/settings', { body: { qbit: d } }); if (!quiet) toast('Saved'); } catch (e) { toast(e.message); }
}

// Forms submit through one listener; it only acts while the Settings page is showing.
{
    document.addEventListener('submit', async e => {
        const f = e.target.closest('[data-form]');
        if (!f || !root || !root.contains(f)) return;
        e.preventDefault();
        const d = formData(f);
        switch (f.dataset.form) {
            case 'zlib': case 'mobilism': {
                const btn = $('button[type=submit]', f); btn.disabled = true;
                try { libs = await api('/api/creds', { body: { [f.dataset.form]: d } }); toast(f.dataset.form === 'mobilism' ? 'Saved. It joins the next search.' : 'Login saved'); }
                catch (err) { toast(err.message); }
                drawSection('libraries'); refreshStatus();
                return;
            }
            case 'addlink': {
                if (!d.url.includes('{q}')) { toast('Put {q} in the address where the search words go'); return; }
                if (!/^https?:\/\//i.test(d.url)) { toast('The address has to start with http:// or https://'); return; }
                const list = [...sv().justLinks[ui.linksKind], { name: d.name.trim(), url: d.url.trim() }];
                if (await patch('justLinks.' + ui.linksKind, list)) { drawSection('libraries'); toast('Added'); }
                return;
            }
            case 'password': {
                if (d.password !== d.password2) { toast('The two passwords are different'); return; }
                try { await api('/api/password', { body: { on: true, username: d.username, password: d.password } }); ui.pwOpen = false; await refreshSettings(); await refreshStatus(); toast('Password saved. Other browsers are signed out.'); drawSection('access'); drawSection('system'); }
                catch (err) { toast(err.message); }
                return;
            }
            case 'user': {
                try { app.settings = await api('/api/users', { body: { username: d.username, password: d.password, role: d.role } }); drawSection('access'); toast('Account added'); }
                catch (err) { toast(err.message); }
                return;
            }
            case 'userpw': {
                try { app.settings = await api('/api/users/' + f.dataset.id + '/password', { body: { password: d.password } }); ui.userPw = null; drawSection('access'); toast('Password set. They are signed out until they use it.'); }
                catch (err) { toast(err.message); }
                return;
            }
            case 'mypw': {
                if (d.password !== d.password2) { toast('The two passwords are different'); return; }
                try { await api('/api/me/password', { body: { current: d.current, password: d.password } }); ui.myPw = false; drawSection('device'); toast('Password changed. Your other browsers are signed out.'); }
                catch (err) { toast(err.message); }
                return;
            }
            case 'key': {
                try { const r = await api('/api/keys', { body: { label: d.label } }); ui.newKey = r.key; ui.keyLabel = false; await refreshSettings(); drawSection('access'); }
                catch (err) { toast(err.message); }
                return;
            }
            case 'qbit': await saveQbit(f, false); return testQbit(false);
            case 'email-test': {
                if (emailBusy) return;
                emailBusy = true; catalogError = ''; drawSection('catalog');
                try {
                    const r = await api('/api/store/admin/email/test', { body: { to: d.to } });
                    emailStatus = r.status;
                    catalogNotice = r.sent ? 'Test email sent. Check the inbox (and spam folder).' : r.waiting ? 'Test email queued. It will send once the mail server is configured.' : 'The test email could not be sent; see the error in the Email card.';
                } catch (err) { catalogError = `Test email: ${err.message}`; }
                finally { emailBusy = false; drawSection('catalog'); }
                return;
            }
            case 'source-licence': {
                const id = f.dataset.source;
                try {
                    await api(`/api/store/admin/source-licences/${encodeURIComponent(id)}`, { method: 'PUT', body: {
                        licensor: d.licensor, licence: d.licence, agreementRef: d.agreementRef, rightsScope: d.rightsScope, evidence: d.evidence,
                        expiresAt: d.expiresAt, permitsSale: !!d.permitsSale, permitsRedistribution: !!d.permitsRedistribution, confirm: !!d.confirm,
                    } });
                    sourceLicences = await api('/api/store/admin/source-licences');
                    deliveryStatus = await api('/api/store/admin/delivery').catch(() => deliveryStatus);
                    licenceOpen = ''; catalogNotice = 'Licence saved.'; catalogError = '';
                } catch (err) { catalogError = err.message; }
                drawSection('catalog');
                return;
            }
            case 'store-price': {
                const minor = Math.round(Number(d.price) * 100);
                try {
                    storePricing = await api('/api/store/admin/pricing', { method: 'PUT', body: { priceMinor: minor } });
                    catalogNotice = `Every book now costs GHS ${cedis(storePricing.priceMinor)}.`; catalogError = '';
                } catch (err) { catalogError = err.message; }
                drawSection('catalog');
                return;
            }
            case 'store-policy': {
                if (!d.confirmUniversalRights) { toast('Confirm the policy applies to all future imports'); return; }
                try {
                    catalogPolicy = await api('/api/store/admin/rights-policy', {
                        method: 'PUT', body: { license: d.license, rightsScope: d.rightsScope, rightsEvidence: d.rightsEvidence, confirmUniversalRights: true },
                    });
                    catalogNotice = 'Universal rights policy confirmed and saved. Future standard imports with this policy may be auto-approved and published; nightly review imports remain pending.';
                    catalogError = '';
                    drawSection('catalog');
                } catch (err) { toast(err.message); }
                return;
            }
            case 'vpn': {
                if (!d.apiKey) delete d.apiKey;
                try { app.settings = await api('/api/settings', { body: { vpn: d } }); toast('Saved'); await api('/api/vpn/check', { method: 'POST' }).catch(() => {}); await refreshStatus(); drawSection('vpn'); }
                catch (err) { toast(err.message); }
                return;
            }
        }
    });
}
