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
| Stars / forks / watchers | one row per repo per UTC day | forever, and unlike traffic these may go down |

Two things the dashboard says out loud, because the numbers would otherwise be easy to misread:

- **Unique counts are summed daily uniques.** Someone who visits on two days counts twice. GitHub only publishes a deduplicated figure for its own rolling 14-day window, so that one is shown separately and labelled as GitHub's.
- **Stars and forks carry real history; watchers do not.** GitHub publishes a
  timestamp for every star and every fork, so `bin/backfill-metrics.js`
  reconstructs those curves back to each repo's first star. It publishes
  nothing equivalent for watchers, so that series begins the day the poller
  first recorded it — the dashboard says so rather than drawing a flat zero
  line through months it cannot account for.
- **Clones and views count different things, and the dashboard shows the ratio
  rather than guessing.** A clone is a machine operation; a view is a person
  loading a page. So a repository with active CI or a deploy hook can honestly
  show hundreds of clones against almost no views. Each repo displays
  clones per unique-cloner-day, and a high number means one actor cloning
  repeatedly — typically CI or a deployment system. The figure is the plain
  arithmetic and nothing more: no repository is flagged, classified, or filtered
  out, because GitHub never says who cloned. Note the denominator sums GitHub's
  daily unique-cloner counts, so someone cloning on three days counts three
  times — it is cloner-days, not a headcount of distinct people.
- **Referrers and paths are a rolling 14-day total**, not a lifetime total. They're shown as a current snapshot, alongside the highest value ever recorded and the date each entry first appeared. Summing those snapshots would multiply-count badly, so it isn't done.

A stored **traffic** figure is only ever raised, never lowered. GitHub's number for the current day grows as the day goes on, and a truncated or failed poll would otherwise erase a higher value already recorded. Stars, forks and watchers are the deliberate exception: they can fall — someone unstars — so the newest reading for a day replaces the previous one outright.

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
| `GHA_PORT` | `4319` | Same as `PORT`, checked second |
| `GHA_HOST` | `127.0.0.1` | Interface to bind |
| `GHA_DATA_DIR` | `~/.github-analytics` | Where the database lives |
| `GHA_DB_PATH` | `<data dir>/analytics.db` | Override the database file directly |
| `GHA_POLL_INTERVAL_HOURS` | `6` | Hours between polls |
| `GHA_POLL_BATCH` | `250` | Most repositories one poll run may start. A ceiling, not a target — `GHA_POLL_DEADLINE_MS` is what actually ends a run. The default is set well above the number of repos anyone is likely to track so that every repo is covered every run; lower it only to deliberately spread a very large fleet across several runs |
| `GHA_AUTO_SEED` | `1` | Discover and add your repos on first launch |
| `GHA_OPEN` | `1` | Open a browser on start |
| `GHA_ALLOWED_HOSTS` | — | Extra `Host` values to accept, for a reverse proxy |
| `GHA_API_BASE_URL` | `https://api.github.com` | GitHub API base URL. Override to point at a mock server for testing |
| `POSTGRES_URL` | — | Postgres/Neon connection string. When set, traffic is stored there instead of SQLite (`DATABASE_URL` also works — either name is read) |
| `GHA_POLL_MODE` | `interval`, or `cron` when `VERCEL` is set | `interval` runs the built-in timer; `cron` disables it and waits for `GET /api/poll` to be called from outside instead |
| `CRON_SECRET` | — | Bearer token required by `GET /api/poll`. With none set, that endpoint refuses every request rather than run unauthenticated |
| `GHA_POLL_DEADLINE_MS` | `45000` | How long `GET /api/poll` may run before it stops starting new repos and returns. Must stay below the deployment's function `maxDuration` (`vercel.json` sets that to `60` seconds on Vercel's Hobby plan) — otherwise the platform kills the invocation first and the poll lock isn't released until its TTL expires |
| `GHA_PASSWORD` | — | Passphrase for the built-in login. When set, every route except `GET /api/poll` requires a signed session cookie, issued at `/login`. Once the app is reachable beyond loopback — serverless (`VERCEL` set), or self-hosted with `GHA_ALLOWED_HOSTS` set — it refuses to start with this unset unless `GHA_ALLOW_PUBLIC=1` is also set, and refuses a passphrase whose trimmed length is under 20 characters. Use a password manager's generated value, not a memorable phrase — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| `GHA_ALLOW_PUBLIC` | `0` | Deliberate override that lets a deployment reachable beyond loopback start with no `GHA_PASSWORD`. Doing so puts every tracked repository's name and full traffic history on the open web for anyone who finds the URL |
| `GHA_SECURE_COOKIES` | Auto: on when reachable beyond loopback (`VERCEL` set, or `GHA_ALLOWED_HOSTS` set), off otherwise | Overrides whether the session cookie is issued `Secure` and `__Host-`-prefixed. Setting it to `0` removes these protections: the session cookie can travel in cleartext and can be shadowed by a sibling subdomain. On a public HTTPS deployment, this strips security the login depends on. Only set to `0` when TLS is terminated by a layer this app cannot see, and only if you understand the trade. The default is correct for both documented public deployment shapes |

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

