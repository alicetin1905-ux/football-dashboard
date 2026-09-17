#!/usr/bin/env node
/**
 * Builds docs/data/fixtures.json: upcoming fixtures across the top five
 * European leagues, ranked by a combined "away win + both teams to score"
 * likelihood derived from each team's recent home/away record.
 *
 * Demo mode only for now: generates deterministic sample data so the
 * dashboard always has something to show. A live data source is still being
 * evaluated — see README.md.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreFixture } from './lib/stats.mjs';
import { generateMockSeason } from './lib/mock.mjs';

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

async function main() {
  await mkdir(OUT, { recursive: true });

  const { fixtures: mockFixtures, forms } = generateMockSeason();
  const fixtures = scoreAll(mockFixtures, forms);
  const source = 'mock';

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
