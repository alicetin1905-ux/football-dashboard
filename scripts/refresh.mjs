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

import { scoreFixture, summarizeTeamForm } from './lib/stats.mjs';
import { generateMockSeason } from './lib/mock.mjs';
import { LEAGUES, fetchLeagueWindow } from './lib/espn.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data');

const log = (...a) => console.log('[refresh]', ...a);

function scoreAll(fixtures, formById) {
  const scored = [];
  for (const f of fixtures) {
    const homeForm = formById.get(f.home.id);
    const awayForm = formById.get(f.away.id);
    if (!homeForm || !awayForm || homeForm.__error || awayForm.__error) continue;
    const score = scoreFixture(homeForm, awayForm);
    if (!score) continue;
    scored.push({ ...f, stats: { home: homeForm, away: awayForm }, score });
  }
  scored.sort((a, b) => b.score.combined - a.score.combined);
  return scored;
}

async function buildFromApi() {
  const allFixtures = [];
  const formById = new Map();

  for (const league of LEAGUES) {
    const { fixtures, matchesByTeam } = await fetchLeagueWindow(league);
    log(`  ${league.name}: ${fixtures.length} upcoming fixtures, ${matchesByTeam.size} teams with recent matches`);
    allFixtures.push(...fixtures);
    for (const [teamId, matches] of matchesByTeam) {
      formById.set(teamId, summarizeTeamForm(matches));
    }
  }

  if (!allFixtures.length) throw new Error('no upcoming fixtures returned for any league');
  return scoreAll(allFixtures, formById);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let fixtures;
  let source;
  try {
    fixtures = await buildFromApi();
    source = 'espn';
  } catch (err) {
    log('live fetch failed, falling back to demo data:', err.message || err);
  }
  if (!fixtures) {
    log('using demo data (live fetch unavailable)');
    const { fixtures: mockFixtures, forms } = generateMockSeason();
    fixtures = scoreAll(mockFixtures, forms);
    source = 'mock';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    disclaimer: 'Public/derived football statistics shown for information only — not betting advice.',
    fixtures,
  };
  await writeFile(resolve(OUT, 'fixtures.json'), JSON.stringify(payload, null, 2));
  log(`wrote ${fixtures.length} fixtures (source: ${source})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
