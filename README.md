# Away Win + BTTS Tracker

A dashboard of upcoming European football fixtures, ranked by the combined
likelihood of an **away win** and **both teams to score (BTTS)** — the two
outcomes stacked together.

**Live site:** https://alicetin1905-ux.github.io/football-dashboard/

## What it shows

For every upcoming fixture across eleven European leagues (Premier League,
Championship, La Liga, Bundesliga, 2. Bundesliga, Serie A, Ligue 1, Turkish
Süper Lig, Eredivisie, Belgian Pro League, Primeira Liga):

| Column | Meaning |
|---|---|
| Away win | Likelihood the away team wins, derived from recent form |
| BTTS | Likelihood both teams score |
| Combined | Away win × BTTS — the headline ranking metric |

Fixtures are sorted with the most likely "away win + BTTS yes" match first.
A **Rank by** toggle switches the whole view — table columns, top matches,
and sort order — to **Home win + BTTS** instead, reusing the same scoring
logic with the win side swapped (home team's home-win rate and away team's
away-loss rate, rather than the reverse). Your choice is remembered locally.
Alerts always stay tied to away win + BTTS regardless of which mode you're
viewing. A "low sample" tag marks fixtures where either team has fewer than
5 recent matches on record, since the underlying rate is noisier with less
data.

Under the top 3, a **€10 combined** card turns those three matches into an
accumulator: each leg's own likelihood is converted to implied decimal odds
(1 ÷ probability), the three are multiplied together, and that's shown
against a flat €10 stake as a potential return. These are **not** bookmaker
odds — they're our own estimate turned into odds notation — and combining
three legs compounds each one's uncertainty, so treat it as illustrative,
not a real price.

**This is not a bookmaker probability or betting advice** — it's a simplified
estimate from public/derived match data, shown for information only.

## Install it, and get alerted

The dashboard is a PWA: a manifest, a service worker (network-first, so a
deploy is never masked by a stale cache) and icons rendered straight from the
app's own meter-bar visual language. On iOS, **Share → Add to Home Screen**
gives it a real app icon, standalone chrome and offline access to the last
data you loaded.

Tap **Alerts** to be notified when a fixture clears **50% combined
likelihood** with an "ok"-confidence sample (low-sample fixtures are
excluded — a 100% score from one lucky match isn't worth an interruption),
kicking off within the next 48 hours. Each fixture only alerts once, tracked
locally so it survives a reload.

### What alerts can and cannot do

- **iOS only allows this for a Home Screen app.** Asking for permission from
  a Safari tab is denied outright, so the app detects that case and tells
  you how to install rather than appearing to fail. Requires iOS 16.4+.
- **Alerts only fire while the tab is open.** With the dashboard's data only
  refreshing every 6 hours (not a live stream), the page rechecks every 5
  minutes while visible, and immediately when you switch back to it. Nothing
  arrives while the tab or app is fully closed — true background push needs
  a server holding push subscriptions and signing with a VAPID key, which
  GitHub Pages is static and cannot provide. The service worker already
  implements the `push` handler, so pointing it at a push service later
  needs no change here.

## How the score is computed

Nothing here comes from an odds feed. Each team's recent home and away
matches are split, and from that:

```
away-win likelihood = average(home team's home-loss rate, away team's away-win rate)
BTTS likelihood      = average(home team's home-BTTS rate, away team's away-BTTS rate)
combined             = away-win likelihood × BTTS likelihood
```

Multiplying the two treats them as independent, which is a simplification —
real matches correlate them (a high-scoring away win is not the product of
two unrelated coin flips). The tradeoff is that the score stays auditable
from the two numbers shown beside it in the table, rather than hidden inside
an opaque model. See `scripts/lib/stats.mjs` for the exact logic.

## Data source

**Live, always** — `scripts/refresh.mjs` pulls from
[ESPN's public site API](https://site.api.espn.com), which needs no key, no
signup, and has shown no rate limiting under normal use. Upcoming fixtures
come from a day-by-day scoreboard sweep (there's no "next N" endpoint).
Recent team form comes from each team's own schedule endpoint rather than a
wider day sweep — early in a season that alone doesn't have enough finished
matches, so it automatically bridges into the previous season's tail to
keep sample sizes meaningful instead of flagging almost everything
"low sample" for the first couple of months. Demo data (`scripts/lib/mock.mjs`)
is only a fallback if the live fetch fails for any reason, so the dashboard
always has something to show; the meta badge in the top-left says which mode
produced the current data.

Three other routes were tried and abandoned before this one:

- **API-Football**, both via RapidAPI and direct from API-SPORTS — free tier
  blocks exactly the parameters a live-fixtures dashboard needs (`next`,
  `last`, and filtered historical queries all rejected).
- **SofaScore's own API** — `403 Forbidden` for datacenter/CI IPs.
- **football-data.org** — worked, but its free tier's fixed 13-competition
  list doesn't include the Turkish Süper Lig, and ESPN turned out simpler
  anyway (no token, no per-minute rate limit to work around).

## Running locally

```bash
npm run refresh   # builds docs/data/fixtures.json
npm run serve      # http://localhost:8080
```

No setup, no build step, no API key, no dependencies beyond Node 20+.

## Deploying

`.github/workflows/deploy.yml` refreshes the data and deploys `docs/` to
GitHub Pages on a schedule, on push to `main`, and on manual dispatch. No
secrets required.

`.github/workflows/test-data-source.yml` is a lightweight, Pages-independent
job (`workflow_dispatch` only) for a quick sanity check on the data — runs
the refresh script and prints a per-league breakdown, without touching the
live deploy.

## Layout

```
docs/                the published site (GitHub Pages root)
  index.html
  styles.css
  manifest.webmanifest PWA manifest
  sw.js                 service worker: network-first cache, push handler stub
  icons/                app icons (rendered by scripts/make-icons.mjs)
  js/app.js             filter, sort, render, alerts
  js/format.js           date/percentage formatting
  data/fixtures.json     built by scripts/refresh.mjs
scripts/refresh.mjs      the pipeline: live fetch or demo fallback, then scores + ranks
scripts/serve.mjs        local static server
scripts/make-icons.mjs   one-off icon renderer (headless Chromium) — run once, commit the output
scripts/lib/stats.mjs    the scoring logic, shared by live and demo paths
scripts/lib/espn.mjs     ESPN site-API client
scripts/lib/mock.mjs     deterministic demo data generator
```

## Caveats

- Team-level rates, not a joint model — see "How the score is computed" above.
- Demo mode generates plausible-looking but entirely synthetic results; it is
  clearly labelled "Demo data" in the UI and is not real fixture history.
- ESPN's site API is undocumented — it could change shape or start rate
  limiting without notice. If a refresh starts failing, check
  `scripts/lib/espn.mjs` against a fresh response first.
- Some fixtures still come back "low confidence" early in a season even with
  the previous-season bridge — mainly newly promoted/relegated teams, whose
  "previous season" was in a different division and so isn't queried under
  the current league's slug. This is a real data gap, not a bug.
- Extending to more leagues means adding an entry to `LEAGUES` in
  `scripts/lib/espn.mjs` with that league's ESPN slug (and to the mock
  generator if you want it in demo mode too).
- Public/derived match data, shown for information only. **Not betting advice.**

## Licence

MIT — see [LICENSE](LICENSE).
