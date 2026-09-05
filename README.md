# GitHub Analytics

GitHub keeps 14 days of repository traffic and then throws it away. This keeps it forever — clones, views, unique visitors, top referrers and top paths, for every repository you own, on a dashboard you run yourself.

## Run it

```bash
npm start
```

That's it. No install step, no config file, no API key to paste. It finds your GitHub token from the `gh` CLI, opens `http://127.0.0.1:4319`, and starts collecting traffic for every repository you own.

## What happens on first launch

- **It finds your token.** In order: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`, then `~/.config/gh/hosts.yml`. If you're logged into the `gh` CLI, you're already done.
- **It adds your repositories.** Every repo you own with push access — GitHub's traffic API requires push permission. On a typical account that's dozens of repos discovered and polled in a few seconds.
- **It polls all four traffic endpoints** for each one: clones, views, referrers and paths.
- **The dashboard fills in while you watch.** It opens immediately and shows progress; it never blocks on the network.

After that it re-polls every 6 hours, and once on startup if anything is stale. Because GitHub still reports the last 14 days on every call, you can leave this stopped for up to 13 days and lose nothing.

## What it keeps

| Data | Granularity | Kept |
|---|---|---|
| Clones / unique cloners | one row per repo per UTC day | forever, never lowered once recorded |
| Views / unique visitors | one row per repo per UTC day | forever, never lowered once recorded |
| GitHub's own 14-day totals | one snapshot per repo per poll day | forever |
| Top referrers | one snapshot per repo per poll day | forever |
| Top paths | one snapshot per repo per poll day | forever |

Two things the dashboard says out loud, because the numbers would otherwise be easy to misread:

- **Unique counts are summed daily uniques.** Someone who visits on two days counts twice. GitHub only publishes a deduplicated figure for its own rolling 14-day window, so that one is shown separately and labelled as GitHub's.
- **Referrers and paths are a rolling 14-day total**, not a lifetime total. They're shown as a current snapshot, alongside the highest value ever recorded and the date each entry first appeared. Summing those snapshots would multiply-count badly, so it isn't done.

A stored daily figure is only ever raised, never lowered. GitHub's number for the current day grows as the day goes on, and a truncated or failed poll would otherwise erase a higher value already recorded.

## Managing repositories

Click **Manage repositories** on the dashboard. The panel opens already populated with your repositories — `Track` and `Untrack` are one click each. There's an `owner/repo` field underneath for anything the list doesn't cover, such as an organisation repo you have push access to.

**Untracking keeps the history.** It removes the repo from the dashboard and stops polling it; the rows stay in the database, and re-adding the repo brings its whole history back.

## Settings

Everything has a working default. You shouldn't need any of these.

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_TOKEN` | — | Token to use, ahead of everything else |
| `GH_TOKEN` | — | Same, checked second |
| `PORT` | `4319` | Port to bind. If it's taken, the next 20 are tried |
| `GHA_HOST` | `127.0.0.1` | Interface to bind |
| `GHA_DATA_DIR` | `~/.github-analytics` | Where the database lives |
| `GHA_DB_PATH` | `<data dir>/analytics.db` | Override the database file directly |
| `GHA_POLL_INTERVAL_HOURS` | `6` | Hours between polls |
| `GHA_AUTO_SEED` | `1` | Discover and add your repos on first launch |
| `GHA_OPEN` | `1` | Open a browser on start |
| `GHA_ALLOWED_HOSTS` | — | Extra `Host` values to accept, for a reverse proxy |
| `POSTGRES_URL` | — | Postgres/Neon connection string. When set, traffic is stored there instead of SQLite (`DATABASE_URL` also works — either name is read) |
| `GHA_POLL_MODE` | `interval`, or `cron` when `VERCEL` is set | `interval` runs the built-in timer; `cron` disables it and waits for `GET /api/poll` to be called from outside instead |
| `CRON_SECRET` | — | Bearer token required by `GET /api/poll`. With none set, that endpoint refuses every request rather than run unauthenticated |

## Your data

One SQLite file at `~/.github-analytics/analytics.db`. To back it up, either stop the server and copy the file (along with any `-wal` and `-shm` sidecars), or take a consistent copy while it runs:

```bash
sqlite3 ~/.github-analytics/analytics.db ".backup ~/analytics-backup.db"
```

The server listens on loopback only and refuses requests whose `Host` header isn't a loopback name, which stops a web page you happen to be visiting from reaching it.

## Troubleshooting

**"token: none found" in the banner.** Run `gh auth login`, or set `GITHUB_TOKEN`, then restart. The dashboard still opens without a token — it just has nothing to collect.

**A repository shows "Update failed".** Open it; the error is on the page. Almost always this is a repo you don't have push access to. GitHub's traffic API requires push permission, so read-only access isn't enough.

**The port was busy.** It moves to the next free one by itself. Read the URL in the banner.

**Node is too old.** You need Node 22.13 or newer — the database is Node's built-in `node:sqlite`, which is what lets `npm start` run locally with nothing to install.

## Running it on the internet

This app has no login of its own — no accounts, no passwords, no per-user anything. Anyone who can reach it can see every tracked repository's name and its traffic, private repos included. Putting it anywhere reachable from outside your own machine means something else has to keep other people out: a reverse proxy with basic auth for a self-hosted subdomain, or Vercel's Deployment Protection for a Vercel deployment.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for both.

## Development

```bash
npm test     # 169 passing, 1 skipped, no network access required
npm run dev  # restarts on change
```

The one skip is the Postgres conformance test, which compares SQLite and Postgres side by side — it needs a scratch database to run against (`GHA_TEST_POSTGRES_URL`), so it stays skipped unless you set that.

No build step, and no install step for local use. `package.json` lists exactly one dependency, `@neondatabase/serverless` — imported dynamically, from `src/db/postgres.js`, and only reached when `POSTGRES_URL` (or `DATABASE_URL`) is set. Run it locally against SQLite, as above, and that import is never touched. Everything else comes from the Node standard library and the browser.

| Path | What's in it |
|---|---|
| `bin/start.js` | Launcher; checks the Node version before anything imports `node:sqlite` |
| `server.js` | Wiring and lifecycle: config → token → db → poller → API → HTTP |
| `src/config.js` | Environment into a settings object |
| `src/token.js` | Zero-config token discovery |
| `src/db.js` | Schema, pragmas, UTC date helpers |
| `src/store.js` | All SQL, including the monotonic traffic upsert |
| `src/github.js` | GitHub REST client, retry and error classification |
| `src/poller.js` | Seeding, the concurrency pool, the schedule |
| `src/http.js` | Router, static files, the loopback guard |
| `src/api.js` | The JSON API |
| `public/` | The dashboard: `charts.js` (hand-rolled SVG), `views/`, `styles.css` |
