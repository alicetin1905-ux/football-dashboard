# Away Win + BTTS Tracker

A dashboard of upcoming European football fixtures, ranked by the combined
likelihood of an **away win** and **both teams to score (BTTS)** — the two
outcomes stacked together.

**Live site:** https://alicetin1905-ux.github.io/football-dashboard/

## What it shows

For every upcoming fixture across the top five European leagues (Premier
League, La Liga, Bundesliga, Serie A, Ligue 1):

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

**Demo only, for now.** `scripts/refresh.mjs` generates deterministic sample
fixtures and history (`scripts/lib/mock.mjs`), seeded by the calendar date,
so the site always has something to show. The meta badge in the top-left of
the page says so ("Demo data").

A live data source is still being evaluated. Tried so far:

- **API-Football via RapidAPI** — abandoned after subscribing to the wrong,
  similarly-named API by mistake during marketplace search.
- **API-Football direct from API-SPORTS** — auth and requests work, but the
  free plan blocks exactly the parameters a "live upcoming fixtures"
  dashboard needs (`next`, `last`, and date/round-filtered historical
  queries all returned "Free plans do not have access to..." errors). A paid
  plan would very likely be required.
- **SofaScore's public API directly** — returns `403 Forbidden` for
  datacenter/CI IPs (confirmed from a GitHub Actions runner), so it can't
  power a scheduled pipeline regardless of endpoint knowledge.

## Running locally

```bash
npm run refresh   # builds docs/data/fixtures.json (demo data)
npm run serve      # http://localhost:8080
```

No setup, no build step, no dependencies beyond Node 20+.

## Deploying

`.github/workflows/deploy.yml` refreshes the demo data and deploys `docs/` to
GitHub Pages on a schedule, on push to `main`, and on manual dispatch.

## Layout

```
docs/                the published site (GitHub Pages root)
  index.html
  styles.css
  js/app.js           filter, sort, render
  js/format.js         date/percentage formatting
  data/fixtures.json   built by scripts/refresh.mjs
scripts/refresh.mjs    the pipeline: demo data, scored + ranked
scripts/serve.mjs      local static server
scripts/lib/stats.mjs  the scoring logic
scripts/lib/mock.mjs   deterministic demo data generator
```

## Caveats

- Team-level rates, not a joint model — see "How the score is computed" above.
- Demo mode generates plausible-looking but entirely synthetic results; it is
  clearly labelled "Demo data" in the UI and is not real fixture history.
- No live data source is wired up yet — see "Data source" above.
- Public/derived match data, shown for information only. **Not betting advice.**

## Licence

MIT — see [LICENSE](LICENSE).
