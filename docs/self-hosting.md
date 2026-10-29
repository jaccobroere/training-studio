# Self-hosting Training Studio

Training Studio is built to be run by one person (the operator) for themselves and a few
friends. Accounts are invite-only and there is no admin role in the app: everything an
operator does happens on the server, through Docker Compose and a small CLI. The CLI never
prints anyone's training or health data.

For local development without Docker, see [`development.md`](development.md). Background on
why things work this way: decisions 19–20, 23 and 38–41 in [`DECISIONS.md`](DECISIONS.md).

## Quick start

Requirements: Docker with the Compose plugin, and about 1 GB of RAM to spare (more for
large Garmin imports).

```sh
git clone <this repository> training-studio && cd training-studio
cp .env.example .env && chmod 600 .env    # optional: every value has a default
$EDITOR .env                              # at least OLLAMA_API_KEY for the assistant

# Optional: the Garmin token key (see "Garmin token key" below)
mkdir -p secrets && openssl rand -base64 32 | tr '+/' '-_' > secrets/garmin_token.key \
  && chmod 644 secrets/garmin_token.key

docker compose up -d --build
docker compose exec app python -m accounts.admin create <username>
```

Open <http://localhost:8080>, sign in with the printed temporary password and choose your own.

`docker compose up -d --build` starts four services:

| Service | What it does |
|---|---|
| `static` | One-shot: copies the SPA build from the app image into the `static` volume, then exits 0. |
| `app` | FastAPI on port 8080 (internal only). Runs as uid 10001 with a read-only root filesystem; all data lives in the named volume `data`, mounted at `/app/data`. |
| `pyrunner` | The sandbox for assistant analyses. Only on the internal `analysis` network: no egress, no secrets, read-only, resource-limited. |
| `caddy` | The bundled Caddy 2 front door (`./Caddyfile`): serves the SPA from the `static` volume, proxies `/api/*` and `/health` to `app`, sets the CSP and other security headers, and caps request bodies (101 MiB on upload routes, 1 MB elsewhere). |

Check it is up: `docker compose ps -a` shows `app` and `pyrunner` healthy and `static`
"Exited (0)", and `scripts/smoke.sh [base-url]` (default `http://localhost:8080`) checks that
`/health` and the app shell answer and every data API refuses anonymous requests with 401.

## Configuration (`.env`)

Copy `.env.example` to `.env`; it documents every variable. An empty value counts as unset,
and a bad value stops the app at startup with one error naming the variable (never its
value). The ones an operator usually touches:

| Variable | Default | Purpose |
|---|---|---|
| `HTTP_PORT` | `8080` | Host port for HTTP. |
| `HTTPS_PORT` | `8443` | Host port for HTTPS (used only when `SITE_ADDRESS` is a domain). |
| `SITE_ADDRESS` | `:80` | Caddy's site address. `:80` is plain HTTP on `HTTP_PORT`. A domain such as `training.example.com` (with `HTTP_PORT=80`, `HTTPS_PORT=443` and DNS pointing at the host) gets automatic Let's Encrypt HTTPS. |
| `TRUSTED_PROXIES` | `127.0.0.1/32` | Proxies whose `X-Forwarded-*` headers Caddy honours. Set to e.g. `private_ranges` behind another TLS-terminating proxy. |
| `PUBLIC_URL` | `http://localhost:8080` | The address shown in invite messages. |
| `OLLAMA_API_KEY` | unset | Ollama Cloud key for the assistant (and its web search/fetch). Without it the assistant reports unavailable; everything else works. |
| `OLLAMA_MODEL` | `deepseek-v4.1-flash:1017` | Model name (`SPORTS_MODEL`, if set, wins). |
| `ATHLETE_TZ` | `Europe/Amsterdam` | Time zone for "today" and the weekly limit reset. |
| `ASSISTANT_WEEKLY_TURNS` | `200` | Assistant turns per account per week (see "Assistant key and limits"). |
| `USER_STORAGE_QUOTA_MB` | `4096` | Disk use per account. |
| `APP_IMAGE` | `ghcr.io/jaccobroere/training-studio:latest` | Image used by `app`, `static` and `pyrunner`. |
| `CADDY_IMAGE` | `caddy:2.11.7` (digest-pinned) | Image for the bundled front door. |

Alerts and feedback forwarding are covered in their own sections below.

## HTTPS, sessions and reverse proxies

Sessions are a hashed random token in an HttpOnly cookie. Over HTTPS the app sets
`__Host-sts_session` with `Secure`; over plain HTTP (e.g. the first run on
`http://localhost:8080`) it falls back to the unprefixed `sts_session` cookie. Plain HTTP is
fine for localhost or a trusted LAN; use HTTPS for anything beyond that, since passwords and
session cookies otherwise cross the network in the clear.

