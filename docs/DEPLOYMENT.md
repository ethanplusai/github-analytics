# Deploying behind a subdomain

Running this locally needs nothing but `npm start`. This document covers the other case: keeping it running on a machine and serving it at something like `analytics.example.com`.

The shape is always the same — the app listens on loopback, a reverse proxy terminates TLS and forwards to it, and you tell the app to accept the proxied `Host`.

## Before you start: this app has no user authentication

That is deliberate and it is in the design — it's a personal tool holding one person's GitHub token and the traffic data derived from it. It has no login, no accounts, and no per-user anything.

**So if the subdomain is reachable from the internet, the proxy has to be the thing that keeps other people out.** Basic auth, an identity-aware proxy, a VPN, an IP allowlist — any of them. Both proxy examples below include basic auth for that reason. Publishing this without one puts your private repositories' traffic on the open web.

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

## Backups

Everything is one SQLite file at `$GHA_DATA_DIR/analytics.db`. This data cannot be re-fetched — that is the entire point of the project, since GitHub has already discarded anything older than 14 days. Back it up.

```bash
sqlite3 /var/lib/github-analytics/analytics.db \
  ".backup /var/backups/github-analytics-$(date +%F).db"
```

That is safe to run while the service is up. A nightly cron or timer is enough; the data only changes every 6 hours.

## What is deliberately not here

Per the design, automated deployment to the subdomain is out of scope — these are instructions, not infrastructure. There is no CI pipeline, no container image and no provisioning script, because for a single-user personal tool they'd be more to maintain than the tool itself.