## Backfilling star and fork history

Polling records stars, forks and watchers from the day you start. GitHub still
publishes a timestamp for every individual star and fork, so the history before
that is recoverable:

```bash
node bin/backfill-metrics.js
```

It walks every tracked repository, reconstructs a cumulative daily curve from
those timestamps, and writes one row per day. **It is safe to re-run**: a day
already recorded is left alone, so a real reading taken by the poller is never
replaced by a reconstruction. Re-running it writes nothing and says so.

It targets `POSTGRES_URL`/`DATABASE_URL` when set and the local SQLite database
otherwise, and exits non-zero if any repository failed — a repository that has
since been deleted or renamed on GitHub returns 404 and is reported by name,
while its stored traffic history is left untouched.

Backfilled rows carry no watcher count. GitHub publishes no timestamp for
subscribers, so any number there would be invented.

**What the reconstruction can and cannot see.** GitHub's stargazer and fork lists
contain only the people who *currently* star or fork a repository, each with the
date they arrived. So the rebuilt curve answers "when did today's stargazers
arrive?", not "how many stars did this repo have on that day". Anyone who starred
and later unstarred is absent from the whole history, which means a past peak that
has since receded is invisible and the curve can never fall. Expect a small step
where the reconstruction meets the first polled day: the backfill counts forks that
exist now and were created then, while the poller records GitHub's live
`forks_count`, and the two are not the same number if a fork's parent has since
gone private or been deleted. Everything recorded from the first poll onward is a
direct reading and has none of these caveats.

## Running it on the internet

The app has an optional login (`GHA_PASSWORD`): a single shared passphrase, a signed session cookie, no accounts and no per-user anything. It's off by default for local use. Anyone who can reach an instance with it off can see every tracked repository's name and its traffic, private repos included, so it is **required** for any public deployment that holds private repositories.

Self-hosted, a reverse proxy with basic auth (or an identity-aware proxy, a VPN, or an IP allowlist) can stand in for it — but the app doesn't know that boundary exists, so it still needs telling: pair it with `GHA_ALLOW_PUBLIC=1`, or the app refuses to start the moment `GHA_ALLOWED_HOSTS` is set (which self-hosting behind a proxy requires) with no `GHA_PASSWORD`. On Vercel's Hobby plan, `GHA_PASSWORD` is the only option — production domains can't be put behind Vercel's own protection there. Either way, the app enforces this itself at startup: it refuses to start once it's reachable beyond loopback without either `GHA_PASSWORD` or a deliberate `GHA_ALLOW_PUBLIC=1`.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full picture, including what to check after deploying.

## Development

```bash
npm test     # 295 passing, 1 skipped, no network access required
npm run dev  # restarts on change
```

The one skip is the Postgres conformance test, which compares SQLite and Postgres side by side — it needs a scratch database to run against (`GHA_TEST_POSTGRES_URL`), so it stays skipped unless you set that.

No build step, and no install step for local use. `package.json` lists exactly one dependency, `@neondatabase/serverless` — imported dynamically, from `src/db/postgres.js`, and only reached when `POSTGRES_URL` (or `DATABASE_URL`) is set. Run it locally against SQLite, as above, and that import is never touched. Everything else comes from the Node standard library and the browser.

| Path | What's in it |
|---|---|
| `bin/start.js` | Launcher; checks the Node version before anything imports `node:sqlite` |
| `bin/backfill-metrics.js` | One-off: rebuilds star and fork history from GitHub's timestamps |
| `server.js` | Wiring and lifecycle: config → token → db → poller → API → HTTP |
| `src/config.js` | Environment into a settings object |
| `src/token.js` | Zero-config token discovery |
| `src/db.js` | Schema, pragmas, UTC date helpers |
| `src/store.js` | All SQL: the monotonic traffic upsert, and the deliberately non-monotonic metrics one |
| `src/github.js` | GitHub REST client, retry and error classification |
| `src/poller.js` | Seeding, the concurrency pool, the schedule |
| `src/http.js` | Router, static files, the loopback guard |
| `src/api.js` | The JSON API |
| `web/` | The dashboard: `charts.js` (hand-rolled SVG), `views/`, `styles.css` |