Three ways to run it:

1. **Localhost or LAN:** the defaults. Plain HTTP on port 8080.
2. **Bundled Caddy with automatic HTTPS:** point a DNS record at the host, then in `.env`
   set `SITE_ADDRESS=training.example.com`, `HTTP_PORT=80`, `HTTPS_PORT=443` and
   `PUBLIC_URL=https://training.example.com`. Ports 80 and 443 must be reachable from the
   internet for the ACME challenge. Certificates live in the `caddy_data` volume.
3. **Behind your own reverse proxy** (Traefik, nginx, another Caddy) that terminates TLS:
   keep `SITE_ADDRESS=:80`, point the outer proxy at `HTTP_PORT`, and set
   `TRUSTED_PROXIES` to the outer proxy's address (or `private_ranges`) so its
   `X-Forwarded-Proto: https` reaches the app and the Secure cookie is used. The outer proxy
   must:
   - **preserve the `Host` header** (or set `X-Forwarded-Host`): writes (POST, PUT, PATCH,
     DELETE) are checked same-origin by comparing `Sec-Fetch-Site`/`Origin` with
     `Host`/`X-Forwarded-Host`, so a rewritten Host makes every write fail with 403;
   - not buffer responses on `/api/chat` (assistant replies are streamed as server-sent
     events);
   - allow request bodies up to 101 MiB on the upload routes, and a few minutes to read them.

   Keep the security headers from `./Caddyfile`; the outer proxy should not strip them.

The app does not trust any identity header (such as `Remote-User`) from a proxy: its own
accounts are the gate. Putting an SSO gate in front is possible but not needed.

**Rate limiting.** The stock Caddy image has no rate-limit plugin. The app rate-limits
sign-in itself: 10 attempts per IP per 15 minutes and 20 per username per hour; a wrong
password is a 401, which fail2ban-style tooling at your edge can act on if you want more.
For per-IP limits to see real client addresses behind another proxy, `TRUSTED_PROXIES` must
be set as above.

## Accounts: the `accounts.admin` CLI

In this section `admin` is short for:

```sh
docker compose exec app python -m accounts.admin
```

| Command | What it does |
|---|---|
| `admin list` | Accounts, created and last sign-in dates, storage used vs quota, flags (`disabled`, `must-change-password`). |
| `admin create <username>` | Invite: creates the account with a random temporary password and prints a message to send. 3–32 characters: letters, digits, dot, dash, underscore. |
| `admin reset-password <username>` | Prints a one-time password; they must change it at the next sign-in; all their sessions are signed out. |
| `admin disable <username>` | They can't sign in; all sessions end; data stays. |
| `admin enable <username>` | Undoes `disable`. |
| `admin delete <username>` | Asks you to type the username, keeps a copy of their folder under `data/deleted/`, then removes the account and its data. |
| `admin set-limit <username> <n\|default\|-1>` | Their weekly assistant turns: a number, back to `ASSISTANT_WEEKLY_TURNS`, or unlimited. |
| `admin usage` | This week's assistant turns per account, and the total vs the global cap. |
| `admin reset-usage <username>` | Forget their assistant turns this week (e.g. after a runaway thread). |
| `admin restore <username> <archive.zip>` | Restore a personal archive (Settings → Data → Download archive) into an **empty** account. Copy the zip into the container first, e.g. `docker compose cp archive.zip app:/app/data/tmp/`. |

### Inviting someone

```sh
admin create <username>
```

prints a message you can paste into a chat as it is:

```text
Hi! Here's your account for Training Studio, the training app I run for friends.

  http://localhost:8080
  Username: <username>
  Temporary password: <temporary password>

You'll pick your own password on first login.
```

The address comes from `PUBLIC_URL`; set it to the URL your friends actually use. At their
first sign-in they must choose their own password; after that they see the privacy note once
(it can be read again under Settings → Account → Privacy). Send the message over a private
chat, since the temporary password works until they change it.

### Forgotten passwords

There is no email on accounts, so the operator is the reset: `admin reset-password
<username>`, and send the one-time password the same way.

### Storage

Each account may use `USER_STORAGE_QUOTA_MB` (default 4096). Past it, or when the host has
under 5 GiB free, uploads are refused with a clear message. `admin list` shows who is using
what. The app's own boot-time database copies (`backups/`) don't count against the quota.

### Data requests

- **A copy of their data:** they download it themselves under Settings → Data → Download
  archive (database rows as JSON lines, the SQLite file, original Garmin files, streams and
  media; never Garmin tokens or keys). Five archives per hour per account.
- **Delete everything:** they can do it in Settings → Account (password plus typed
  username), or you run `admin delete <username>`. Their data is removed right away; the
  safety copy under `data/deleted/` is removed by the app after 7 days (checked at startup
  and daily). Copies in your own backups disappear as those backups rotate out.
