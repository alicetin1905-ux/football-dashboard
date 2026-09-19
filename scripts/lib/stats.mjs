/**
 * Shared scoring logic for the football dashboard — used by both the mock
 * data generator and the live ESPN pipeline, so "demo" and "live" numbers
 * are always computed the same way.
 *
 * A Poisson goal-expectancy model: each team gets an attack/defense
 * strength (relative to its league's average goals scored/conceded, split
 * by home/away venue), which combine into an expected goal count for each
 * side of a specific fixture. From those two expected counts, a full score
 * probability matrix (0–0, 1–0, 0–1, ...) gives properly joint win/BTTS/
 * combined probabilities — unlike just multiplying two independent
 * historical rates, this correctly links the two: a big mismatch (strong
 * attack vs weak, leaky defense) predicts both a likely win *and* a
 * correspondingly lower BTTS chance, because the weaker side's expected
 * goals are genuinely low, not averaged in from unrelated matches.
 *
 * The two Poisson variables are still treated as independent of each other
 * (real matches correlate them somewhat — a team leading tends to sit back,
 * denting the trailing side's low-goal chances further) — a known,
 * accepted simplification of this model, not a true joint distribution.
 */

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const RECENT_FORM_COUNT = 5;
const MIN_SAMPLE_FOR_CONFIDENCE = 5;
const MAX_GOALS = 12; // Poisson tail beyond this is negligible even at the expected-goals cap below.
const EXPECTED_GOALS_RANGE = [0.15, 5.5]; // guards against small-sample noise producing runaway predictions

/** Fallbacks if a league's own data can't produce an average (e.g. everything low-sample). */
const DEFAULT_LEAGUE_AVG = { home: 1.45, away: 1.15 };

/** W/D/L for a team's own matches, oldest to newest — the last entry is most recent. */
function formLetters(matches) {
  return matches.slice(-RECENT_FORM_COUNT).map((m) => (m.gf > m.ga ? 'W' : m.gf < m.ga ? 'L' : 'D'));
}

/**
 * @param {{venue: 'home'|'away', gf: number, ga: number}[]} matches
 */
export function summarizeTeamForm(matches) {
  const home = matches.filter((m) => m.venue === 'home');
  const away = matches.filter((m) => m.venue === 'away');
  const avgOf = (arr, key) => (arr.length ? avg(arr.map((m) => m[key])) : null);

  return {
    homeSample: home.length,
    awaySample: away.length,
    homeGoalsForAvg: avgOf(home, 'gf'),
    homeGoalsAgainstAvg: avgOf(home, 'ga'),
    awayGoalsForAvg: avgOf(away, 'gf'),
    awayGoalsAgainstAvg: avgOf(away, 'ga'),
    // Home/away-specific, since those are the splits the model is actually
    // built from — a team's overall form can read very differently from its
    // home-only or away-only record.
    homeForm: formLetters(home),
    awayForm: formLetters(away),
  };
}

/**
 * A league's baseline goals-per-game (home side, away side), averaged
 * across every team's own home/away goal averages — an approximation of
 * "average goals scored by the home/away side in this league", weighting
 * each team equally rather than each match (simpler, and fine at this
 * sample size).
 * @param {ReturnType<typeof summarizeTeamForm>[]} forms
 */
export function computeLeagueAverages(forms) {
  const homeVals = forms.map((f) => f.homeGoalsForAvg).filter((v) => v != null);
  const awayVals = forms.map((f) => f.awayGoalsForAvg).filter((v) => v != null);
  return {
    home: homeVals.length ? avg(homeVals) : DEFAULT_LEAGUE_AVG.home,
    away: awayVals.length ? avg(awayVals) : DEFAULT_LEAGUE_AVG.away,
  };
}

/** Poisson pmf for k = 0..maxK, via the stable p(k) = p(k-1) · λ / k recurrence. */
function poissonPmf(lambda, maxK) {
  const p = new Array(maxK + 1);
  p[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxK; k++) p[k] = p[k - 1] * lambda / k;
  return p;
}

/** Strength relative to league average — 1 means "league average"; falls back to neutral (1) with no matches in that venue split rather than dividing by zero. */
function strength(goalsAvg, leagueAvg) {
  return goalsAvg != null && leagueAvg > 0 ? goalsAvg / leagueAvg : 1;
}

/** Sums the full score matrix into the outcome probabilities the app needs. */
function outcomeProbs(expectedHome, expectedAway) {
  const home = poissonPmf(expectedHome, MAX_GOALS);
  const away = poissonPmf(expectedAway, MAX_GOALS);

  let homeWin = 0;
  let awayWin = 0;
  let draw = 0;
  let btts = 0;
  let homeWinBtts = 0;
  let awayWinBtts = 0;
  let over25 = 0;
  let bttsOver25 = 0;
  let homeOrDraw = 0; // double chance 1X: home win or draw
  let homeOrDrawBtts = 0;

  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = home[i] * away[j];
      const bothScored = i > 0 && j > 0;
      if (i > j) homeWin += p; else if (i < j) awayWin += p; else draw += p;
      if (i >= j) homeOrDraw += p;
      if (bothScored) {
        btts += p;
        if (i > j) homeWinBtts += p;
        else if (i < j) awayWinBtts += p;
        if (i >= j) homeOrDrawBtts += p;
      }
      if (i + j >= 3) {
        over25 += p;
        if (bothScored) bttsOver25 += p;
      }
    }
  }
  return { homeWin, awayWin, draw, btts, homeWinBtts, awayWinBtts, over25, bttsOver25, homeOrDraw, homeOrDrawBtts };
}

