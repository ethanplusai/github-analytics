# Deploying it

Running this locally needs nothing but `npm start`. This document covers the other case: keeping it running continuously and reachable from somewhere other than your own machine. There are two ways to do that, covered in turn below — on a machine you run yourself, behind a subdomain, or on Vercel with a managed Postgres database and Vercel Cron.

The self-hosted shape is always the same — the app listens on loopback, a reverse proxy terminates TLS and forwards to it, and you tell the app to accept the proxied `Host`. Vercel's shape is different: no proxy, no loopback, a Postgres database instead of the SQLite file, and Vercel Cron calling the poll endpoint instead of the app's own timer. It has its own section, [below](#deploying-to-vercel-with-neon-and-cron).

## Before you start: this app has no user authentication

That is deliberate and it is in the design — it's a personal tool holding one person's GitHub token and the traffic data derived from it. It has no login, no accounts, and no per-user anything.

**So whatever puts this on the internet has to be the thing that keeps other people out — the app will not do it for you.** Behind a reverse proxy, that means basic auth, an identity-aware proxy, a VPN, or an IP allowlist; both proxy examples below include basic auth for that reason. On Vercel it means Deployment Protection, covered in its own section with no exceptions and no shortcuts. Publishing this without one puts your private repositories' traffic on the open web.

## 1. Put the app somewhere and give it a data directory

```bash
sudo mkdir -p /opt/github-analytics /var/lib/github-analytics
sudo git clone https://github.com/<you>/github-analytics /opt/github-analytics
sudo chown -R github-analytics:github-analytics /var/lib/github-analytics
```

There is nothing to build and nothing to install — no `npm install` step exists.

On a server there is usually no `gh` CLI login to discover a token from, so set one explicitly. A fine-grained personal access token with **read access to repository administration** on the repos you want, or a classic token with `repo` scope, is what the traffic endpoints need. Remember the traffic API requires push permission on each repository.

## 2a. Run it as a service — systemd (Linux)

`/etc/systemd/system/github-analytics.service`:

```ini
[Unit]
Description=GitHub Analytics
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=github-analytics
WorkingDirectory=/opt/github-analytics
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

Environment=GHA_HOST=127.0.0.1
Environment=PORT=4319
Environment=GHA_OPEN=0
Environment=GHA_DATA_DIR=/var/lib/github-analytics
Environment=GHA_ALLOWED_HOSTS=analytics.example.com
EnvironmentFile=/etc/github-analytics.env

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/github-analytics

[Install]
WantedBy=multi-user.target
```

Keep the token out of the unit file. `/etc/github-analytics.env`, mode `600`, owned by root:

```
GITHUB_TOKEN=ghp_your_token_here
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now github-analytics
sudo journalctl -u github-analytics -f
```

You should see the startup banner in the journal within a second or two.

## 2b. Run it as a service — launchd (macOS)

`~/Library/LaunchAgents/com.example.github-analytics.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.github-analytics</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npm</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/opt/github-analytics</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GHA_HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>4319</string>
    <key>GHA_OPEN</key><string>0</string>
    <key>GHA_DATA_DIR</key><string>/Users/Shared/github-analytics</string>
    <key>GITHUB_TOKEN</key><string>ghp_your_token_here</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/github-analytics.log</string>
  <key>StandardErrorPath</key><string>/tmp/github-analytics.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.example.github-analytics.plist
```

A plist stores the token in plain text in your home directory. On a shared machine, prefer the systemd approach with a mode-`600` env file, or a wrapper script that reads from the Keychain.

## 3. Put a proxy in front of it

The app refuses any request whose `Host` header isn't a loopback name, which is what stops a web page you visit from quietly driving your local API. A proxy forwards the real hostname, so that hostname has to be allowed explicitly:

```
GHA_ALLOWED_HOSTS=analytics.example.com
```

Comma-separate if you need more than one. Without it every proxied request comes back `403 forbidden_host`.

### Caddy

```
analytics.example.com {
    basicauth {
        you $2a$14$replace_this_with_a_real_bcrypt_hash
    }
    reverse_proxy 127.0.0.1:4319
}
```

Generate the hash with `caddy hash-password`. Caddy handles the certificate itself.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name analytics.example.com;

    ssl_certificate     /etc/letsencrypt/live/analytics.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/analytics.example.com/privkey.pem;

    auth_basic           "GitHub Analytics";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass         http://127.0.0.1:4319;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name analytics.example.com;
    return 301 https://$host$request_uri;
}
```

`proxy_set_header Host $host` matters — it's what makes the forwarded hostname match `GHA_ALLOWED_HOSTS`. Leave it out and nginx sends `Host: 127.0.0.1:4319`, which happens to pass the loopback check, so the app works but your allowlist is doing nothing.

## 4. Check it

```bash
curl -u you:secret https://analytics.example.com/api/health          # {"ok":true}
curl -u you:secret https://analytics.example.com/api/status | head   # token present, repoCount climbing
```

If you get `403 forbidden_host`, `GHA_ALLOWED_HOSTS` doesn't match the hostname the proxy is forwarding.

## Deploying to Vercel, with Neon and Cron

This is the other way to keep it running: no server to patch, a managed Postgres database instead of the SQLite file, and Vercel Cron calling the poll endpoint instead of the app's own timer. Do these steps in the order given — step 5 says why that matters.

### 1. Create the project

Import the repository into Vercel from GitHub as a new project. Nothing needs to be configured beyond that; it's a plain Node HTTP server and Vercel's Node runtime serves it as-is.

### 2. Add Neon and confirm the connection string

From the project's Storage tab, add **Neon** from the Vercel Marketplace and create (or attach) a database. Once it's connected, open the project's Environment Variables and confirm `POSTGRES_URL` appears (the app also accepts `DATABASE_URL` — see the [Settings table](../README.md#settings) in the README). That variable is what switches the app from SQLite to Postgres; nothing else about the app changes.

### 3. Set the environment variables

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | A **fine-grained** personal access token with **Administration: Read-only** and **Metadata: Read-only** on the repositories to track, added to Vercel and marked **Sensitive**. This is a token you generate for this purpose — it is not what `gh auth token` prints on your own machine, and it is not a classic token scoped to `repo`. Those two read-only fine-grained permissions are everything the traffic endpoints need. |
| `CRON_SECRET` | 32 or more random characters, e.g. `openssl rand -hex 32`. Vercel Cron sends this back as `Authorization: Bearer $CRON_SECRET` automatically; see below. |
| `GHA_ALLOWED_HOSTS` | The custom domain **and** the project's own `.vercel.app` domain, comma-separated — for example `github.ethanplus.ai,github-analytics-xxxx.vercel.app`. |

**`GHA_ALLOWED_HOSTS` must list both hosts, not just the custom domain.** Vercel Cron does not call your custom domain — it calls the project's production deployment URL, the `.vercel.app` one. Leave that host out of the allowlist and the site looks perfectly healthy on the custom domain while every single cron invocation fails with `403 forbidden_host`, invisibly — the dashboard shows nothing different. The only way to notice is the function log for the run, under the project's Cron Jobs tab. Find the exact `.vercel.app` hostname on the project's Deployments tab.

### 4. Create the schema and run the migration

The Neon database Vercel provisions is empty — nothing in the app creates the schema for you. In the Neon console's SQL Editor, paste and run the contents of [`src/db/schema.postgres.sql`](../src/db/schema.postgres.sql). Then, from a machine that has the real `POSTGRES_URL` and your existing local database, copy the history over:

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  POSTGRES_URL='<value from Vercel>' node bin/migrate.js
```

