# Away Win + BTTS Tracker

A dashboard of upcoming European football fixtures, ranked by the combined
likelihood of an **away win** and **both teams to score (BTTS)** — the two
outcomes stacked together.

**Live site:** https://alicetin1905-ux.github.io/football-dashboard/

A dark, gradient-and-glow "HUD" look: cyan/violet accents (validated with the
dataviz six-checks palette validator against this page's own dark surface),
gradient meter bars and headline numbers, and Orbitron for headings/figures
over the system sans for body and table text — kept to headings and short
labels specifically so dense text (team names, the methodology footer)
stays in a legible face rather than a display one throughout.

## What it shows

For every upcoming fixture across eleven European club leagues (Premier
League, Championship, La Liga, Bundesliga, 2. Bundesliga, Serie A, Ligue 1,
Turkish Süper Lig, Eredivisie, Belgian Pro League, Primeira Liga) plus the
UEFA Champions League, UEFA Europa League and UEFA Nations League:

| Column | Meaning |
|---|---|
| Away win | Likelihood the away team wins, derived from recent form |
| BTTS | Likelihood both teams score |
| Combined | Away win × BTTS — the headline ranking metric |

A **Day** filter narrows everything — top matches, the combined bet slip,
and the table — to one day (Friday, Saturday, Sunday, ...) or back to
**All weekend**; within whatever's selected, the most likely "away win +
BTTS yes" match is still first.
A **Rank by** toggle switches the whole view — table columns, top matches,
and sort order — between eight modes, all read off the same underlying
score matrix:

| Mode | What it needs | Backtested hit rate |
|---|---|---|
| Away win + BTTS | Away team wins, both teams score | ~17% |
| Home win + BTTS | Home team wins, both teams score | ~21% |
| Draw | Match ends level — no BTTS attached | ~30% |
| Away win | Away team wins — no BTTS attached | ~30% |
| Home win | Home team wins — no BTTS attached | ~40% |
| Home/Draw + BTTS | Home team avoids defeat (double chance), both teams score | ~42% |
| BTTS + Over 2.5 | Both teams score, 3+ total goals — not tied to either team winning | ~48% |
| **Best of all modes** | Whichever of the other seven has the highest probability *for that specific fixture* | ~50% |

**Best of all modes** doesn't apply one fixed bet to every match — for each
fixture it compares all seven other modes' probabilities (all read off the
same score matrix, so the comparison is coherent) and ranks by whichever
one is highest, tagging each row with which mode won. It's the highest
backtested hit rate of any mode here, which makes sense: it's always
picking the easiest bar to clear for that particular match rather than
committing to one bar for all of them.

Picking a maximum across several estimates like this has a well-known bias
— a "winner's curse" that favors whichever estimate happened to get the
most positive noise, not necessarily the genuinely best bet. We found this
the hard way: checking the app's top picks against real bookmaker odds
showed the raw version running 15-35 points more confident than the
market on every single match checked, and backtesting confirmed it —
average predicted probability was 61.9% against a 50.0% actual hit rate.

The first fix tried was a flat factor (actual hit rate ÷ average predicted
probability among a mode's own past picks) multiplied into the combined
probability. It worked in aggregate but broke down on individual matches:
checking real bookmaker odds against specific fixtures — not just the
aggregate — showed the miscalibration has a *shape*, not just a size. On
`goals` (BTTS + Over 2.5), for example, 55 of 116 backtested picks sat in
the 0–35% predicted range and were badly *under*confident there (~22%
predicted vs ~42% actual), while the top end was noisy and mildly
*over*confident. A single flat factor — or even a single "shrink toward
50%" slope fit by least squares, which was tried next — can only push
every prediction the same direction by an amount proportional to its
distance from 50%, so fitting it to fix the (much larger) underconfident
low end made the already-fine mid-range predictions worse, and fitting it
to the rare overconfident high end barely touched the low end at all.

The current fix, `buildCalibrationCurve()` in `scripts/lib/stats.mjs`, bins
each mode's own backtested picks by predicted probability, reads off each
bin's actual hit rate, and runs isotonic regression (pool-adjacent-
violators) over the bins to get a monotonic step function — a prediction
never comes out *less* likely after calibration than a lower raw
prediction did. That curve becomes a piecewise-linear lookup applied to
every fixture's raw combined probability for that mode, in place, so what
you see already accounts for that mode's own measured bias — low, mid,
and high predictions corrected independently instead of by one shared
factor. `Best of all modes`' selection gets a second such curve fit on top
of the now-calibrated modes, for whatever bias remains from picking a max
across several of them at once. Both curves are rebuilt each refresh from
a point-in-time backtest of every club-league match in the last 180 days
(~1,300 graded matches, each predicted from only the data available before
its kickoff) — about ten times the last-week Results sample they were
originally fit on, which is what let the curves go from 3–4 coarse bins to
6–19. Minimum sample sizes still apply: a mode with too little history is
left uncalibrated rather than fit to noise.