/**
 * @param {ReturnType<typeof summarizeTeamForm>} homeForm
 * @param {ReturnType<typeof summarizeTeamForm>} awayForm
 * @param {{home: number, away: number}} leagueAvg
 * @returns {{ away: object, home: object, goals: object, dc1x: object, homeWin: object, awayWin: object, draw: object, sampleHome: number, sampleAway: number, expectedGoals: {home: number, away: number} }}
 */
export function scoreFixture(homeForm, awayForm, leagueAvg) {
  const minSample = Math.min(homeForm.homeSample, awayForm.awaySample);
  const confidence = minSample >= MIN_SAMPLE_FOR_CONFIDENCE ? 'ok' : 'low';

  const homeAttack = strength(homeForm.homeGoalsForAvg, leagueAvg.home);
  const homeDefense = strength(homeForm.homeGoalsAgainstAvg, leagueAvg.away);
  const awayAttack = strength(awayForm.awayGoalsForAvg, leagueAvg.away);
  const awayDefense = strength(awayForm.awayGoalsAgainstAvg, leagueAvg.home);

  const expectedHomeGoals = clamp(leagueAvg.home * homeAttack * awayDefense, ...EXPECTED_GOALS_RANGE);
  const expectedAwayGoals = clamp(leagueAvg.away * awayAttack * homeDefense, ...EXPECTED_GOALS_RANGE);

  const { homeWin, awayWin, draw, btts, homeWinBtts, awayWinBtts, over25, bttsOver25, homeOrDraw, homeOrDrawBtts } =
    outcomeProbs(expectedHomeGoals, expectedAwayGoals);

  return {
    away: { winLikelihood: awayWin, bttsLikelihood: btts, combined: awayWinBtts, confidence },
    home: { winLikelihood: homeWin, bttsLikelihood: btts, combined: homeWinBtts, confidence },
    // Neither of these two is a single-team-win bet — winLikelihood is
    // P(Over 2.5) for `goals` and P(home win or draw) for `dc1x` — so the
    // client can still treat all four modes the same way (a "win-like"
    // figure, a BTTS figure, and their joint "combined" probability).
    goals: { winLikelihood: over25, bttsLikelihood: btts, combined: bttsOver25, confidence },
    dc1x: { winLikelihood: homeOrDraw, bttsLikelihood: btts, combined: homeOrDrawBtts, confidence },
    // Single-outcome, no second leg — bttsLikelihood is null (nothing to
    // show there) and combined is just the win probability itself, not a
    // joint one.
    homeWin: { winLikelihood: homeWin, bttsLikelihood: null, combined: homeWin, confidence },
    awayWin: { winLikelihood: awayWin, bttsLikelihood: null, combined: awayWin, confidence },
    draw: { winLikelihood: draw, bttsLikelihood: null, combined: draw, confidence },
    sampleHome: homeForm.homeSample,
    sampleAway: awayForm.awaySample,
    expectedGoals: { home: expectedHomeGoals, away: expectedAwayGoals },
  };
}

/** Modes `pickBestMode` chooses from — every mode `scoreFixture` returns except `best` itself. */
export const REAL_MODE_KEYS = ['away', 'home', 'goals', 'dc1x', 'homeWin', 'awayWin', 'draw'];

/** The no-op curve: returned when there isn't enough backtest data yet to calibrate against. */
const IDENTITY_CURVE = { points: [], apply: (p) => p };

/**
 * Picks whichever of the real modes has the single highest `combined`
 * probability for this fixture, tagged with which one (`sourceMode`). Not a
 * separate model — just comparing numbers already on the same 0–1 scale
 * from the same score matrix, so the comparison is coherent.
 *
 * This selection is a known source of a "winner's curse": picking the max
 * of several correlated-but-imperfect estimates systematically favors
 * whichever one has the most positive noise, not necessarily the genuinely
 * best bet. `applyCurve` (see buildCalibrationCurve below) corrects for
 * that, measured empirically rather than assumed. Callers should pass modes
 * that have already had their own per-mode calibration applied, so this
 * only has to correct the residual bias from the selection itself.
 */
export function pickBestMode(modes, applyCurve = (p) => p) {
  let best = null;
  let bestKey = null;
  for (const key of REAL_MODE_KEYS) {
    const m = modes[key];
    if (!m || m.combined == null) continue;
    if (!best || m.combined > best.combined) { best = m; bestKey = key; }
  }
  if (!best) return null;
  return { ...best, combined: applyCurve(best.combined), sourceMode: bestKey };
}

