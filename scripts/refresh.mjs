#!/usr/bin/env node
/**
 * Builds docs/data/fixtures.json: upcoming fixtures across six European
 * leagues, ranked by a combined "away win + both teams to score" likelihood
 * derived from each team's recent home/away record.
 *
 * Live mode: pulls from ESPN's public site API (no key required — see
 * scripts/lib/espn.mjs). Demo mode (only if the live fetch fails):
 * generates deterministic sample data so the dashboard always has
 * something to show.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreFixture, summarizeTeamForm, computeLeagueAverages, pickBestMode, buildCalibrationCurve, isHit, REAL_MODE_KEYS } from './lib/stats.mjs';
import { generateMockSeason } from './lib/mock.mjs';
import { LEAGUES, fetchLeagueWindow } from './lib/espn.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data');

const log = (...a) => console.log('[refresh]', ...a);

/**
 * @param {Map<string, object>} formById
 * @param {Map<string, {home: number, away: number}>} leagueAvgByName
 */
function scoreAll(fixtures, formById, leagueAvgByName) {
  const scored = [];
  for (const f of fixtures) {
    const homeForm = formById.get(f.home.id);
    const awayForm = formById.get(f.away.id);
    if (!homeForm || !awayForm || homeForm.__error || awayForm.__error) continue;
    const leagueAvg = leagueAvgByName.get(f.league);
    if (!leagueAvg) continue;
    const modes = scoreFixture(homeForm, awayForm, leagueAvg);
    scored.push({ ...f, stats: { home: homeForm, away: awayForm }, score: modes.away, modes });
  }
  scored.sort((a, b) => b.score.combined - a.score.combined);
  return scored;
}

/**
 * Backtests already-played fixtures: each team's form is summarized from
 * only the matches strictly before that fixture's kickoff (rawMatchesByTeam
 * carries `date` for exactly this), so the prediction shown is the one the
 * model would actually have made going in — not one peeking at the result.
 * Shaped like a scored fixture (stats.home/away, same modes) so the client
 * can reuse the same per-mode scoring it already has, plus the real final
 * score and outcome to grade it against. Uses each league's *current*
 * baseline goal average rather than a point-in-time one — a small
 * remaining inconsistency, since that baseline itself drifts over a
 * season, but a minor one next to the form-side lookahead this already
 * guards against.
 */
function scoreResults(results, rawMatchesByTeam, leagueAvgByName) {
  const scored = [];
  for (const r of results) {
    const homeMatches = rawMatchesByTeam.get(r.home.id);
    const awayMatches = rawMatchesByTeam.get(r.away.id);
    if (!homeMatches || !awayMatches || homeMatches.__error || awayMatches.__error) continue;
    const leagueAvg = leagueAvgByName.get(r.league);
    if (!leagueAvg) continue;

    const cutoff = new Date(r.date).getTime();
    const homeForm = summarizeTeamForm(homeMatches.filter((m) => new Date(m.date).getTime() < cutoff));
    const awayForm = summarizeTeamForm(awayMatches.filter((m) => new Date(m.date).getTime() < cutoff));
    const modes = scoreFixture(homeForm, awayForm, leagueAvg);

    scored.push({
      id: r.id,
      date: r.date,
      league: r.league,
      leagueCountry: r.leagueCountry,
      home: { id: r.home.id, name: r.home.name },
      away: { id: r.away.id, name: r.away.name },
      stats: { home: homeForm, away: awayForm },
      score: modes.away,
      modes,
      finalScore: { home: r.home.score, away: r.away.score },
      actual: {
        homeWin: r.home.score > r.away.score,
        awayWin: r.away.score > r.home.score,
        draw: r.home.score === r.away.score,
        btts: r.home.score > 0 && r.away.score > 0,
        over25: r.home.score + r.away.score > 2.5,
      },
    });
  }
  scored.sort((a, b) => new Date(b.date) - new Date(a.date));
  return scored;
}

/**
 * Calibrates every mode's `combined` against the backtest, in two stages.
 * First each of the 7 real modes gets its own calibration curve — binned by
 * predicted probability, isotonic-regressed against the backtest's own
 * observed hit rate per bin (see `buildCalibrationCurve` in stats.mjs for
 * why a single global shrink factor couldn't fix this: the miscalibration
 * shape differs by probability range, not just by mode). Applied *in place*
 * so `score` (an alias of `modes.away`, used for sorting and alerts) stays
 * in sync without a second assignment. Then `modes.best` is picked from
 * those now-calibrated modes and gets its own additional curve for
 * whatever selection bias remains from picking a max across several modes
 * at once. Both stages measure their curve from `results` — the actual
 * outcomes — then apply it to both `results` and `fixtures`, so upcoming
 * predictions use the same correction just validated against what really
 * happened.
 */