- **Restore an archive** into an empty account: `admin restore` (above).

**Privacy note.** The in-app privacy note (`frontend/src/privacy/PrivacyNotice.tsx`) tells
people that backups and how long they are kept are up to you, and to ask you about them. Be
ready to answer, or edit that text to state what you actually do.

## Garmin token key

Garmin sync is optional. Each person connects their own Garmin account in Settings →
Connections (the Garmin password is used once, in memory, and never stored); only
refreshable tokens are kept, encrypted with a Fernet key as `users/<id>/garmin/tokens.enc`.

```sh
mkdir -p secrets
openssl rand -base64 32 | tr '+/' '-_' > secrets/garmin_token.key
chmod 644 secrets/garmin_token.key
```

(`python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`
gives an equally valid key.) The file must be readable by uid 10001 inside the container,
hence mode 644. Compose bind-mounts `./secrets` read-only at
`/run/secrets/training-studio` and sets
`GARMIN_TOKEN_KEY_FILE=/run/secrets/training-studio/garmin_token.key`. Restart the app after
adding or changing the key: `docker compose restart app`.

- **Without a key** (or with an unreadable or invalid one), Garmin connect and sync are off
  with a clear message in Settings → Connections. Everything else works, including uploading
  a Garmin full-account export ZIP or single `.fit` files on the same page: that import path
  does not need the key.
- **Keep the key out of backups of the data volume**, so a leaked backup never carries the
  key next to the tokens it encrypts, but **keep a copy in a password manager**, so a restore
  keeps everyone's Garmin connection.
- **If the key is lost**, nothing but the Garmin connection is lost: activities, health data
  and plans are untouched. Write a new key, restart the app, and ask each person who used
  Garmin sync to press **Connect Garmin** again; their old tokens can't be decrypted and are
  replaced on reconnect.

Garmin specifics worth knowing: three connect attempts per person per 24 hours, and the
background sync never signs in by itself, so the app cannot get a Garmin account locked.
Automatic sync runs every 1/2/6/12/24 hours (per person), a backfill fetches up to five years
(slowly, pausing on Garmin rate limits), and older history can come from the full-account
export (garmin.com → Account → Data Management → Export your data). Uploads are capped at
100 MiB per file; re-uploading is safe.

### When syncs fail

A failed scheduled pull postpones the next one (5 minutes, doubling up to the person's sync
interval), and the worker refuses to schedule more than 12 failed pulls per account per
hour. Recent runs and their errors are listed in Settings → Connections. Common causes: an
expired Garmin sign-in (the person reconnects), a missing or unreadable key (check the file
mode and the mount, then restart), or Garmin rate limits (the sync pauses for 6 hours and
resumes by itself). `docker compose logs app` shows the details; logs never contain request
paths or training content.

## Assistant key and limits

One Ollama Cloud key (`OLLAMA_API_KEY`) is shared by every account, so one busy account can
use up the key's allowance for everyone. The limits exist for that:

- `ASSISTANT_WEEKLY_TURNS` (default 200): turns per account per week, resetting Monday
  00:00 in `ATHLETE_TZ`. Per-account overrides with `admin set-limit`.
- `ASSISTANT_GLOBAL_WEEKLY_TURNS` (default 1000; `-1` = no cap): turns across all accounts
  per week; past it the assistant pauses for everyone until Monday.
- `ASSISTANT_PER_MINUTE` (default 6) and `ASSISTANT_CONCURRENCY` (turns in flight across all
  users, default 4); `ASSISTANT_MAX_STEPS` (model requests per turn, default 16).

Check `admin usage` and lower someone's limit if the provider starts answering 429 (the app
then reports the assistant as busy or unavailable). Messages, attachments and the data the
assistant reads are sent to the model provider; say so to the people you invite.

## Runaway alerts

The app watches itself for the ways a bug can burn the disk or a Garmin account, and posts a
warning when one trips:

- **Failed import runs:** `ALERT_FAILED_RUNS_PER_HOUR` (default 6) failed Garmin pulls or
  archive/FIT imports for one account in the last hour.
- **Storage growth:** `ALERT_STORAGE_GROWTH_MB` (default 500) grown in one day for one
  account.
- **Free disk:** under `ALERT_FREE_DISK_MB` (default 8192) free on the data disk (uploads
  stop below 5 GiB, so this is the early warning).

Set `ALERT_WEBHOOK_URL` to any webhook that accepts a JSON POST (a chat or push-notification
service, an automation tool). Each alert is one body:

```json
{"app": "sports", "title": "…", "message": "…", "at": "2026-01-01T12:00:00Z"}
```