/**
 * Whether a backtested fixture's actual outcome matches a given mode's bet.
 * Mirrored (not shared) in docs/js/app.js, which can't import this Node
 * module — that copy grades the Results view live in the browser; this one
 * only feeds calibrateMode below.
 */
export function isHit(actual, mode) {
  if (mode === 'goals') return actual.over25 && actual.btts;
  if (mode === 'dc1x') return !actual.awayWin && actual.btts;
  if (mode === 'homeWin') return actual.homeWin;
  if (mode === 'awayWin') return actual.awayWin;
  if (mode === 'draw') return actual.draw;
  const won = mode === 'home' ? actual.homeWin : actual.awayWin;
  return won && actual.btts;
}

/**
 * Fits a monotonic calibration curve mapping a mode's raw `combined` to an
 * empirically-observed hit rate, via binning + isotonic regression
 * (pool-adjacent-violators) rather than a single-parameter formula.
 *
 * Two earlier versions of this were tried and rejected, both because they
 * assumed the miscalibration had one fixed *shape* everywhere:
 *
 * - A flat multiplicative correction (`hitRate ÷ avgPredicted`, applied as
 *   `combined *= factor`) tuned to the backtest's average made the rare but
 *   important high-confidence picks *worse* — it only has one direction to
 *   push.
 * - A "shrink toward 50% in proportion to distance from it" formula
 *   (`0.5 + (p−0.5)·k`, k fit by least squares) was a step up, but the least
 *   squares fit weights each pick by its *squared* distance from 0.5 — so a
 *   handful of confident picks dominate k even when the bulk of the backtest
 *   sits near a coin flip. On `goals` specifically, 55 of 116 backtested
 *   picks landed in the 0–35% bucket (predicted ~22%, actual ~42% — badly
 *   *under*confident) and that bucket alone supplied 80% of the fit's
 *   weight, so the single k it produced (0.15, clamped near the floor) also
 *   flattened the 50–65% range toward 50% even though that range was
 *   already close to calibrated (predicted ~53–61%, actual ~50–67%) —
 *   pulling genuinely fine mid-confidence picks down to match a correction
 *   that only the low end needed.
 *
 * This version fixes that by not assuming a shape at all: it bins the
 * backtest by predicted probability (each bin ≥`MIN_BIN` picks, oldest/
 * lowest-first), reads off each bin's own actual hit rate, then runs
 * pool-adjacent-violators to merge any bins where hit rate doesn't
 * increase with predicted probability (guaranteeing the corrected curve
 * stays monotonic — a fixture the raw model rates more likely never comes
 * out *less* likely after calibration). The result is a piecewise-linear
 * lookup: interpolated between bin midpoints, held flat past the ends of
 * the observed range rather than extrapolated. Left as the identity
 * (no correction) when there isn't enough backtest data yet to trust it.
 * @param {{combined: number, hit: boolean}[]} gradedPicks
 * @returns {{ points: {x: number, y: number}[], apply: (p: number) => number }}
 */
export function buildCalibrationCurve(gradedPicks) {
  const MIN_SAMPLE = 40;
  const MIN_BIN = 15;
  if (gradedPicks.length < MIN_SAMPLE) return IDENTITY_CURVE;

  const sorted = [...gradedPicks].sort((a, b) => a.combined - b.combined);
  const bins = [];
  let i = 0;
  while (i < sorted.length) {
    let end = Math.min(i + MIN_BIN, sorted.length);
    if (sorted.length - end < MIN_BIN) end = sorted.length; // fold a too-small remainder into the last bin
    const chunk = sorted.slice(i, end);
    bins.push({ avgPred: avg(chunk.map((c) => c.combined)), hitRate: avg(chunk.map((c) => (c.hit ? 1 : 0))), n: chunk.length });
    i = end;
  }

  // Pool-adjacent-violators: merge backwards whenever hit rate dips versus the previous (lower-predicted) bin.
  const pooled = [];
  for (const b of bins) {
    pooled.push({ ...b });
    while (pooled.length > 1 && pooled[pooled.length - 2].hitRate > pooled[pooled.length - 1].hitRate) {
      const b2 = pooled.pop();
      const b1 = pooled.pop();
      const n = b1.n + b2.n;
      pooled.push({ avgPred: (b1.avgPred * b1.n + b2.avgPred * b2.n) / n, hitRate: (b1.hitRate * b1.n + b2.hitRate * b2.n) / n, n });
    }
  }

  const points = pooled.map((b) => ({ x: b.avgPred, y: clamp(b.hitRate, 0.02, 0.98) }));

  const apply = (p) => {
    if (p <= points[0].x) return points[0].y;
    if (p >= points[points.length - 1].x) return points[points.length - 1].y;
    for (let j = 0; j < points.length - 1; j++) {
      const a = points[j];
      const b = points[j + 1];
      if (p >= a.x && p <= b.x) {
        const t = b.x === a.x ? 0 : (p - a.x) / (b.x - a.x);
        return a.y + t * (b.y - a.y);
      }
    }
    return p;
  };

  return { points, apply };
}
