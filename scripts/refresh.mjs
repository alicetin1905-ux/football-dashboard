#!/usr/bin/env node
/**
 * Builds docs/data/fixtures.json: upcoming fixtures across the tracked
 * leagues, scored from each team's recent home/away record.
 *
 * Live mode: the fixture schedule comes from ESPN's public site API
 * (scripts/lib/espn.mjs); team strength, xG and bookmaker odds come from
 * football-data.co.uk's CSVs (scripts/lib/footballdata.mjs) wherever that
 * covers the league, with ESPN form as the fallback. No keys required.
 * Demo mode (only if the live fetch fails):
 * generates deterministic sample data so the dashboard always has
 * something to show.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreFixture, summarizeTeamForm, computeLeagueAverages, pickBestMode, buildCalibrationCurve, isHit, REAL_MODE_KEYS } from './lib/stats.mjs';
import { generateMockSeason } from './lib/mock.mjs';
import { LEAGUES, fetchLeagueWindow } from './lib/espn.mjs';
import { FD_CODES, fetchLeagueHistory, fetchUpcomingOdds, matchTeamName, teamMatchesBefore, findMatch } from './lib/footballdata.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data');

/** Matches per team the model reads — a point-in-time backtest of 3,442 matches found 38 beat 15 on every market. */
const FORM_WINDOW = 38;
/** How far back the calibration backtest reaches — long enough for ~1,000+ graded matches across the club leagues. */
const CALIBRATION_DAYS = 180;

const log = (...a) => console.log('[refresh]', ...a);

const actualOutcome = (hg, ag) => ({
  homeWin: hg > ag,
  awayWin: ag > hg,
  draw: hg === ag,
  btts: hg > 0 && ag > 0,
  over25: hg + ag > 2.5,
});

/** Teams in a league's most recent stretch of matches — this season's lineup, not relegated sides. */
function currentTeams(history) {
  return [...new Set(history.slice(-200).flatMap((m) => [m.home, m.away]))];
}

function leagueAverageAt(history, before) {
  const forms = currentTeams(history.filter((m) => m.date < before)).map((t) => summarizeTeamForm(teamMatchesBefore(history, t, before, FORM_WINDOW)));
  return computeLeagueAverages(forms);
}

/**
 * Scores every football-data.co.uk match of the last CALIBRATION_DAYS
 * point-in-time (each team's form and the league baseline from strictly
 * earlier matches), purely to fit the calibration curves on. The Results
 * view still shows only the last week; this is the same kind of backtest,
 * just ~10× larger, so the curves aren't fit to a handful of picks per bin.
 */
function buildCalibrationSet(historyByLeague, now) {
  const since = new Date(now.getTime() - CALIBRATION_DAYS * 86_400_000);
  const set = [];
  for (const history of historyByLeague.values()) {
    for (const m of history) {
      if (m.date < since) continue;
      const home = summarizeTeamForm(teamMatchesBefore(history, m.home, m.date, FORM_WINDOW));
      const away = summarizeTeamForm(teamMatchesBefore(history, m.away, m.date, FORM_WINDOW));
      set.push({ modes: scoreFixture(home, away, leagueAverageAt(history, m.date)), actual: actualOutcome(m.hg, m.ag) });
    }
  }
  return set;
}

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
    const before = (matches) => matches.filter((m) => new Date(m.date).getTime() < cutoff).slice(-FORM_WINDOW);
    const homeForm = summarizeTeamForm(before(homeMatches));
    const awayForm = summarizeTeamForm(before(awayMatches));
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
      actual: actualOutcome(r.home.score, r.away.score),
      ...(r.odds ? { odds: r.odds } : {}),
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
 * at once. Both stages measure their curve from `calibrationSet` — graded
 * point-in-time predictions — then apply it to `fixtures` and `results`
 * too, so what's shown uses the same correction just validated against
 * what really happened. `calibrationSet` defaults to `results` (the last
 * week) when there's no larger backtest to fit on.
 */
function applyCalibration(fixtures, results, calibrationSet = results) {
  const modeCurves = {};
  const targets = calibrationSet === results ? [results, fixtures] : [calibrationSet, results, fixtures];

  for (const key of REAL_MODE_KEYS) {
    const gradedPicks = calibrationSet
      .filter((r) => r.modes[key] && r.modes[key].confidence === 'ok')
      .map((r) => ({ combined: r.modes[key].combined, hit: isHit(r.actual, key) }));
    const curve = buildCalibrationCurve(gradedPicks);
    modeCurves[key] = curve.points;
    for (const list of targets) {
      for (const x of list) { if (x.modes[key]) x.modes[key].combined = curve.apply(x.modes[key].combined); }
    }
  }

  const bestGradedPicks = calibrationSet
    .map((r) => ({ actual: r.actual, pick: pickBestMode(r.modes) }))
    .filter(({ pick }) => pick && pick.confidence === 'ok')
    .map(({ actual, pick }) => ({ combined: pick.combined, hit: isHit(actual, pick.sourceMode) }));
  const bestCurve = buildCalibrationCurve(bestGradedPicks);

  for (const list of [results, fixtures]) {
    for (const x of list) {
      const pick = pickBestMode(x.modes, bestCurve.apply);
      if (pick) x.modes.best = pick;
    }
  }

  return { modes: modeCurves, best: bestCurve.points, sampleSize: calibrationSet.length };
}

