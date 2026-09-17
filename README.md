# Away Win + BTTS Tracker

A dashboard of upcoming European football fixtures, ranked by the combined
likelihood of an **away win** and **both teams to score (BTTS)** — the two
outcomes stacked together.

**Live site:** https://alicetin1905-ux.github.io/football-dashboard/

## What it shows

For every upcoming fixture across six European leagues (Premier League, La
Liga, Bundesliga, Serie A, Ligue 1, Turkish Süper Lig):

| Column | Meaning |
|---|---|
| Away win | Likelihood the away team wins, derived from recent form |
| BTTS | Likelihood both teams score |
| Combined | Away win × BTTS — the headline ranking metric |

Fixtures are sorted with the most likely "away win + BTTS yes" match first.
A "low sample" tag marks fixtures where either team has fewer than 5 recent
matches on record, since the underlying rate is noisier with less data.

**This is not a bookmaker probability or betting advice** — it's a simplified
estimate from public/derived match data, shown for information only.

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
signup, and has shown no rate limiting under normal use. There's no single
"whole season" endpoint, so the pipeline sweeps day-by-day scoreboard
requests across a window (21 days back, 10 days forward, per league) and
derives both recent team form and upcoming fixtures from that same sweep —
about 190 requests per refresh, all unauthenticated. Demo data
(`scripts/lib/mock.mjs`) is only a fallback if that live fetch fails for any
reason, so the dashboard always has something to show; the meta badge in the
top-left says which mode produced the current data.

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
  js/app.js           filter, sort, render
  js/format.js         date/percentage formatting
  data/fixtures.json   built by scripts/refresh.mjs
scripts/refresh.mjs    the pipeline: live fetch or demo fallback, then scores + ranks
scripts/serve.mjs      local static server
scripts/lib/stats.mjs  the scoring logic, shared by live and demo paths
scripts/lib/espn.mjs   ESPN site-API client
scripts/lib/mock.mjs   deterministic demo data generator
```

## Caveats

- Team-level rates, not a joint model — see "How the score is computed" above.
- Demo mode generates plausible-looking but entirely synthetic results; it is
  clearly labelled "Demo data" in the UI and is not real fixture history.
- ESPN's site API is undocumented — it could change shape or start rate
  limiting without notice. If a refresh starts failing, check
  `scripts/lib/espn.mjs` against a fresh response first.
- Early in a season, most fixtures come back "low confidence" (each team has
  only 1-2 home/away matches on record). This is correct behaviour, not a
  bug — it fills in as more matchdays are played.
- Extending to more leagues means adding an entry to `LEAGUES` in
  `scripts/lib/espn.mjs` with that league's ESPN slug (and to the mock
  generator if you want it in demo mode too).
- Public/derived match data, shown for information only. **Not betting advice.**

## Licence

MIT — see [LICENSE](LICENSE).
