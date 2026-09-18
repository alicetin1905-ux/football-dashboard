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
      if (i > j) homeWin += p; else if (i < j) awayWin += p;
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
  return { homeWin, awayWin, btts, homeWinBtts, awayWinBtts, over25, bttsOver25, homeOrDraw, homeOrDrawBtts };
}

/**
 * @param {ReturnType<typeof summarizeTeamForm>} homeForm
 * @param {ReturnType<typeof summarizeTeamForm>} awayForm
 * @param {{home: number, away: number}} leagueAvg
 * @returns {{ away: object, home: object, goals: object, dc1x: object, homeWin: object, awayWin: object, sampleHome: number, sampleAway: number, expectedGoals: {home: number, away: number} }}
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

  const { homeWin, awayWin, btts, homeWinBtts, awayWinBtts, over25, bttsOver25, homeOrDraw, homeOrDrawBtts } =
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
    sampleHome: homeForm.homeSample,
    sampleAway: awayForm.awaySample,
    expectedGoals: { home: expectedHomeGoals, away: expectedAwayGoals },
  };
}