It prints a line per repository and finishes with a mismatch count. That count must be zero; if it isn't, stop and investigate rather than deploy on top of a partial migration. `bin/migrate.js` opens the local SQLite file read-only, so it's safe to re-run.

### 5. Enable Deployment Protection — before the domain, not after

This step is not optional hardening. **It is the entire security boundary for this deployment.** The app has no authentication of its own — not for the dashboard, and not for its state-changing API routes either (see below) — so whatever Vercel puts in front of it is the only thing standing between a stranger who finds the URL and every tracked repository's name and full traffic history, private repositories included.

Go to Project Settings → Deployment Protection and set:

- Scope: **All Deployments**
- Method: **Vercel Authentication**

Not Standard Protection: Standard Protection deliberately leaves production domains public and only gates preview deployments, which is the wrong shape here because the production domain *is* the whole dashboard. Confirm it worked by opening the deployment's `.vercel.app` URL in a private browser window — it must show a Vercel login page, never the dashboard.

**Do this before the next step, not after.** Attaching the custom domain first and enabling protection second leaves a window, however short, where the domain is live and world-readable. That window cannot be closed after the fact — the only fix is not opening it, by doing these two steps in this order.

### 6. Attach the domain

Add the custom domain (for example `github.ethanplus.ai`) to the project and complete the DNS record Vercel gives you. Confirm the custom domain also shows the Vercel login page — the same check as step 5, now against the real hostname — before considering this done.