A higher bar (an outright win, or a win stacked with BTTS) clears less often
than an easier one (avoiding defeat, dropping the BTTS requirement, or just
goals happening) — that's not a flaw in the stricter modes, it's what
backtesting is for: if hit rate is what you're optimizing for, pick one of
the easier bars; if you specifically want the BTTS angle, that's what the
combo modes are for. The plain **Home win**/**Away win**/**Draw** modes have
no second leg, so their BTTS column shows "—" and Combined is just the win
probability itself. Note the model runs a bit conservative on **Draw**
specifically (~22% average predicted vs. ~30% actual in the backtest) — a
known tendency of this model family to underestimate draws slightly, since
it treats the two teams' goal counts as independent when real matches
correlate low-scoring outcomes somewhat more than that. Your choice is
remembered locally. Alerts always stay tied to away win + BTTS regardless
of which mode you're viewing. A "low sample" tag marks fixtures where
either team has fewer than 5 matches at that venue on record — mostly
teams new to their division, whose previous season was in another league
(see Caveats) — since the underlying rate is noisier with less data.

Below "Top matches", a **Legs** selector (1–5, defaults to 3) picks how many
of the ranked fixtures to focus on — it controls both how many cards show
and how many go into the **Combined** card underneath: each leg's own
likelihood is converted to implied decimal odds (1 ÷ probability), all of
them are multiplied together, and that's shown against a stake you type in
(defaults to €10) as a potential return. Legs and stake are both remembered
locally. A leg marked **bwin** uses bwin's real price for that outcome
(Home win, Draw or Away win, once bwin has priced the match); every other
leg is 1 ÷ our probability — not a bookmaker price — and combining legs
compounds each one's uncertainty, so treat it as illustrative.

### bwin odds

Where bwin has priced a match, **its probabilities come from bwin**, not
our form model — the row is tagged **bwin odds**. bwin's home/draw/away
price (plus the market Over/Under 2.5 line — bwin's own isn't in the feed)
is turned into an expected-goals pair that reproduces it, and every mode is
read off that pair's score matrix, so BTTS and the combo modes reflect
bwin's view too even though bwin doesn't price them in this feed. This
won the backtest outright — 3,431 matches, log-loss, lower is better:

| Weight on bwin vs our model | 1X2 | Over 2.5 | BTTS |
|---|---|---|---|
| 0 (our model only) | 1.063 | 0.735 | 0.731 |
| 0.5 | 1.015 | 0.693 | 0.697 |
| 0.85 | 0.997 | 0.677 | 0.684 |
| **1 (bwin only)** | **0.994** | **0.674** | **0.682** |

bwin-derived numbers skip the calibration curves: on a time split the
curves made them very slightly worse (they're already well calibrated),
and Best of all modes showed no winner's curse on them (53.1% predicted
vs 53.2% actual). The draw comes out a point or two under bwin's own
figure — the score matrix's usual draw shortfall.

The catch is coverage. The feed lists a match only a few days ahead
(refreshed Tuesdays and Fridays), covers the 11 club leagues but not the
European cups or the Nations League, and has no BTTS markets — so fixtures
further out, and all cup and Nations League matches, stay on our model.
bwin's price is also shown as **bwin x.xx** next to the Home win / Draw /
Away win figure in the table, and on already-played matches in Results.

**This is not a bookmaker probability or betting advice** — it's a simplified
estimate from public/derived match data, shown for information only.

## Results — checking the model against what actually happened

