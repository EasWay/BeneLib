# src/ : the server

Everything that runs on the RaveBSD server. Plain Node 24 ES modules, no framework, no build step. The only dependency is Playwright (optional, for the background browser). `npm start` runs `node src/server.js`.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Entry point. `node:http` server: the auth gate, cross-site guard, host check, the app API (`/api/*`), live events (`/events`), saving files to devices (`/files/<id>`), covers (`/cover`), the verify view (`/browser/*`) and the static page from `public/`. Hands search routes to `sources.js`. |
| `sources.js` | The search core: one scraper per library, link resolvers, mirror health and ordering, ranking, the merged search (`runFullSearch`) and the search routes (its default export, a `fetch(request)` handler). The header comment is a map of the file and a recipe for adding a source. |
| `pagehouse.js` | Pagehouse catalog persistence, independent of source adapters. Uses Node's built-in SQLite at `DATA_DIR/pagehouse.sqlite` (override with `PAGEHOUSE_DB_PATH`), keeps an FTS5 index, and exposes idempotent 500-record import batches plus public listings of rights-approved records. |
| `pagehouse-import.js` | Rotating-query, enabled-source catalog search; de-duplicates and caps runs at 5,000, imports in batches, and keeps nightly results pending review. |
| `pagehouse-payments.js` | Store orders and item snapshots, Paystack checkout initialization and server-side verification, HMAC-verified webhook handling, and signed short-lived download entitlements. Stores book files under `PAGEHOUSE_FILES_DIR` (default `DATA_DIR/pagehouse-files`); no provider card data is stored. |
| `pagehouse-requests.js` | Book requests (`book_requests` table): intake with a 3-open-per-email cap and a honeypot field, title/surname matching against published catalogue books (trigram similarity ≥ 0.8 plus exact surname), and `sweepRequests()`, which matches, fulfils, expires, closes and purges. `server.js` runs it hourly and after imports and approvals. |
| `webauthn.js` | Passkey verification on `node:crypto`: a small CBOR decoder, authenticator-data parsing, COSE keys (ES256, EdDSA, RS256), and registration/assertion checks (challenge, origin, RP ID hash, user presence and verification, signature, sign counter). |
| `pagehouse-library.js` | Libraries without accounts: passkeys, the signed `ph_lib` session cookie (180 days), one-time challenges, and `attachPaidMomoOrder()`, which ties a paid MoMo order's number to a Library (merging the buyer's on-device Library into it). |
| `smtp.js` | A dependency-free SMTP client (`node:net`/`tls`): STARTTLS or implicit TLS with verified certificates, AUTH PLAIN/LOGIN, a multipart text+HTML message. Never sends credentials unencrypted except to a server on this machine. |
| `pagehouse-email.js` | Store email: the `email_outbox` table, `enqueue()` (idempotent per dedupe key, called inside the caller's transaction), `processOutbox()` (daily cap, backoff; a 5xx refusal of the recipient or content is a permanent failure), templates for request received/found/expired, owner alerts, order receipts with download links, and the admin status. Logs redact addresses. |
| `config.js` | Settings (`data/settings.json`) and counts (`data/stats.json`), and `readJson`/`writeJson` for every saved file: flushed to disk, the previous copy kept as `.bak`, a damaged file never read as a first run. `DEFAULTS` is the settings schema: `patchSettings()` only accepts keys that exist there, with the same type (and a value from `CHOICES` where there is one). `publicSettings()` is what the page may see, secrets replaced by "is it set" flags. |
| `auth.js` | Accounts (scrypt), signed session cookies, visitor ids, API keys (stored as sha256), login rate limit, and `who(req)`, which decides `admin`, `user`, `visitor` or `none` for every request. |
| `jobs.js` | Downloads to the server, renaming, and the shelf (`data/shelf.json`). A job is queued, downloading, renaming or failed; when it finishes it leaves the job list and becomes a shelf item. Emits every change on `events`, which `server.js` forwards over SSE. Also visitor ownership, quotas, expiry (`tidy`) and free-space warnings. |
| `rename.js` | Naming templates (`{author}/{title} ({year}).{ext}`). Pure functions with no Node APIs, because the page imports the same file (served as `/js/rename.js`) for live previews. `safeSegment()` keeps scraped names from climbing out of the shelf folder. |
| `browser.js` | Optional background Chromium (Playwright) with one persistent profile in the data folder. Used for sites behind bot checks and for the Verify view, where a person passes a check through screenshots. Fails soft: without Playwright every function returns null or false. |
| `netguard.js` | `fetchPublic()`: links scraped off other sites (covers, files) may only reach public addresses, checked again on every redirect, so a listing cannot point the server at the owner's router or other containers. |
| `slum.js` | Reads open-slum.org (the Shadow Library Uptime Monitor) every 30 minutes and orders mirrors by status. Local health still has the last word. |
| `qbit.js` | qBittorrent Web API v2 client: log in, add a magnet in RaveBSD's category, read progress, remove, map paths between containers. |
| `vpn.js` | Gluetun control server: is the tunnel up, exit IP and place, switch exit. `vpnBlocks()` pauses searching and downloading when the tunnel drops (if the owner asked for that). |
| `zip.js` | Store-only zip writer (an audiobook folder is saved to a device as one file) and a bounded, traversal-safe `extractZip` (audiobooks that arrive zipped). No ZIP64, so nothing over 4 GB. |

## How a request flows

1. `server.js` answers `/health`, then refuses cross-site writes (`crossSite`), then asks `auth.who(req)`.
2. With nobody signing in (private mode, no password), only trusted host names are answered (`hostTrusted`, `ALLOWED_HOSTS`), which stops DNS rebinding.
3. `/api/session`, `/api/login`, `/api/logout` and `/api/setup` are always open. Page files are static. Before setup is done, only what the setup page calls answers (`SETUP_OPEN`), so an upgraded 1.x install's logins stay out of reach.
4. Non-admins may only reach the routes in `OPEN` (server.js). Everything else is admin only. `/api/v1/*` needs an `X-API-Key` whenever keys are in use, unless the caller has a signed-in session; it answers CORS preflights (`API_CORS`).
5. `/search/*`, `/resolve`, `/dl/*`, `/torrent` and `/api/v1/search` go to `sources.js`. Search answers can come from the 10-minute cache, so every JSON answer is rewritten on the way out (`jobs.liveMarks`): "On the shelf", the job and the file name are always current, and a visitor only sees their own books marked.
6. `/api/store/catalog` and `/api/store/catalog/<id>` read the persistent Pagehouse catalog. `POST /api/store/admin/catalog/import` (admin-only) upserts batches; records only appear publicly when `rights_status='approved'`. Storefront source searches go through `/api/store/source-search` and require a complete, explicitly admin-confirmed universal rights policy. The confirmation is an attestation; the application does not independently verify rights. The nightly importer searches enabled e-book adapters with rotating queries, but inserts records in review-only mode so new results remain pending.
7. Admin review supports paginated pending records and global selection of all records with complete rights fields; approval is performed in chunks of at most 500 records.
8. `POST /api/store/checkout` derives prices from SQLite and initializes a Paystack transaction; the browser never supplies the amount. Paystack `charge.success` webhooks must pass HMAC-SHA512 signature validation and a server-side transaction verification (reference, amount, currency) before an order becomes paid. `POST /api/store/orders/<reference>/verify` uses the same server-side verification. Paid orders expose short-lived, five-use signed download links only to the matching email/reference pair. Webhook is the sole cross-site POST exception and is signature protected.
9. `POST /api/store/requests` is public and rate limited per IP. `GET /api/store/requests/<RQ-ref>?email=` returns a request's status only when the email matches. `/api/store/admin/requests*` (list, sweep, close) are admin only.
10. `POST /api/store/source-results/<id>` takes a result id from the all-sources search (never a URL), maps it with `catalogItemFromResult()` (shared with the nightly importer) and calls `pagehouse.listSourceResult()`: an existing listing is reused, rejected/hidden/pending records are never published, and new ones are approved only under the confirmed universal rights policy.
11. `POST /api/store/checkout/momo` charges Mobile Money through Paystack's Charge API; `/verify` reports `pending` while the customer approves, and after a paid MoMo order puts only the browser that started it (its `ph_co` cookie) into the number's Library. `/api/store/library*` are the passkey Library routes.

## What keeps it safe

- The page never sends a URL for the server to fetch. Downloads go by result id (`getResult` in sources.js), files and covers by shelf id. Links stay on the server.
- Anything fetched from a scraped link goes through `netguard.fetchPublic`.
- File names from the internet go through `rename.safeSegment`; files are only served if `jobs.fileFor()` finds them inside a shelf folder.
- Secrets (`settings.secrets`, `settings.credentials`, `qbit.password`, `vpn.apiKey`) are never returned to the page. The admin's backup file (`/api/backup`) is the one place they leave the server.
- `viewSettings` and `viewItem` in server.js strip folders, addresses and account names for non-admins.

## Where things are listed

- **Sources**: the header comment of `sources.js` has the recipe for a new one. Each source also appears in `LIBRARIES` (`server.js`), `LIBS` (`public/js/search.js`) and `SRC_INFO` (`public/js/settings.js`), and its parser has a test in `test/sources.test.mjs`.
- **Settings**: a key in `DEFAULTS` (`config.js`), plus `CHOICES` for a choice, is saved, validated and sent to admins automatically. Non-admins only see what `viewSettings` in `server.js` passes on. The controls are drawn in `public/js/settings.js`.
- **API routes**: all live in `api()` in `server.js`, and are admin only unless listed in `OPEN`.

## Environment variables

`PORT`, `DATA_DIR`, `BOOKS_DIR`, `AUDIOBOOKS_DIR`, `API_KEY`, `USER_AGENT_MODE`, `PUBLIC_INSTANCE`, `TRUST_PROXY`, `ALLOWED_HOSTS`, `BUILD_ID`, `BROWSER_IN_CONTAINER`, `ZLIB_*`, `MOBILISM_*`, `PAGEHOUSE_DB_PATH`, `PAGEHOUSE_FILES_DIR`, `PAGEHOUSE_TOKEN_SECRET`, `PAGEHOUSE_CALLBACK_URL`, `PAYSTACK_SECRET_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `PAGEHOUSE_EMAIL_FROM`, `PAGEHOUSE_OWNER_EMAIL`, `PAGEHOUSE_PUBLIC_URL`, `PAGEHOUSE_EMAIL_DAILY_LIMIT`. `.env.example` at the root describes each one.