function applyCalibration(fixtures, results) {
  const modeCurves = {};

  for (const key of REAL_MODE_KEYS) {
    const gradedPicks = results
      .filter((r) => r.modes[key] && r.modes[key].confidence === 'ok')
      .map((r) => ({ combined: r.modes[key].combined, hit: isHit(r.actual, key) }));
    const curve = buildCalibrationCurve(gradedPicks);
    modeCurves[key] = curve.points;
    for (const r of results) { if (r.modes[key]) r.modes[key].combined = curve.apply(r.modes[key].combined); }
    for (const f of fixtures) { if (f.modes[key]) f.modes[key].combined = curve.apply(f.modes[key].combined); }
  }

  const bestGradedPicks = results
    .map((r) => ({ actual: r.actual, pick: pickBestMode(r.modes) }))
    .filter(({ pick }) => pick && pick.confidence === 'ok')
    .map(({ actual, pick }) => ({ combined: pick.combined, hit: isHit(actual, pick.sourceMode) }));
  const bestCurve = buildCalibrationCurve(bestGradedPicks);

  for (const r of results) {
    const pick = pickBestMode(r.modes, bestCurve.apply);
    if (pick) r.modes.best = pick;
  }
  for (const f of fixtures) {
    const pick = pickBestMode(f.modes, bestCurve.apply);
    if (pick) f.modes.best = pick;
  }

  return { modes: modeCurves, best: bestCurve.points };
}

async function buildFromApi() {
  const allFixtures = [];
  const allResults = [];
  const formById = new Map();
  const rawMatchesByTeam = new Map();
  const leagueAvgByName = new Map();

  for (const league of LEAGUES) {
    const { fixtures, results, matchesByTeam } = await fetchLeagueWindow(league);
    log(`  ${league.name}: ${fixtures.length} upcoming, ${results.length} recent results, ${matchesByTeam.size} teams with recent matches`);
    allFixtures.push(...fixtures);
    allResults.push(...results);

    const forms = [];
    for (const [teamId, matches] of matchesByTeam) {
      const form = summarizeTeamForm(matches);
      formById.set(teamId, form);
      rawMatchesByTeam.set(teamId, matches);
      forms.push(form);
    }
    leagueAvgByName.set(league.name, computeLeagueAverages(forms));
  }

  if (!allFixtures.length) throw new Error('no upcoming fixtures returned for any league');
  const fixtures = scoreAll(allFixtures, formById, leagueAvgByName);
  const results = scoreResults(allResults, rawMatchesByTeam, leagueAvgByName);
  const calibration = applyCalibration(fixtures, results);
  return { fixtures, results, calibration };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let fixtures;
  let results;
  let calibration;
  let source;
  try {
    ({ fixtures, results, calibration } = await buildFromApi());
    source = 'espn';
  } catch (err) {
    log('live fetch failed, falling back to demo data:', err.message || err);
  }
  if (!fixtures) {
    log('using demo data (live fetch unavailable)');
    const { fixtures: mockFixtures, forms, leagueAverages } = generateMockSeason();
    fixtures = scoreAll(mockFixtures, forms, leagueAverages);
    results = []; // demo mode has no play-by-play history to backtest against
    calibration = applyCalibration(fixtures, results); // no results to calibrate from, so every factor is 1 (uncorrected)
    source = 'mock';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    disclaimer: 'Public/derived football statistics shown for information only — not betting advice.',
    fixtures,
    results,
    calibration,
  };
  await writeFile(resolve(OUT, 'fixtures.json'), JSON.stringify(payload, null, 2));
  const curveLog = (points) => (points.length ? `${points.length}pt` : 'off');
  const factorsLog = Object.entries(calibration.modes).map(([k, v]) => `${k}=${curveLog(v)}`).join(' ');
  log(`wrote ${fixtures.length} fixtures, ${results.length} recent results, calibration: ${factorsLog} best=${curveLog(calibration.best)} (source: ${source})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