An **Upcoming / Results** toggle switches the whole page to a backtest of
the last week's already-played matches across the same leagues. Each one is
scored the same way as an upcoming fixture, except every team's form is
computed from only the matches strictly *before* that kickoff — so it's the
prediction the model would actually have made going in, not one with the
benefit of hindsight. Every row shows the final score and a **Hit**/**Miss**
badge (mode-aware — graded against away win + BTTS or home win + BTTS,
whichever is selected), sorted the same way as the upcoming list — most
confident call first — so a glance at the top tells you both how sure the
model was and whether it was right. A summary line above the table gives the
overall hit rate among ok-confidence calls for the selected mode.

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

Where bwin has priced a match its probabilities come from bwin (see
"bwin odds" above); everywhere else they're our own model's. That's a **Poisson goal-expectancy
model** — the standard approach football analytics use, not a bookmaker's
proprietary model, but a real step up from just averaging historical rates.
Each team's "recent" record is its last 38 league matches (split home and
away), using **expected goals (xG)** instead of actual goals wherever the
data has them (this season onward):

```
homeAttack  = home team's home xG-for average  ÷ league's home average
awayDefense = away team's away xG-against avg  ÷ league's home average
expectedHomeGoals = league's home-goals average × homeAttack × awayDefense
  (mirrored for expectedAwayGoals, using away attack / home defense)

score matrix  = P(home scores i) × P(away scores j), for every i, j — via the
                Poisson distribution at each side's expected goal count
win / BTTS / combined = the matching cells of that matrix summed up
```

Deriving win likelihood and BTTS likelihood from the *same* expected-goals
pair, rather than two separately-averaged historical rates, is what fixes
the old model's biggest blind spot: a lopsided matchup (strong attack vs. a
side that's shipped goals all season) now correctly predicts both a likely
win *and* a lower BTTS chance, because the weaker side's expected goals are
genuinely low — not averaged in from unrelated matches. The two sides'
goal counts are still treated as statistically independent of each other,
a known, accepted simplification of this model family (not a true joint
distribution — real matches correlate the two somewhat, e.g. a team
protecting a lead sits back). Both ranking modes (away win + BTTS, home
win + BTTS) come from the same underlying expected-goals pair. See
`scripts/lib/stats.mjs` for the exact logic, and the Results view (below)
for an ongoing, honest check of how well it's actually calibrated.

The 38-match window and xG weren't picked by taste. A point-in-time
backtest of 3,442 matches across all 11 club leagues (each predicted using
only earlier matches), scored with log-loss (lower is better):

| Team form from | 1X2 | Over 2.5 | BTTS |
|---|---|---|---|
| Last 15 matches, goals (the old ESPN-only setup) | 1.112 | 0.778 | 0.763 |
| Last 38 matches, goals | 1.072 | 0.750 | 0.741 |
| **Last 38 matches, xG where available** | **1.063** | **0.735** | **0.731** |
| Bookmakers' own prices, for reference | 0.992 | 0.678 | — |

Each step helps every market, and the final setup closes roughly 40% of
the gap to the bookmakers. On last week's 104 matches with bwin prices,
the average gap between our 1X2 probabilities and bwin's went from 8.9 to
6.6 percentage points.

## Data source

**Live, always** — two free sources, no keys or signup for either:

- **[football-data.co.uk](https://www.football-data.co.uk)** (`scripts/lib/footballdata.mjs`)
  — CSVs of every match of the current and previous season for all 11
  club leagues, with xG (this season onward) and pre-match odds from
  several bookmakers including bwin, plus a `fixtures.csv` of upcoming
  matches with their odds. This is where team strength, xG, the
  calibration backtest and every bwin price come from.
- **[ESPN's public site API](https://site.api.espn.com)** (`scripts/lib/espn.mjs`)
  — the fixture schedule (a day-by-day scoreboard sweep, 10 days out —
  football-data.co.uk's own upcoming list only reaches a few days ahead),
  last week's results for the Results view, and team form for the
  Champions League, Europa League and Nations League, which
  football-data.co.uk doesn't cover. If
  football-data.co.uk is ever unreachable, each league quietly falls back
  to ESPN form, as before.

The two name teams differently ("Man United" vs "Manchester United",
"Ath Madrid" vs "Atlético Madrid"), so `matchTeamName` bridges them:
explicit aliases first, then a normalized exact match, then "every word of
the football-data name appears in ESPN's", with the most-specific match
winning and ties left unmatched rather than guessed (so "Cercle Brugge KSV"
can't land on "Club Brugge"). It currently matches all 210 club teams;
any it can't are named in the refresh log and fall back to ESPN form.
Demo data (`scripts/lib/mock.mjs`)
is only a fallback if the live fetch fails for any reason, so the dashboard
always has something to show; the meta badge in the top-left says which mode
produced the current data.

Three other routes were tried and abandoned before this one:

- **API-Football**, both via RapidAPI and direct from API-SPORTS — free tier
  blocks exactly the parameters a live-fixtures dashboard needs (`next`,
  `last`, and filtered historical queries all rejected).
- **SofaScore's own API** — `403 Forbidden` for datacenter/CI IPs.
- **football-data.org** (not to be confused with football-data.co.uk) —
  worked, but its free tier's fixed 13-competition list doesn't include the
  Turkish Süper Lig, and needs a token with a per-minute rate limit.

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
scripts/lib/espn.mjs     ESPN site-API client: fixture schedule, recent results, Nations League form
scripts/lib/footballdata.mjs  football-data.co.uk CSV client: team history, xG, bookmaker odds
scripts/lib/mock.mjs     deterministic demo data generator
```

## Caveats

- A Poisson goal model still isn't a true joint distribution — see "How the
  score is computed" above for what it does and doesn't capture.
- Demo mode generates plausible-looking but entirely synthetic results; it is
  clearly labelled "Demo data" in the UI and is not real fixture history.
- ESPN's site API is undocumented — it could change shape or start rate
  limiting without notice. If a refresh starts failing, check
  `scripts/lib/espn.mjs` against a fresh response first.
- Newly promoted and relegated teams come back "low sample" for the first
  couple of months: their previous season was in a different division, so
  only this season's handful of matches count, and their strength isn't
  comparable across divisions without an adjustment this model doesn't
  make. This is where the model disagrees with bookmakers most (e.g. a
  promoted side at home to a relegated one) — the bwin price shown next to
  ours is the quickest way to spot it, and "Hide low-sample fixtures"
  filters them out entirely.
- The **UEFA Nations League** only plays during a handful of international
  windows a year (not every week like a club league), so its upcoming list
  is often empty between them — that's real, not a fetch failure. Its
  matches are genuine home-and-away fixtures, so the model applies the same
  way it does to a club league; `fetchTeamForm` bridges back up to two
  seasons rather than one to find a team's most recent games, since the
  competition itself only runs every other year.
- **Champions League and Europa League** form comes from each club's
  matches across all three UEFA club competitions (Champions, Europa and
  Conference League, up to three seasons back) — the Europa League alone
  gave a median of 1 match per team, pooled it's 16 (Champions League: 23).
  Every match counted is against European-cup opposition, so strengths stay
  relative to that level, and the cups get their own calibration curves,
  fit each refresh on ~350 past cup matches rebuilt from those histories
  (domestic curves didn't fit: the European model's top-fifth BTTS + Over
  2.5 picks claimed 73% but hit 58%). Form is kept per competition — a
  club's Champions League fixture uses its European record, its league
  fixture its domestic one. Teams with little European history (debutants)
  are "low sample", and there are no bwin prices for cup matches in the feed.
- **Africa Cup of Nations was deliberately left out.** Its next edition is
  roughly two years off, and — more fundamentally — it's played entirely in
  one host country: ESPN's home/away labels don't reflect real home
  advantage there (its most recent final was labelled "Morocco at Senegal"
  but played in Rabat, Morocco), which this model's home/away split
  assumes. Adding it would need a neutral-venue variant of the scoring, not
  just another `LEAGUES` entry.
- Extending to more leagues means adding an entry to `LEAGUES` in
  `scripts/lib/espn.mjs` with that league's ESPN slug (and to the mock
  generator if you want it in demo mode too).
- Public/derived match data, shown for information only. **Not betting advice.**

## Licence

MIT — see [LICENSE](LICENSE).