### Why Deployment Protection carries the whole load

It's worth being specific about what does and doesn't guard this app on its own, because the `Host` check documented earlier in this file is easy to mistake for a security boundary. It isn't one here. That check exists to stop a webpage you're browsing from driving a *loopback* server; on Vercel, `GHA_ALLOWED_HOSTS` must contain the production domain for the app to work at all, and once it does, any direct request that simply sets that `Host` header passes the guard from anywhere on the internet. The `Origin` check alongside it only rejects browser-driven cross-site requests — a plain script never sends a same-origin `Origin` header and is never touched by it.

Concretely, with Deployment Protection off, all of the following need no credentials at all:

- `POST /api/poll` — triggers a full poll of every tracked repository.
- `POST /api/repos` — adds a repository to track.
- `DELETE /api/repos/:owner/:repo` — untracks one.
- `POST /api/seed` — discovers every repository the token can read traffic for, adds all of them, and then triggers a full poll, in one call.

`GET /api/poll` is the one route with its own credential: it requires `Authorization: Bearer $CRON_SECRET`, because that's the request Vercel Cron makes. `CRON_SECRET` protects that single route and nothing else — it was never meant to be, and cannot be, the deployment's security boundary. Deployment Protection is.

One more route is worth naming even though it doesn't change anything stored: `GET /api/available-repos` is also unauthenticated and calls GitHub's API directly (list every repo the token can see), rather than the database. It changes no state, but without Deployment Protection it lets anyone spend calls against the token's GitHub API rate limit — bounded somewhat by a 5-minute in-memory cache, but still free to trigger from outside.

### A note on the cron schedule and plan

`vercel.json` schedules `GET /api/poll` every 6 hours (`0 */6 * * *`). Sub-daily cron schedules require a Vercel Pro plan. On the Hobby plan, this expression fails at deploy time, and the schedule would have to become `0 6 * * *` — once a day — instead. That is not actually a limitation for this project: GitHub's traffic API re-reports the entire last 14 days on every call, so a once-a-day poll loses no history a 6-hourly one would have caught. It's simply less current during the day.

## Backups (self-hosted / SQLite)

Everything is one SQLite file at `$GHA_DATA_DIR/analytics.db`. This data cannot be re-fetched — that is the entire point of the project, since GitHub has already discarded anything older than 14 days. Back it up.

```bash
sqlite3 /var/lib/github-analytics/analytics.db \
  ".backup /var/backups/github-analytics-$(date +%F).db"
```

That is safe to run while the service is up. A nightly cron or timer is enough; the data only changes every 6 hours.

On Vercel there is no SQLite file to back up this way — the data lives in Neon, and Neon's own point-in-time restore and branching cover this instead. That's a Neon console concern, not something this project scripts.

## What is deliberately not here

Per the design, automated deployment to the subdomain is out of scope — these are instructions, not infrastructure. There is no CI pipeline, no container image and no provisioning script, because for a single-user personal tool they'd be more to maintain than the tool itself.
