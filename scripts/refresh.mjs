#!/usr/bin/env node
/**
 * Builds docs/data/fixtures.json: upcoming fixtures across the top five
 * European leagues, ranked by a combined "away win + both teams to score"
 * likelihood derived from each team's recent home/away record.
 *
 * Live mode (FOOTBALL_DATA_TOKEN set): pulls each league's full match list
 * from football-data.org — one request per league covers both recent
 * results and upcoming fixtures. Demo mode (no token, or the live fetch
 * fails): generates deterministic sample data so the dashboard always has
 * something to show.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreFixture, summarizeTeamForm } from './lib/stats.mjs';
import { generateMockSeason } from './lib/mock.mjs';
import { COMPETITIONS, fetchCompetition } from './lib/football-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/data');

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN || '';
// football-data.org returns a competition's entire remaining-season fixture
// list (hundreds of matches, months out) with no "next N" filter of its own,
// so narrow to a near-term window ourselves before scoring/display.
const WINDOW_DAYS = Number(process.env.FOOTBALL_WINDOW_DAYS || 10);

const log = (...a) => console.log('[refresh]', ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const windowEnd = Date.now() + WINDOW_DAYS * 86_400_000;

  for (const comp of COMPETITIONS) {
    const { fixtures, matchesByTeam } = await fetchCompetition(FOOTBALL_DATA_TOKEN, comp);
    const nearTerm = fixtures.filter((f) => new Date(f.date).getTime() <= windowEnd);
    log(`  ${comp.name}: ${nearTerm.length}/${fixtures.length} fixtures within ${WINDOW_DAYS}d, ${matchesByTeam.size} teams with recent matches`);
    allFixtures.push(...nearTerm);
    for (const [teamId, matches] of matchesByTeam) {
      formById.set(teamId, summarizeTeamForm(matches));
    }
    await sleep(1000); // stay well under the 10 requests/minute free-tier limit
  }

  if (!allFixtures.length) throw new Error('no upcoming fixtures returned for any league within the window');
  return scoreAll(allFixtures, formById);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let fixtures;
  let source;
  if (FOOTBALL_DATA_TOKEN) {
    try {
      fixtures = await buildFromApi();
      source = 'football-data.org';
    } catch (err) {
      log('live fetch failed, falling back to demo data:', err.message || err);
    }
  }
  if (!fixtures) {
    log(FOOTBALL_DATA_TOKEN ? 'using demo data (live fetch unavailable)' : 'no FOOTBALL_DATA_TOKEN set — using demo data');
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