If `ALERT_WEBHOOK_TOKEN` is set it is sent as the `X-Sports-Token` header, so the receiver
can reject anything else. With `ALERT_WEBHOOK_URL` unset the same warnings go to the app log
only. Alerts repeat at most once per six hours per problem; a failed POST is retried at the
next five-minute check.

## Feedback forwarding (optional)

People can send feedback (bug, idea, other, with optional screenshots) from Settings →
Account → Feedback. It is always stored in their own database first. To also receive it,
set both:

```sh
FEEDBACK_WEBHOOK_URL=https://hooks.example.com/training-feedback
FEEDBACK_WEBHOOK_SECRET=<32+ random bytes, e.g. openssl rand -hex 32>
```

The job loop POSTs one JSON body per note (`event`, `feedback_id`, `user_id`, `username`,
`kind`, `message`, `context`, `triage`, `created_at`, `attachments` with base64 screenshots)
with the secret in the `X-Sports-Token` header. Failures back off and give up after ten
attempts; the person sees **couldn't send** with a Retry button. A URL without a secret
fails closed. With `FEEDBACK_WEBHOOK_URL` unset, feedback is stored locally only.
No training or health data is attached automatically, and the person can turn context off.
`FEEDBACK_ENRICH` (default on) triages notes with the assistant model before sending.

## Backups

Everything irreplaceable is in the `data` volume, named `<project>_data` on the host (the
Compose project defaults to the directory name, so usually `training-studio_data`; check
with `docker volume ls`):

- `auth.db`: accounts, sessions, limits, usage;
- `users/<id>/`: per account `app.db`, raw Garmin files, streams, `media/` (images and
  attachments) and `garmin/tokens.enc`;
- `backups/` next to each database: the app's own boot-time copies (redundant in a backup);
- `tmp/`: scratch space, emptied on every start.

Also back up `.env` (it holds your keys) somewhere safe, but keep `secrets/garmin_token.key`
out of the data backup (password manager instead, see above).

The databases use SQLite WAL mode, so copying the files of a running app can give an
inconsistent snapshot. Use the bundled script instead, with the stack running:

```sh
scripts/backup.sh backups/$(date +%F)
```

It writes `databases/auth.db` and `databases/users/<id>/app.db` (online SQLite backups, each
integrity-checked) and `raw-files.tar.gz` (everything else in the data volume except the
live database files, `backups/` and `tmp/`). It does not include `.env` or `secrets/`. Run it
from cron, copy the directory off the machine, encrypt it (it holds people's health data),
and rotate old copies. Test a restore now and then.

**Restoring**, with the app stopped (`docker compose stop app`): put the databases and raw
files back into the volume as the app's uid, then start it again:

```sh
docker compose stop app
docker run --rm --user 10001:10001 -v training-studio_data:/app/data \
  -v "$PWD/backups/YYYY-MM-DD:/backup:ro" alpine:3.20 sh -euc '
    cd /app/data
    tar xzf /backup/raw-files.tar.gz
    cd /backup/databases
    for db in $(find . -name "*.db"); do
      mkdir -p "/app/data/$(dirname "$db")"
      rm -f "/app/data/$db-wal" "/app/data/$db-shm"
      cp "$db" "/app/data/$db"
    done'
docker compose start app
```

To restore a single account, copy only `databases/users/<id>/app.db` (removing its
`-wal`/`-shm`) and that user's files from `raw-files.tar.gz` back under `users/<id>/`.

The in-app **Settings → Data → Download archive** is a per-person portable export (restored
with `admin restore`); it does not replace server backups.

## Upgrading

```sh
git pull
docker compose up -d --build
```

Or, to use the prebuilt image instead of building locally: `docker compose pull && docker
compose up -d` (set `APP_IMAGE` in `.env` to pin a specific tag). The `static` service
republishes the SPA on every start. Database migrations run automatically the first time
each database is opened after an upgrade; the app takes a copy into `backups/` next to the
database first. Data in the `data` volume survives upgrades and `docker compose down`
(only `docker compose down -v` deletes volumes). Take a backup before upgrading anyway.

## Optional hardening: gVisor for the sandbox

`pyrunner` is already isolated (internal network, read-only, no capabilities, non-root,
resource limits). If your kernel and Docker support [gVisor](https://gvisor.dev/), you can
add a second layer: install `runsc`, check that
`docker run --rm --runtime=runsc python:3.12-slim python -c "print('ok')"` prints `ok`, then
add `runtime: runsc` under the `pyrunner` service in `compose.yml`.

Quick isolation checks:

```sh
docker compose exec pyrunner python -c "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)" \
  && echo "FAIL: pyrunner has network" || echo "ok: no egress"
docker compose exec pyrunner env | grep -iE 'key|token|pass' && echo "FAIL: secrets present" || echo "ok: no secrets"
```
