/**
 * The Best picks track record: every pick the top row has shown, and one
 * 3-leg slip per day, graded against the real result once the match is
 * played. The site has no database, so the record lives in the deployed
 * site itself (data/history.json): each refresh downloads the previous
 * copy, adds to it, grades what finished, and publishes it again.
 */

import { isHit } from './stats.mjs';

export const BEST_PICKS = 3;
const KEEP_DAYS = 365;
/** A pick still ungraded this long after kickoff (postponed, or missing from the results feed) is voided. */
const VOID_AFTER_DAYS = 10;

const BOOK_SIDE = { homeWin: 'home', draw: 'draw', awayWin: 'away' };

/**
 * The same rule the client's Best picks row uses: upcoming, ok-sample
 * fixtures ranked by their single most likely bet, earliest kickoff first
 * on ties.
 */
export function selectBestPicks(fixtures, now, n = BEST_PICKS) {
  return fixtures
    .filter((f) => f.modes?.best && f.modes.best.confidence === 'ok' && new Date(f.date) > now)
    .sort((a, b) => b.modes.best.combined - a.modes.best.combined || new Date(a.date) - new Date(b.date))
    .slice(0, n);
}

/**
 * The previous record from the live site. A 404 means there isn't one yet;
 * any other failure throws, so a network blip fails the refresh rather
 * than publishing an empty record over the real one.
 */
export async function loadTrackRecord(siteUrl) {
  // The query string sidesteps GitHub Pages' ~10-minute CDN cache, so two
  // refreshes close together don't start from a stale copy.
  const url = `${siteUrl.replace(/\/$/, '')}/data/history.json`;
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return { picks: [], slips: [] };
  if (!res.ok) throw new Error(`track record: ${url} -> HTTP ${res.status}`);
  const json = await res.json();
  return { picks: json.picks || [], slips: json.slips || [] };
}

function pickEntry(f, now) {
  const best = f.modes.best;
  const side = BOOK_SIDE[best.sourceMode];
  const bwin = side && f.odds?.bwin ? f.odds.bwin[side] : null;
  return {
    key: `${f.id}|${best.sourceMode}`,
    fixtureId: f.id,
    date: f.date,
    league: f.league,
    home: f.home.name,
    away: f.away.name,
    mode: best.sourceMode,
    probability: best.combined,
    odds: bwin ?? 1 / best.combined,
    oddsSource: bwin ? 'bwin' : 'implied',
    firstShown: now.toISOString(),
    outcome: null,
    score: null,
  };
}

/**
 * Adds the picks shown now (each recorded once, with the probability and
 * odds from when it first appeared), opens today's slip if there isn't one,
 * and grades anything whose result is in.
 * @returns {{ picks: object[], slips: object[] }}
 */
export function updateTrackRecord(record, { fixtures, results, now }) {
  const picks = [...record.picks];
  const slips = [...record.slips];
  const byKey = new Map(picks.map((p) => [p.key, p]));

  const shown = selectBestPicks(fixtures, now).map((f) => pickEntry(f, now));
  for (const p of shown) {
    if (!byKey.has(p.key)) { picks.push(p); byKey.set(p.key, p); }
  }

  const day = now.toISOString().slice(0, 10);
  if (shown.length === BEST_PICKS && !slips.some((s) => s.day === day)) {
    const legs = shown.map((p) => byKey.get(p.key));
    slips.push({ day, created: now.toISOString(), legs: legs.map((l) => l.key), odds: legs.reduce((a, l) => a * l.odds, 1), outcome: null });
  }

  const resultById = new Map(results.map((r) => [r.id, r]));
  for (const p of picks) {
    if (p.outcome || new Date(p.date) > now) continue;
    const r = resultById.get(p.fixtureId);
    if (r) {
      p.outcome = isHit(r.actual, p.mode) ? 'won' : 'lost';
      p.score = `${r.finalScore.home}-${r.finalScore.away}`;
    } else if (now - new Date(p.date) > VOID_AFTER_DAYS * 86_400_000) {
      p.outcome = 'void';
    }
  }
  for (const s of slips) {
    if (s.outcome) continue;
    // A leg whose pick was dropped from the record counts as void; a pending one stays null.
    const outcomes = s.legs.map((k) => (byKey.has(k) ? byKey.get(k).outcome : 'void'));
    if (outcomes.includes('lost')) s.outcome = 'lost';
    else if (outcomes.every((o) => o === 'won')) s.outcome = 'won';
    else if (outcomes.every(Boolean)) s.outcome = 'void';
  }

  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
  const keptSlips = slips.filter((s) => new Date(s.day).getTime() >= cutoff);
  const slipKeys = new Set(keptSlips.flatMap((s) => s.legs));
  return {
    picks: picks.filter((p) => new Date(p.date).getTime() >= cutoff || slipKeys.has(p.key)),
    slips: keptSlips,
  };
}
