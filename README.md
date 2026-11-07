# Quiet Chapters

Self-hostable feature-rich instance of [RaveBookSearch](https://ravebooksearch.com).

Search many free book and audiobook sources at once, from your own machine. RaveBSD merges the results into one ranked list and finds direct download links for you. From 2.0 it also downloads books to your server, names and shelves them for you, and saves copies to any of your devices.

> RaveBookSearch will be sunset soon, RaveBSD will be the only way to access its features moving forward. It was a good run, but the website has gotten too popular for its own good. I didn't want to completely shut it down though, so this was the next best way to keep it alive and improve on the features in ways that were previously restricted.

> **2.0 is a breaking update.** If you run 1.x, read [Upgrading from 1.x](#upgrading-from-1x) before you update. Updating the image alone is not enough.

## Screenshots

Click any screenshot to see it full size.

**Desktop**

<table>
<tr><td valign="top" align="center" width="50%"><a href="screenshots/desktop-discover.png"><img src="screenshots/thumbs/desktop-discover.jpg" alt="Discover"></a><br><sub>Discover</sub></td><td valign="top" align="center" width="50%"><a href="screenshots/desktop-advanced-search.png"><img src="screenshots/thumbs/desktop-advanced-search.jpg" alt="Advanced search"></a><br><sub>Advanced search</sub></td></tr>
<tr><td valign="top" align="center" width="50%"><a href="screenshots/desktop-searching.png"><img src="screenshots/thumbs/desktop-searching.jpg" alt="Searching"></a><br><sub>Searching</sub></td><td valign="top" align="center" width="50%"><a href="screenshots/desktop-settings-libraries.png"><img src="screenshots/thumbs/desktop-settings-libraries.jpg" alt="Settings"></a><br><sub>Settings</sub></td></tr>
<tr><td valign="top" align="center" width="50%"><a href="screenshots/desktop-results-ebooks.png"><img src="screenshots/thumbs/desktop-results-ebooks.jpg" alt="eBook results"></a><br><sub>eBook results</sub></td><td valign="top" align="center" width="50%"><a href="screenshots/desktop-results-audiobooks.png"><img src="screenshots/thumbs/desktop-results-audiobooks.jpg" alt="Audiobook results"></a><br><sub>Audiobook results</sub></td></tr>
<tr><td valign="top" align="center" width="50%"><a href="screenshots/desktop-shelf.png"><img src="screenshots/thumbs/desktop-shelf.jpg" alt="Your shelf"></a><br><sub>Your shelf</sub></td><td valign="top" align="center" width="50%"><a href="screenshots/desktop-stats.png"><img src="screenshots/thumbs/desktop-stats.jpg" alt="Stats"></a><br><sub>Stats</sub></td></tr>
</table>

**Phone**

<table>
<tr><td valign="top" align="center" width="25%"><a href="screenshots/phone-discover.png"><img src="screenshots/thumbs/phone-discover.jpg" alt="Discover"></a><br><sub>Discover</sub></td><td valign="top" align="center" width="25%"><a href="screenshots/phone-searching.png"><img src="screenshots/thumbs/phone-searching.jpg" alt="Searching"></a><br><sub>Searching</sub></td><td valign="top" align="center" width="25%"><a href="screenshots/phone-results-ebooks.png"><img src="screenshots/thumbs/phone-results-ebooks.jpg" alt="eBook results"></a><br><sub>eBook results</sub></td><td valign="top" align="center" width="25%"><a href="screenshots/phone-results-audiobooks.png"><img src="screenshots/thumbs/phone-results-audiobooks.jpg" alt="Audiobook results"></a><br><sub>Audiobook results</sub></td></tr>
<tr><td valign="top" align="center" width="25%"><a href="screenshots/phone-shelf.png"><img src="screenshots/thumbs/phone-shelf.jpg" alt="Your shelf"></a><br><sub>Your shelf</sub></td><td valign="top" align="center" width="25%"><a href="screenshots/phone-stats.png"><img src="screenshots/thumbs/phone-stats.jpg" alt="Stats"></a><br><sub>Stats</sub></td><td valign="top" align="center" width="25%"><a href="screenshots/phone-settings.png"><img src="screenshots/thumbs/phone-settings.jpg" alt="Settings"></a><br><sub>Settings</sub></td></tr>
</table>

## What's new in 2.0

- **A new look.** Results sit on a bookshelf (audiobooks as cassettes), or in a list. Works on phones as well as it does on desktops.
- **Downloads to your server.** Press Download and the server fetches the book, renames it your way (for example `Frank Herbert/Dune (1965).epub`) and files it in your eBooks or audiobooks folder. Audiobooks arrive as a folder of numbered tracks with the cover alongside, or as one file when the book is a single M4B.
- **Your shelf.** Everything on the server in one place, ready to save to whichever device you are on. eBooks can save themselves automatically.
- **Stats.** What you read most and what it costs in disk space. Counted on your server only.
- **qBittorrent.** Audiobook magnets go straight to your qBittorrent, and finished torrents are renamed and shelved like everything else.
- **VPN.** Send searches and downloads through a VPN with [Gluetun](https://github.com/qdm12/gluetun), and pause searches and downloads if the tunnel drops.
- **Three ways to run it.** Just for you, for friends and family with their own logins, or open to the public. See [Who can use it](#who-can-use-it).
- **Working mirrors first.** Mirror status from [SLUM](https://open-slum.org) decides which LibGen, Anna's Archive and Z-Library domains are tried first.
- **Notifications** when a download lands on your shelf or space runs low. Allow them in Settings under This browser (browsers only allow them over HTTPS or on `localhost`); the admin panel picks which ones are sent.

## Sources

**eBooks**

| Source | Notes |
| --- | --- |
| LibGen | Tries another mirror when one is down or overloaded |
| Anna's Archive | May ask for a one-time human check, which you complete yourself in the admin panel under Libraries |
| Z-Library | Works without an account. Adding your login makes it faster and gives direct downloads within your daily limit |
| Internet Archive | Lending-library items are left out |
| Project Gutenberg | |
| OpenStax | |
| LibreTexts | |
| Memory of the World | |
| RoyalLib | Russian-language library. Refuses connections from some countries |
| Mobilism | Needs a free account |

**Audiobooks**

| Source | Notes |
| --- | --- |
| AudiobookBay | Magnet links, sent to qBittorrent or copied, with an optional .torrent download |
| LibriVox | Whole recordings, with running time and readers |
| AudiobooksBee | Links to the file host |
| Internet Archive | Whole books, every track in one download, with running time |
| LibGen | Only the audio files it happens to hold |
| Mobilism | Needs a free account |

The results page also has link pills for many more sites that can only be opened in your browser. Add, remove or reset them in the admin panel under Libraries.

## Install

You need [Docker](https://docs.docker.com/get-docker/) with Compose.

```
git clone https://github.com/IdleEndeavor/RaveBSD.git
cd RaveBSD
mkdir data books audiobooks downloads
cp .env.example .env
docker compose up -d
```

Open <http://localhost:8080>. The first run asks who RaveBSD is for, where your books should live and whether to connect qBittorrent. Everything is included, including the background browser that some sources need, so there is nothing else to set up.

**Settings** (in the nav bar) holds the options for your own browser and account. Everything else, from source logins to folders, accounts and API keys, is in the **admin panel**: the button at the bottom of Settings. Optional settings can also go in `.env`.

If `id -u` or `id -g` is not 1000, set `PUID` and `PGID` in `.env` before starting, otherwise RaveBSD cannot save into `data/` or your book folders.

**Books somewhere else?** Set `BOOKS_PATH` and `AUDIOBOOKS_PATH` in `.env` to the folders you want, for example the ones your reading apps already use.

**Port 8080 already taken?** Set `PORT` in `.env` to any free port (for example `PORT=8686`) and run `docker compose up -d` again. Without Docker, start it with `PORT=8686 npm start`.

**Without Docker:** install Node 24, then run `npm install` and `npm start`. The background browser is downloaded automatically. Books go in `data/books` and `data/audiobooks` unless you pick other folders at first run.

**qBittorrent and Gluetun** are ready to go in `compose.yaml`: uncomment them and follow the notes there. If you edit `compose.yaml`, `./update.sh` cannot update it when a new version changes it too (it says so and updates the image only). Compose also reads a `compose.override.yaml` next to it, so your own changes can live there instead.

## Quiet Chapters store and catalog

The Quiet Chapters storefront is served at `/` and `/pagehouse.html`. Its catalog database defaults to `data/pagehouse.sqlite`, and manually supplied product files default to `data/pagehouse-files/` (override with `PAGEHOUSE_DB_PATH` and `PAGEHOUSE_FILES_DIR`). Source-hosted books are streamed without being written to disk. Catalog imports use `POST /api/store/admin/catalog/import`; public full-text search is `GET /api/store/catalog?q=...`. That import endpoint upserts submitted items; it does not crawl sources. Include a result's `coverUrl` (or `cover_url`) to retain its cover, or use its cached result `id` for cover recovery.

Storefront searches query the approved catalog and the configured e-book sources. Source searches and paid delivery are disabled until an admin saves and confirms a complete universal license, rights scope, and evidence policy (`GET`/`PUT /api/store/admin/rights-policy`). Confirmation is an admin attestation that the rights permit commercial sale and download redistribution, not independent legal verification by Quiet Chapters; it also allows regular imports with that policy to be auto-approved. Existing policies are migrated as unconfirmed, so admins must review and confirm them before source search or policy-based approval is enabled. Nightly review imports are always pending and do not inherit policy approval.

In `/admin` under **Store catalogue**, admins can apply missing policy fields to existing records (`POST /api/store/admin/rights-policy/apply-existing`), review the paginated pending queue (`GET /api/store/admin/catalog/pending-rights`), and select eligible pending books across all pages (`GET /api/store/admin/catalog/pending-rights/eligible-ids`). Approval (`POST /api/store/admin/catalog/approve`) requires complete rights details and explicit confirmation that evidence supports publication. Records without complete rights evidence cannot be approved. Rejected records remain rejected on later imports. A purchase additionally requires an approved source licence for sale and redistribution, complete approved book-level rights, and a recent successful delivery check. Admin → Store catalogue → **Delivery** shows ready / not-for-sale / unavailable counts by source; **Check now** checks up to 50 eligible books. Checks run in small batches in the background and refresh after seven days. Project Gutenberg, Internet Archive, OpenStax, LibreTexts, Memory of the World, Library Genesis, Anna's Archive, RoyalLib, and Z-Library have paid-delivery resolvers.

The admin panel also backfills missing published-book covers from exact title-and-author matches in Open Library; existing covers and publication status are preserved. Source/catalog covers use the backend's public-URL-checked image proxy. Books without cover art receive generated title covers. The [Pagehouse architecture reference](./Pagehouse-System-Architecture-Revised.html) and [78-book OpenStax CC BY metadata payload](./pagehouse-openstax-batch.json) are included for reference and manual import.

Admins can manually trigger a broad, rotating search of enabled e-book sources in **Store catalogue**. Each run imports at most 5,000 distinct results in batches, with new records left pending rights review. Five thousand is a ceiling, not a guaranteed count; results depend on source availability. Start and inspect runs through `POST`/`GET /api/store/admin/catalog/import-run`. To schedule it nightly at midnight (system local time), add a cron entry from the repository directory:

```
0 0 * * * cd /path/to/RaveBSD && PAGEHOUSE_IMPORT_URL=http://127.0.0.1:8080 node scripts/pagehouse-import.mjs
```

The script waits for the server-side run to finish and reports partial source failures. If the server requires admin sign-in, create an owner-only credential file (mode `600`) with `PAGEHOUSE_ADMIN_USERNAME=...` and `PAGEHOUSE_ADMIN_PASSWORD=...`, then add `PAGEHOUSE_IMPORT_ENV_FILE=/absolute/path/to/credentials` to the cron command. Do not put passwords directly in crontab. The manual trigger uses the same server-side run and can be used without cron.

Checkout is server-priced from catalog records and requires a Paystack secret configured only on the server (`PAYSTACK_SECRET_KEY`). The `POST /api/store/checkout` payload must include a unique, client-generated `idempotencyKey` and email, plus the selected catalog IDs; reusing the same key/cart returns the existing checkout session. Stale source checks are refreshed before payment. Set the Paystack webhook URL to `https://<your-domain>/webhooks/paystack`; successful events are signature-checked and verified against Paystack's transaction API before an order is marked paid. Buyer download links are signed, expire after 24 hours, and allow at most five uses per item. Broken remote downloads can be resumed within an hour without consuming another use. The server validates a PDF/EPUB/ZIP header before sending bytes, and source redirects must stay within the source's HTTPS host allowlist and pass the private-network guard. Use Paystack test credentials during development.

To exercise card and MoMo payments locally without Paystack keys, set `PAYSTACK_SECRET_KEY=sk_test_pagehouse_simulator_only`, `PAYSTACK_API_BASE=http://127.0.0.1:8788`, and `PAYSTACK_SIM_WEBHOOK_URL=http://127.0.0.1:8080/webhooks/paystack` in `.env`, then run `npm run paystack:sim` and `npm start` in separate terminals. The simulator binds only to localhost; card checkout has approve/decline buttons and MoMo shows a local phone-approval page. It signs webhooks with `PAYSTACK_WEBHOOK_SECRET` when set, otherwise with the test API secret. `PAYSTACK_API_BASE` is rejected unless it is an HTTP localhost or 127.0.0.1 address.

Email is sent over plain SMTP to any provider or mail server (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `PAGEHOUSE_EMAIL_FROM`; optional `PAGEHOUSE_OWNER_EMAIL`, `PAGEHOUSE_PUBLIC_URL`, `PAGEHOUSE_EMAIL_DAILY_LIMIT`, see `.env.example`). Every email is written to an outbox table in the store database in the same transaction as the event that causes it, then sent every minute with retries and backoff, within a daily cap (default 300). Without a mail server set, emails wait in the outbox and nothing is lost. Customers get emails when a request is received, found or expired, and a receipt with download links when they pay. The owner gets one for each new request. Admin → Store catalogue → Email shows the queue and sends a test.

Mobile Money is charged directly through Paystack's Charge API (`POST /api/store/checkout/momo`): the customer approves the prompt on their phone with their MoMo PIN, and the page polls `/verify` for up to three minutes. Card payments still use Paystack's hosted page. Webhooks accept Paystack's timestamped `Paystack-Signature` (set `PAYSTACK_WEBHOOK_SECRET`) and the legacy `x-paystack-signature`.

The Library replaces accounts. A customer opens it with a passkey (Face ID, fingerprint or device PIN; `/api/store/library/passkeys/*`), verified on the server without dependencies (`src/webauthn.js`). A paid MoMo order attaches the approved number to the buyer's Library, so paying with the same number on a new phone restores it there. Requests made while in a Library, and orders, are listed in it (`GET /api/store/library`). Passkeys need the site's https address (or localhost), not an IP address.

Results from the all-sources storefront search open like store books. Opening one (`POST /api/store/source-results/<result id>`) lists it in the catalogue under the confirmed universal rights policy, or finds it if it is already there, and shows the usual details, price and bag buttons. Books an admin rejected, hid or has not yet reviewed are never published this way.

Book requests: customers send a title, author and email through `POST /api/store/requests` (3 open requests per email, 5 submissions per IP an hour). A request is matched to a published book when the normalised titles have a trigram similarity of at least 0.8 and the author's surname matches. Open requests are matched hourly and after each import or approval, and expire after 30 days. Matched requests become fulfilled when that email buys the book, or close after 14 days. Closed and expired requests are deleted after 90 days. Customers see their status on the storefront through `GET /api/store/requests/<reference>?email=`. Admins manage requests under Admin → Store catalogue → Book requests.

## Update

```
./update.sh
```

It pulls the newest version, including any changes to `compose.yaml`, and restarts RaveBSD. Your `data/` folder and your books are untouched. The running version is shown at the bottom of Settings.

To update automatically, run it from cron, for example every night at 4:

```
0 4 * * * cd /path/to/RaveBSD && ./update.sh
```

## Upgrading from 1.x

2.0 changes how RaveBSD is set up, so a 1.x install needs these steps once:

```
cd /path/to/RaveBSD
git pull
mkdir -p books audiobooks downloads
docker compose pull
docker compose up -d
```

`git pull` matters: 2.0's `compose.yaml` adds the folders your books are saved to and a profile that keeps the background browser sandboxed. With the old `compose.yaml`, downloaded books stay inside the container and are lost when it is recreated. From now on `./update.sh` does this for you.

What changes:

- The **Backend page is gone.** Its options are in Settings and the admin panel.
- The **first-run setup** opens once, so you can pick who RaveBSD is for and where books go.
- Your **settings and source logins carry over.**
- **Stats start again.** 1.x counted searches, 2.0 counts downloads, so the old numbers are not carried over.
- `/api/v1/search` **still works** with the same `X-API-Key` header. Answers have a few more fields.

## Who can use it

Pick one at first run, and change it later in the admin panel under Access.

| Mode | For | Signing in |
| --- | --- | --- |
| Just me | One person | Optional password |
| Friends and family | People you know, sharing one shelf | Everyone signs in with an account you make in the admin panel. Users search, download and save; admins also run the server |
| Public | Anyone with the link | Visitors need no account. Each sees only their own downloads, within a space limit, and they are cleared after a week (both adjustable). Everything else needs the admin sign-in |

Notes:

- Admins can sign out every device at once in the admin panel under Access.
- On a public instance there are no API keys, and folders, logins and addresses stay hidden from visitors.
- `PUBLIC_INSTANCE=1` in `.env` fixes the instance to public.

## Access it from outside your home

The safest way to reach your instance from other places is still [Tailscale](https://tailscale.com) (private to your own devices) or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with Cloudflare Access in front (your own domain, with a login). Point either one at the port RaveBSD runs on.

If you open it to the internet yourself, use Friends and family or Public, never Just me without a password. Behind a reverse proxy, set `TRUST_PROXY=1` in `.env` so sign-in and visitor limits see each visitor's own address.

Just me without a password only answers to IP addresses, `localhost` and local names (`.local`, `.lan`, `.ts.net` and similar), so other websites cannot reach it through DNS tricks. If you open it by another name, list it in `ALLOWED_HOSTS`.

## Your data

Everything RaveBSD saves is in the `data/` folder next to `compose.yaml`, and your books are in `books/` and `audiobooks/` (or the folders you chose):

| File | What it holds |
| --- | --- |
| `settings.json` | Your settings, source logins and accounts (passwords are stored hashed) |
| `shelf.json` | The list of books on your shelf |
| `stats.json` | Download counts per day |
| `browser-profile/` | The background browser's saved state, including a passed Anna's Archive check |

- Nothing is sent anywhere except to the sources you search and the sites your downloads come from. The only other requests are to [SLUM](https://open-slum.org) every 30 minutes for mirror status (switch it off under Libraries), to a public torrent cache (itorrents.org) when you press Torrent file on an audiobook, to GitHub when you press Check now (for updates) and to Project Gutenberg when you press Check connection, both in the admin panel under System. Outside Docker, the background browser is also downloaded once from Playwright when you install. None of them carry your searches.
- Searches themselves are never saved, and they are not written to the logs. Recent results stay in memory for 10 minutes to speed up repeat searches and are gone after a restart.
- Stats can be switched off in the admin panel under Privacy and backup ("Keep stats"). Switching them off also deletes what was counted.

## Backup and restore

Back up the whole deployment by copying the project folder, or just the parts that matter:

```
tar czf ravebsd-backup.tgz compose.yaml .env data books audiobooks
```

To restore, unpack the archive on any machine with Docker and run `docker compose up -d` again.

For settings only, the admin panel has a backup file under Privacy and backup: settings, source logins, the shelf list and stats in one file, without the books. It holds your logins, so keep it private.

## Contributions

All contributions and improvements are welcome: fixes, new sources, translations, design, docs. Open an issue or a pull request on GitHub.

Every folder in the repository has a `development-aide.md` that explains what that part of RaveBSD does, how it connects to the rest, the names worth knowing (files, functions, classes, routes) and the rules it follows. Start with [`src/development-aide.md`](src/development-aide.md) for the server and [`public/js/development-aide.md`](public/js/development-aide.md) for the page. Run `npm test` before sending a change.

Thanks to [@matsver](https://github.com/matsver) for the first pull request ([#1](https://github.com/IdleEndeavor/RaveBSD/pull/1)), which updated the LibGen scraper to search by ISBN.

## Future plans

- Integration as a source for locally hosted instances of 4get search and SearXNG
- Integration as a plugin for Calibre

## Donations (Thank YOU!)
<a href="https://www.buymeacoffee.com/parsleyafterglow" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a>

## Contact
ravesearch.nmmw4@aleeas.com