/**
 * football-data.co.uk history for one league, or null (with a log line) if it
 * can't be fetched — the league then just runs on ESPN form, as before.
 */
async function loadHistory(league) {
  const code = FD_CODES[league.name];
  if (!code) return null;
  try {
    return await fetchLeagueHistory(code);
  } catch (err) {
    log(`  ${league.name}: football-data.co.uk unavailable (${err.message || err}), using ESPN form`);
    return null;
  }
}

async function buildFromApi() {
  const now = new Date();
  const allFixtures = [];
  const allResults = [];
  const formById = new Map();
  const rawMatchesByTeam = new Map();
  const leagueAvgByName = new Map();
  const historyByLeague = new Map();

  let upcomingOdds = new Map();
  try {
    upcomingOdds = await fetchUpcomingOdds();
  } catch (err) {
    log('upcoming odds unavailable:', err.message || err);
  }

  for (const league of LEAGUES) {
    const { fixtures, results, matchesByTeam } = await fetchLeagueWindow(league);
    const history = await loadHistory(league);
    const fdNames = history ? new Set(history.flatMap((m) => [m.home, m.away])) : null;
    const fdNameById = new Map();
    const unmatched = new Set();
    for (const f of [...fixtures, ...results]) {
      for (const side of [f.home, f.away]) {
        if (!fdNames || fdNameById.has(side.id)) continue;
        const name = matchTeamName(side.name, fdNames);
        if (name) fdNameById.set(side.id, name); else unmatched.add(side.name);
      }
    }

    const forms = [];
    for (const [teamId, espnMatches] of matchesByTeam) {
      const fdName = fdNameById.get(teamId);
      // A little more than the window, so the Results backtest can still
      // cut back to "before kickoff" and keep a full FORM_WINDOW.
      const matches = fdName ? teamMatchesBefore(history, fdName, now, FORM_WINDOW + 10) : espnMatches;
      const form = summarizeTeamForm(matches.slice(-FORM_WINDOW));
      formById.set(teamId, form);
      rawMatchesByTeam.set(teamId, matches);
      forms.push(form);
    }
    leagueAvgByName.set(league.name, history ? leagueAverageAt(history, now) : computeLeagueAverages(forms));

    if (history) {
      historyByLeague.set(league.name, history);
      const upcoming = upcomingOdds.get(FD_CODES[league.name]) || [];
      for (const f of fixtures) {
        const row = findMatch(upcoming, fdNameById.get(f.home.id), fdNameById.get(f.away.id), f.date);
        if (row) f.odds = row.odds;
      }
      for (const r of results) {
        const row = findMatch(history, fdNameById.get(r.home.id), fdNameById.get(r.away.id), r.date);
        if (row) r.odds = row.odds;
      }
    }

    const withOdds = fixtures.filter((f) => f.odds).length;
    log(`  ${league.name}: ${fixtures.length} upcoming (${withOdds} with odds), ${results.length} recent results, ${matchesByTeam.size} teams` +
      (history ? `, ${history.length} football-data matches` : ', ESPN form only') +
      (unmatched.size ? ` — unmatched: ${[...unmatched].join(', ')}` : ''));
    allFixtures.push(...fixtures);
    allResults.push(...results);
  }

  // Only bail to demo data on a true outage (nothing at all, from any league).
  // An empty *upcoming* list on its own is a real state worth showing live —
  // ESPN's day-by-day sweep has come back with genuinely no "pre" events for
  // the whole 11-day window before (a schedule-data gap on ESPN's end, not
  // ours: verified directly against the endpoint, same result for every
  // league) while still returning real recent results — and forcing a full
  // mock fallback in that case would throw away a perfectly good backtest
  // just because the upcoming list happened to be empty that refresh.
  if (!allFixtures.length && !allResults.length) throw new Error('no live data returned for any league');
  const fixtures = scoreAll(allFixtures, formById, leagueAvgByName);
  const results = scoreResults(allResults, rawMatchesByTeam, leagueAvgByName);
  const calibrationSet = historyByLeague.size ? buildCalibrationSet(historyByLeague, now) : results;
  const calibration = applyCalibration(fixtures, results, calibrationSet);
  return { fixtures, results, calibration, sources: historyByLeague.size ? 'ESPN + football-data.co.uk' : 'ESPN' };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let fixtures;
  let results;
  let calibration;
  let source;
  let sourceLabel;
  try {
    ({ fixtures, results, calibration, sources: sourceLabel } = await buildFromApi());
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
    sourceLabel = 'Demo data';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    sourceLabel,
    disclaimer: 'Public/derived football statistics shown for information only — not betting advice.',
    fixtures,
    results,
    calibration,
  };
  await writeFile(resolve(OUT, 'fixtures.json'), JSON.stringify(payload, null, 2));
  const curveLog = (points) => (points.length ? `${points.length}pt` : 'off');
  const factorsLog = Object.entries(calibration.modes).map(([k, v]) => `${k}=${curveLog(v)}`).join(' ');
  log(`wrote ${fixtures.length} fixtures, ${results.length} recent results, calibration: ${factorsLog} best=${curveLog(calibration.best)} fit on ${calibration.sampleSize} graded matches (source: ${sourceLabel})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
