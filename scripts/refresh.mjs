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

import { scoreFixture, summarizeTeamForm, computeLeagueAverages } from './lib/stats.mjs';
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
  return {
    fixtures: scoreAll(allFixtures, formById, leagueAvgByName),
    results: scoreResults(allResults, rawMatchesByTeam, leagueAvgByName),
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let fixtures;
  let results;
  let source;
  try {
    ({ fixtures, results } = await buildFromApi());
    source = 'espn';
  } catch (err) {
    log('live fetch failed, falling back to demo data:', err.message || err);
  }
  if (!fixtures) {
    log('using demo data (live fetch unavailable)');
    const { fixtures: mockFixtures, forms, leagueAverages } = generateMockSeason();
    fixtures = scoreAll(mockFixtures, forms, leagueAverages);
    results = []; // demo mode has no play-by-play history to backtest against
    source = 'mock';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    disclaimer: 'Public/derived football statistics shown for information only — not betting advice.',
    fixtures,
    results,
  };
  await writeFile(resolve(OUT, 'fixtures.json'), JSON.stringify(payload, null, 2));
  log(`wrote ${fixtures.length} fixtures, ${results.length} recent results (source: ${source})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
