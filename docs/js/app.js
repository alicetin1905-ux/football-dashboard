import { pct, kickoff, relativeAgo, dayKey, dayHeading } from './format.js';

const ALERT_THRESHOLD = 0.5;
const ALERT_WINDOW_HOURS = 48;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STAKE = 10;

const MODES = {
  away: { label: 'Away win + BTTS', winLabel: 'Away win' },
  home: { label: 'Home win + BTTS', winLabel: 'Home win' },
  goals: { label: 'BTTS + Over 2.5', winLabel: 'Over 2.5' },
  dc1x: { label: 'Home/Draw + BTTS', winLabel: 'Home/Draw' },
  homeWin: { label: 'Home win', winLabel: 'Home win' },
  awayWin: { label: 'Away win', winLabel: 'Away win' },
  draw: { label: 'Draw', winLabel: 'Draw' },
  best: { label: 'Best of all modes', winLabel: 'Best %' },
};


const storedMode = readStore('btts-mode', 'away');
const storedStake = readStore('btts-stake', DEFAULT_STAKE);

const state = {
  fixtures: [],
  results: [],
  record: null, // data/history.json — Best picks as shown, graded once played
  valueThreshold: [0, 0.05, 0.1, 0.15].includes(readStore('btts-value-threshold', 0.1)) ? readStore('btts-value-threshold', 0.1) : 0.1,
  mySlip: readStore('btts-my-slip', []), // [{id, mode}] — one leg per match
  openDetails: new Set(), // fixture ids whose detail row is expanded
  view: 'upcoming', // 'upcoming' | 'results'
  league: '',
  day: '',
  hideLowSample: false,
  search: '',
  notify: false,
  mode: MODES[storedMode] ? storedMode : 'away',
  stake: Number.isFinite(storedStake) && storedStake >= 0 ? storedStake : DEFAULT_STAKE,
};

const els = {
  metaRow: document.getElementById('metaRow'),
  viewUpcomingBtn: document.getElementById('viewUpcomingBtn'),
  viewResultsBtn: document.getElementById('viewResultsBtn'),
  viewValueBtn: document.getElementById('viewValueBtn'),
  valueView: document.getElementById('valueView'),
  valueBody: document.getElementById('valueBody'),
  valueThreshold: document.getElementById('valueThreshold'),
  controls: document.querySelector('.controls'),
  table: document.querySelector('table'),
  resultsStats: document.getElementById('resultsStats'),
  bestPicks: document.getElementById('bestPicks'),
  bestPicksCards: document.getElementById('bestPicksCards'),
  bestPicksSlip: document.getElementById('bestPicksSlip'),
  trackRecord: document.getElementById('trackRecord'),
  mySlip: document.getElementById('mySlip'),
  mySlipBody: document.getElementById('mySlipBody'),
  mySlipClear: document.getElementById('mySlipClear'),
  mySlipFab: document.getElementById('mySlipFab'),
  trackRecordBody: document.getElementById('trackRecordBody'),
  leagueFilter: document.getElementById('leagueFilter'),
  dayFilterLabel: document.getElementById('dayFilterLabel'),
  dayFilter: document.getElementById('dayFilter'),
  hideLowSample: document.getElementById('hideLowSample'),
  teamSearch: document.getElementById('teamSearch'),
  modeSelect: document.getElementById('modeSelect'),
  winHeader: document.getElementById('winHeader'),
  rows: document.getElementById('rows'),
  emptyState: document.getElementById('emptyState'),
  notifyBtn: document.getElementById('notifyBtn'),
  installHint: document.getElementById('installHint'),
  installHow: document.getElementById('installHow'),
  installHintClose: document.getElementById('installHintClose'),
};

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/**
 * The server (scripts/lib/stats.mjs) now computes every mode's
 * probabilities up front — a proper joint Poisson goal-expectancy model,
 * not something cheap enough to duplicate per-keystroke in the browser —
 * and ships them as `f.modes.away` / `f.modes.home` / etc, including
 * `f.modes.best` (whichever mode had the top probability for that fixture,
 * calibrated against the backtest to correct its winner's-curse
 * overconfidence — see buildCalibrationCurve in stats.mjs). Picking a mode
 * client-side is just a lookup.
 */
function computeScore(f, mode) {
  return f.modes ? f.modes[mode] || null : null;
}

/** The mode a row/card is actually graded and labeled against — `best`'s own per-fixture pick, or the selected mode itself. */
function effectiveModeKey(f, mode) {
  return mode.key === 'best' ? f._view.sourceMode : mode.key;
}

function formBadges(letters, title) {
  if (!letters.length) return '<span class="form-none">—</span>';
  const spans = letters.map((l) => `<span class="form-badge form-${l.toLowerCase()}">${l}</span>`).join('');
  return `<span class="form-badges" title="${title}">${spans}</span>`;
}

function meter(value, cls = '') {
  const w = value == null ? 0 : Math.round(value * 100);
  return `
    <div class="meter">
      <div class="meter-track"><div class="meter-fill ${cls}" style="width:${w}%"></div></div>
      <span class="meter-value">${pct(value)}</span>
    </div>`;
}

function renderMeta(payload) {
  const isLive = payload.source !== 'mock';
  const sourceLabel = isLive ? `Live · ${payload.sourceLabel || payload.source.toUpperCase()}` : 'Demo data';
  els.metaRow.innerHTML = `
    <span class="badge ${isLive ? 'source-live' : 'source-mock'}">${sourceLabel}</span>
    <span>Refreshed ${relativeAgo(payload.generatedAt)}</span>
  `;
}

const BEST_PICKS = 3;

/**
 * The top row: the upcoming matches whose single most likely bet (any mode,
 * any league) has the highest probability. Ignores the filters below so it
 * always answers "what are the strongest picks right now", and skips
 * low-sample fixtures — the biggest raw numbers tend to come from teams
 * with too little history to trust.
 */
function bestPicksNow() {
  const now = Date.now();
  return state.fixtures
    .filter((f) => f.modes?.best && f.modes.best.confidence === 'ok' && new Date(f.date).getTime() > now)
    .sort((a, b) => b.modes.best.combined - a.modes.best.combined || new Date(a.date) - new Date(b.date))
    .slice(0, BEST_PICKS);
}

function renderBestPicks() {
  const picks = bestPicksNow();
  els.bestPicks.hidden = state.view !== 'upcoming' || !picks.length;
  els.bestPicksCards.innerHTML = picks.map((f, i) => {
    const best = f.modes.best;
    const real = bwinOdds(f, best.sourceMode);
    const odds = real ?? impliedOdds(best.combined);
    return `
    <div class="hero-card">
      <div class="hero-card-head">
        <span class="hero-rank">#${i + 1}</span>
        <span class="hero-league">${bwinTag(f)}${f.league}</span>
      </div>
      <div class="hero-match"><span class="home">${f.home.name}</span><span class="vs">vs</span>${f.away.name}</div>
      <div class="hero-figures">
        <div class="figure figure-combined"><div class="figure-value">${pct(best.combined)}</div><div class="figure-label">${MODES[best.sourceMode].label}</div></div>
        <div class="figure"><div class="figure-value">${odds.toFixed(2)}</div><div class="figure-label">${real ? 'bwin odds' : 'implied odds'}</div></div>
      </div>
      <div class="hero-kickoff">${kickoff(f.date)}</div>
    </div>`;
  }).join('');
  renderBetSlip(els.bestPicksSlip, picks.map((f) => slipLeg(f, f.modes.best.sourceMode, f.modes.best.combined)), { showModes: true });
}

const TRACK_STAKE = 10;
const TRACK_RECENT = 8;

const euros = (x) => `${x >= 0 ? '+' : '−'}€${Math.abs(x).toFixed(2)}`;
const profitOf = (outcome, odds) => (outcome === 'won' ? TRACK_STAKE * (odds - 1) : outcome === 'lost' ? -TRACK_STAKE : 0);

const OUTCOME_BADGE = {
  won: '<span class="result-badge result-hit">✓ Won</span>',
  lost: '<span class="result-badge result-miss">✗ Lost</span>',
  void: '<span class="result-badge result-void">Void</span>',
  null: '<span class="result-badge result-pending">Pending</span>',
};

/**
 * How the Best picks have actually done: every pick the row has shown
 * (recorded with its probability and odds when it first appeared) and one
 * 3-leg slip per day, graded against real results by each refresh.
 */
function renderTrackRecord() {
  const record = state.record;
  if (state.view !== 'upcoming' || !record?.picks?.length) { els.trackRecord.hidden = true; return; }
  els.trackRecord.hidden = false;

  const allDecided = record.picks.filter((p) => p.outcome === 'won' || p.outcome === 'lost');
  const listOf = (p) => p.list || 'best';
  const bestPicks = record.picks.filter((p) => listOf(p) === 'best');
  const decided = allDecided.filter((p) => listOf(p) === 'best');
  const won = decided.filter((p) => p.outcome === 'won');
  const pending = bestPicks.filter((p) => !p.outcome).length;
  const slips = record.slips.filter((s) => s.outcome === 'won' || s.outcome === 'lost');
  const since = record.picks.reduce((min, p) => (p.firstShown < min ? p.firstShown : min), record.picks[0].firstShown);
  const byType = ['best', 'away', 'home', 'goals', 'dc1x', 'homeWin', 'awayWin', 'draw'].map((list) => {
    const ps = allDecided.filter((p) => listOf(p) === list);
    const w = ps.filter((p) => p.outcome === 'won').length;
    return { list, n: ps.length, w, avg: ps.length ? ps.reduce((a, p) => a + p.probability, 0) / ps.length : null, profit: ps.reduce((a, p) => a + profitOf(p.outcome, p.odds), 0) };
  });
  const typeTable = allDecided.length
    ? `<div class="detail-sub">By bet type &middot; each one&rsquo;s own top 3, €${TRACK_STAKE} a pick</div>
      <table class="detail-table track-types">
        <thead><tr><th></th><th>Won</th><th>Hit rate</th><th>Predicted</th><th>Profit</th></tr></thead>
        <tbody>${byType.map((t) => `<tr><th>${t.list === 'best' ? 'Best picks' : MODES[t.list].label}</th>${t.n
          ? `<td>${t.w}/${t.n}</td><td>${pct(t.w / t.n)}</td><td>${pct(t.avg)}</td><td class="${t.profit >= 0 ? 'pos' : 'neg'}">${euros(t.profit)}</td>`
          : '<td colspan="4" class="detail-none">no results yet</td>'}</tr>`).join('')}</tbody>
      </table>`
    : '';

  const summary = decided.length
    ? `<div class="track-stats">
        <div class="track-stat"><div class="track-stat-value">${won.length}/${decided.length}</div><div class="track-stat-label">picks won (${pct(won.length / decided.length)})</div></div>
        <div class="track-stat"><div class="track-stat-value">${pct(decided.reduce((a, p) => a + p.probability, 0) / decided.length)}</div><div class="track-stat-label">average predicted</div></div>
        <div class="track-stat"><div class="track-stat-value">${euros(decided.reduce((a, p) => a + profitOf(p.outcome, p.odds), 0))}</div><div class="track-stat-label">€${TRACK_STAKE} on each pick</div></div>
        <div class="track-stat"><div class="track-stat-value">${slips.length ? `${slips.filter((s) => s.outcome === 'won').length}/${slips.length}` : '—'}</div><div class="track-stat-label">daily 3-leg slips won${slips.length ? ` (${euros(slips.reduce((a, s) => a + profitOf(s.outcome, s.odds), 0))} at €${TRACK_STAKE})` : ''}</div></div>
      </div>`
    : `<p class="track-note">Tracking since ${kickoff(since)}: ${bestPicks.length} Best pick${bestPicks.length === 1 ? '' : 's'}, plus each bet type&rsquo;s own top 3 (${record.picks.length - bestPicks.length} more), recorded so far. Results appear here once those matches are played.</p>`;

  const recent = [...bestPicks].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, TRACK_RECENT);
  els.trackRecordBody.innerHTML = `
    ${summary}
    ${typeTable}
    <div class="track-list">
      ${recent.map((p) => `
        <div class="track-row">
          <span class="track-when">${kickoff(p.date)}</span>
          <span class="track-match"><span class="home">${p.home}</span><span class="vs">vs</span>${p.away} <span class="leg-mode">${MODES[p.mode]?.label ?? p.mode}</span></span>
          <span class="track-odds">${p.oddsSource === 'bwin' ? '<span class="leg-book">bwin</span>' : ''}${p.odds.toFixed(2)}</span>
          <span class="track-outcome">${p.score ? `<span class="final-score">${p.score.replace('-', '&ndash;')}</span>` : ''}${OUTCOME_BADGE[p.outcome]}</span>
        </div>`).join('')}
    </div>
    <p class="bet-slip-disclaimer">
      Each pick is recorded once, with the probability and odds it had when it first appeared; one slip a
      day is taken from that day's first 3 picks. Profit uses those odds: bwin&rsquo;s where it had priced the
      match, otherwise 1 &divide; probability, which has no bookmaker margin, so real returns on those would be
      lower.${pending ? ` ${pending} still to be played.` : ''} Not betting advice.
    </p>`;
}

/** 1 ÷ probability — the decimal odds our own estimate implies, not a bookmaker price. */
const impliedOdds = (p) => (p > 0 ? 1 / p : null);

const BOOK_SIDE = { homeWin: 'home', draw: 'draw', awayWin: 'away' };

/**
 * bwin's real price for the market this mode bets on, or null. Only the
 * single-outcome modes have one — the odds feed has no BTTS or combo markets
 * — and only for fixtures the feed already lists (a few days ahead).
 */
function bwinOdds(f, modeKey) {
  const side = BOOK_SIDE[modeKey];
  return side && f.odds && f.odds.bwin ? f.odds.bwin[side] : null;
}

const bwinTag = (f) => (f.probSource === 'bwin'
  ? '<span class="prob-bwin" title="Probabilities derived from bwin\'s odds for this match, not our form model">bwin odds</span>'
  : '');

function bookOddsHtml(f, modeKey, cls) {
  const odds = bwinOdds(f, modeKey);
  return odds ? `<span class="${cls}" title="bwin's price for this outcome — a real bookmaker quote">bwin ${odds.toFixed(2)}</span>` : '';
}

const slipContainers = () => [els.bestPicksSlip, els.mySlipBody].filter(Boolean);

/** Recomputes just the return/profit figures for the current stake — leaves the rest of the card, and the stake input's focus, untouched. */
function updateBetSlipReturn(container) {
  const combinedOdds = Number(container.dataset.combinedOdds);
  const returnEl = container.querySelector('.bet-slip-return-value');
  const profitEl = container.querySelector('.bet-slip-profit');
  if (!returnEl || !profitEl || !Number.isFinite(combinedOdds)) return;
  const returns = combinedOdds * state.stake;
  returnEl.textContent = `€${returns.toFixed(2)}`;
  profitEl.textContent = `(+€${(returns - state.stake).toFixed(2)})`;
}

/** The stake is shared: typing in either slip updates both. */
function onStakeInput(e) {
  const val = parseFloat(e.target.value);
  state.stake = Number.isFinite(val) && val >= 0 ? val : 0;
  writeStore('btts-stake', state.stake);
  for (const c of slipContainers()) {
    const input = c.querySelector('.stake-input');
    if (input && input !== e.target) input.value = state.stake;
    updateBetSlipReturn(c);
  }
}

/** A leg for each fixture: bwin's real price for its bet when there is one, otherwise 1 ÷ probability. */
function slipLeg(f, modeKey, probability) {
  const real = bwinOdds(f, modeKey);
  return { f, modeKey, odds: real ?? impliedOdds(probability), real: real != null };
}

/**
 * @param {HTMLElement} container
 * @param {{f: object, modeKey: string, odds: number, real: boolean}[]} legs
 * @param {{showModes: boolean}} options show each leg's bet type (when legs differ)
 */
function renderBetSlip(container, legs, { showModes, removable = false }) {
  if (!container) return;
  legs = legs.filter((leg) => leg.odds != null);
  if (!legs.length) { container.innerHTML = ''; return; }
  const realCount = legs.filter((leg) => leg.real).length;
  const combinedOdds = legs.reduce((acc, leg) => acc * leg.odds, 1);
  const returns = combinedOdds * state.stake;
  const inputId = `${container.id}Stake`;
  container.dataset.combinedOdds = combinedOdds;

  container.innerHTML = `
    <div class="bet-slip-head">
      <span class="bet-slip-label">Combined &middot; ${legs.length}-leg acca</span>
      <span class="bet-slip-odds">${combinedOdds.toFixed(2)}&times;</span>
    </div>
    <div class="bet-slip-legs">
      ${legs.map((leg) => `
        <div class="bet-slip-leg">
          <span class="leg-teams">${leg.f.home.name}<span class="vs">vs</span>${leg.f.away.name}${
            showModes ? ` <span class="leg-mode">${MODES[leg.modeKey].label}</span>` : ''
          }</span>
          <span class="leg-odds">${leg.real ? '<span class="leg-book">bwin</span>' : ''}${leg.odds.toFixed(2)}${
            removable ? `<button type="button" class="leg-remove" data-id="${leg.f.id}" aria-label="Remove ${leg.f.home.name} vs ${leg.f.away.name}">&times;</button>` : ''
          }</span>
        </div>
      `).join('')}
    </div>
    <div class="bet-slip-stake">
      <label for="${inputId}">Stake</label>
      <span class="stake-input-wrap">
        <span class="stake-currency">&euro;</span>
        <input type="number" id="${inputId}" class="stake-input" min="0" step="1" inputmode="decimal" value="${state.stake}">
      </span>
    </div>
    <div class="bet-slip-return">
      <span>Potential return</span>
      <strong class="bet-slip-return-value">&euro;${returns.toFixed(2)}</strong>
      <span class="bet-slip-profit">(+&euro;${(returns - state.stake).toFixed(2)})</span>
    </div>
    <p class="bet-slip-disclaimer">
      ${realCount === legs.length
        ? 'Every leg uses bwin&rsquo;s real price.'
        : `${realCount ? 'Legs marked &ldquo;bwin&rdquo; use bwin&rsquo;s real price; the others are' : 'Odds are'}
      1 &divide; our probability, not a bookmaker price (the bwin feed has no price for that match or market).`}
      Combining legs multiplies their
      uncertainty together, not just their odds. Illustrative only, not betting advice.
    </p>
  `;
  container.querySelector('.stake-input').addEventListener('input', onStakeInput);
}

function populateLeagues(fixtures) {
  const leagues = [...new Set(fixtures.map((f) => f.league))].sort();
  els.leagueFilter.innerHTML = '<option value="">All leagues</option>' +
    leagues.map((l) => `<option value="${l}">${l}</option>`).join('');
  els.leagueFilter.value = state.league;
}

/** Unique fixture days, chronological, as <option>s — "All weekend" plus one per day. */
function populateDays(fixtures) {
  const seen = new Map();
  for (const f of fixtures) {
    const key = dayKey(f.date);
    if (!seen.has(key)) seen.set(key, f.date);
  }
  const keys = [...seen.keys()].sort();
  els.dayFilter.innerHTML = '<option value="">All weekend</option>' +
    keys.map((k) => `<option value="${k}">${dayHeading(seen.get(k))}</option>`).join('');
  els.dayFilter.value = state.day;
}

/**
 * Filters fixtures, then attaches the score for the currently selected
 * ranking mode as `_view` and re-sorts by it — the server only pre-sorts by
 * away-win mode, so switching to home mode needs a client-side re-rank.
 */
function applyFilters() {
  const viewed = state.fixtures
    .map((f) => ({ f, view: computeScore(f, state.mode) }))
    .filter(({ view }) => view != null);

  const filtered = viewed.filter(({ f, view }) => {
    if (state.league && f.league !== state.league) return false;
    if (state.day && dayKey(f.date) !== state.day) return false;
    if (state.hideLowSample && view.confidence === 'low') return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!f.home.name.toLowerCase().includes(q) && !f.away.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.view.combined - a.view.combined);
  return filtered.map(({ f, view }) => ({ ...f, _view: view }));
}

/** Whether a backtested result's actual outcome matches the currently selected bet (mode-aware). */
function isHit(f, mode) {
  if (mode === 'goals') return f.actual.over25 && f.actual.btts;
  if (mode === 'dc1x') return !f.actual.awayWin && f.actual.btts;
  if (mode === 'homeWin') return f.actual.homeWin;
  if (mode === 'awayWin') return f.actual.awayWin;
  if (mode === 'draw') return f.actual.draw;
  const won = mode === 'home' ? f.actual.homeWin : f.actual.awayWin;
  return won && f.actual.btts;
}

/**
 * Same shape as applyFilters(), but over the played-match backtest and
 * without the day filter — results carry past dates, not the upcoming
 * window the day filter's options are built from. Kept in the same
 * highest-confidence-first order as the upcoming list, rather than
 * reordering by hit/miss, so a glance at the top rows shows both how
 * confident the model was and whether it was right.
 */
function applyResultFilters() {
  const viewed = state.results
    .map((f) => ({ f, view: computeScore(f, state.mode) }))
    .filter(({ view }) => view != null);

  const filtered = viewed.filter(({ f, view }) => {
    if (state.league && f.league !== state.league) return false;
    if (state.hideLowSample && view.confidence === 'low') return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!f.home.name.toLowerCase().includes(q) && !f.away.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.view.combined - a.view.combined);
  return filtered.map(({ f, view }) => ({ ...f, _view: view }));
}

function renderResultsStats(results, mode) {
  if (!els.resultsStats) return;
  if (!results.length) { els.resultsStats.hidden = true; return; }

  const graded = results.filter((f) => f._view.confidence === 'ok');
  const hits = graded.filter((f) => isHit(f, effectiveModeKey(f, mode))).length;
  const forWhat = mode.key === 'best' ? 'whichever mode fit each match best' : mode.label.toLowerCase();

  els.resultsStats.hidden = false;
  els.resultsStats.innerHTML = graded.length
    ? `<strong>${hits}/${graded.length}</strong> ok-confidence calls correct
       (<strong>${pct(hits / graded.length)}</strong>) for ${forWhat}
       over the last week &mdash; ${results.length - graded.length} more shown below are low-sample.`
    : `No ok-confidence backtested results yet for ${forWhat}.`;
}

function matchRowHtml(f, mode, isResult) {
  const rowMode = mode.key === 'best' ? MODES[effectiveModeKey(f, mode)] : mode;
  const hit = isResult ? isHit(f, effectiveModeKey(f, mode)) : null;
  const scoreBadge = isResult
    ? `<span class="final-score">${f.finalScore.home}&ndash;${f.finalScore.away}</span>
       <span class="result-badge ${hit ? 'result-hit' : 'result-miss'}">${hit ? '✓ Hit' : '✗ Miss'}</span>`
    : '';
  const modeBadge = mode.key === 'best' ? `<span class="mode-badge">${rowMode.label}</span>` : '';
  const modeKey = effectiveModeKey(f, mode);
  const slipLegNow = state.mySlip.find((l) => l.id === f.id);
  const inSlip = slipLegNow?.mode === modeKey;
  const actions = isResult ? '' : `
        <div class="row-actions">
          <button type="button" class="row-btn slip-toggle" data-id="${f.id}" data-mode="${modeKey}" aria-pressed="${inSlip}"
            title="${slipLegNow && !inSlip ? `Swap this match's leg in My slip to ${rowMode.label}` : 'Add this bet to My slip'}">${inSlip ? '✓ In slip' : slipLegNow ? '↻ Swap in slip' : '+ Slip'}</button>
          <button type="button" class="row-btn detail-toggle" data-id="${f.id}" aria-expanded="${state.openDetails.has(f.id)}">${state.openDetails.has(f.id) ? 'Hide details' : 'Details'}</button>
        </div>`;
  return `
    <tr>
      <td class="kickoff" data-label="Kickoff">${kickoff(f.date)}</td>
      <td class="league" data-label="League">${f.league}</td>
      <td class="fixture" data-label="Fixture">
        <span class="home">${f.home.name}</span><span class="vs">vs</span>${f.away.name}
        ${modeBadge}
        ${bwinTag(f)}
        ${scoreBadge}
        ${f._view.confidence === 'low' ? '<span class="confidence-low" title="Fewer than 5 matches at this venue on record for one side — e.g. a team new to the division">low sample</span>' : ''}
        <div class="form-row">
          <span class="form-label">Home</span>
          ${formBadges(f.stats.home.homeForm, `${f.home.name}'s last home matches, oldest to newest`)}
          <span class="form-label">Away</span>
          ${formBadges(f.stats.away.awayForm, `${f.away.name}'s last away matches, oldest to newest`)}
        </div>${actions}
      </td>
      <td data-label="${rowMode.winLabel}">${meter(f._view.winLikelihood)}</td>
      <td data-label="BTTS">${meter(f._view.bttsLikelihood)}</td>
      <td data-label="Combined">${meter(f._view.combined, 'combined')}${bookOddsHtml(f, effectiveModeKey(f, mode), 'row-book')}</td>
    </tr>
    ${!isResult && state.openDetails.has(f.id) ? detailRowHtml(f) : ''}
  `;
}

/* ------------------------------ match details ------------------------------ */

const resultLetter = (score) => { const [a, b] = score.split('-').map(Number); return a > b ? 'w' : a < b ? 'l' : 'd'; };

function recentListHtml(team, entries) {
  if (!entries?.length) return `<div class="detail-col"><div class="detail-sub">${team}</div><p class="detail-none">No recent matches on record.</p></div>`;
  return `<div class="detail-col">
    <div class="detail-sub">${team} &middot; last ${entries.length}</div>
    ${entries.map((m) => `
      <div class="detail-match${m.b ? ' detail-borrowed' : ''}" ${m.b ? 'title="Last season, in the division this team came from"' : ''}>
        <span class="form-badge form-${resultLetter(m.s)}">${resultLetter(m.s).toUpperCase()}</span>
        <span class="detail-date">${m.d.slice(5).replace('-', '/')}</span>
        <span class="detail-venue">${m.v === 'H' ? 'vs' : '@'}</span>
        <span class="detail-opp">${m.o}${m.b ? ' <span class="detail-tag">prev. div.</span>' : ''}</span>
        <span class="detail-score">${m.s.replace('-', '&ndash;')}</span>
        <span class="detail-xg">${m.x ? `xG ${m.x.replace('-', '&ndash;')}` : ''}</span>
      </div>`).join('')}
  </div>`;
}

/** Our model's numbers next to bwin's (where bwin has priced the match), plus form and meetings. */
function detailRowHtml(f) {
  const model = f.modelModes || f.modes;
  const bwin = f.probSource === 'bwin' ? f.modes : null;
  const rows = [
    ['Home win', (m) => m.homeWin.combined, 'home'],
    ['Draw', (m) => m.draw.combined, 'draw'],
    ['Away win', (m) => m.awayWin.combined, 'away'],
    ['Over 2.5', (m) => m.goals.winLikelihood, null],
    ['BTTS', (m) => m.goals.bttsLikelihood, null],
  ];
  const xg = (m) => `${m.expectedGoals.home.toFixed(2)} &ndash; ${m.expectedGoals.away.toFixed(2)}`;
  const d = f.detail || { home: [], away: [], h2h: [] };
  return `
    <tr class="detail-row"><td colspan="6"><div class="detail">
      <div class="detail-probs">
        <table class="detail-table">
          <thead><tr><th></th><th>Our model</th>${bwin ? '<th>From bwin</th>' : ''}<th>bwin price</th></tr></thead>
          <tbody>
            ${rows.map(([label, get, side]) => `<tr><th>${label}</th><td>${pct(get(model))}</td>${bwin ? `<td>${pct(get(bwin))}</td>` : ''}<td>${side && f.odds?.bwin ? f.odds.bwin[side].toFixed(2) : '&mdash;'}</td></tr>`).join('')}
            <tr><th>Expected goals</th><td>${xg(model)}</td>${bwin ? `<td>${xg(bwin)}</td>` : ''}<td></td></tr>
          </tbody>
        </table>
        <p class="detail-note">${bwin
          ? 'The page uses bwin&rsquo;s numbers for this match &mdash; they beat our model in every backtest. Over 2.5 and BTTS &ldquo;from bwin&rdquo; are read off bwin&rsquo;s implied expected goals.'
          : 'bwin hasn&rsquo;t priced this match yet (or doesn&rsquo;t cover this competition), so these are our model&rsquo;s numbers.'}</p>
      </div>
      <div class="detail-cols">
        ${recentListHtml(f.home.name, d.home)}
        ${recentListHtml(f.away.name, d.away)}
      </div>
      <div class="detail-sub">Head to head</div>
      ${d.h2h.length
        ? d.h2h.map((m) => `<div class="detail-h2h"><span class="detail-date">${m.d}</span> ${m.h} <strong>${m.s.replace('-', '&ndash;')}</strong> ${m.a}</div>`).join('')
        : '<p class="detail-none">No meetings in the last two seasons on record.</p>'}
    </div></td></tr>`;
}

/* --------------------------------- my slip --------------------------------- */

function saveMySlip() { writeStore('btts-my-slip', state.mySlip); }

function toggleSlipLeg(id, mode) {
  const existing = state.mySlip.find((l) => l.id === id);
  if (existing?.mode === mode) state.mySlip = state.mySlip.filter((l) => l.id !== id);
  else if (existing) existing.mode = mode; // one leg per match: swap its bet type
  else state.mySlip.push({ id, mode });
  saveMySlip();
  render();
}

/** Your own picks from the table — one leg per match, bwin's real price where it has one. */
function renderMySlip() {
  const now = Date.now();
  const byId = new Map(state.fixtures.map((f) => [f.id, f]));
  const kept = state.mySlip.filter((l) => byId.has(l.id) && new Date(byId.get(l.id).date).getTime() > now && byId.get(l.id).modes[l.mode]);
  if (kept.length !== state.mySlip.length) { state.mySlip = kept; saveMySlip(); }
  const show = state.view === 'upcoming' && kept.length > 0;
  els.mySlip.hidden = !show;
  els.mySlipFab.hidden = !show;
  if (!show) return;
  els.mySlipFab.querySelector('span').textContent = String(kept.length);
  renderBetSlip(els.mySlipBody, kept.map((l) => slipLeg(byId.get(l.id), l.mode, byId.get(l.id).modes[l.mode].combined)), { showModes: true, removable: true });
}

function syncModeUi() {
  const mode = MODES[state.mode];
  if (els.modeSelect) els.modeSelect.value = state.mode;
  if (els.winHeader) els.winHeader.textContent = mode.winLabel;
}

/**
 * Matches bwin has priced where our own model's probability for an outcome
 * is above bwin's price — expected value = our probability × bwin's odds − 1.
 * Home/draw/away only (the feed has no other markets). Uses `modelModes`,
 * our model's numbers, since a bwin-priced fixture's headline numbers are
 * bwin's own and would show no edge by construction. Ok-sample matches only,
 * as in the backtest quoted on the tab.
 */
function valueSelections(threshold) {
  const now = Date.now();
  const rows = [];
  let priced = 0;
  for (const f of state.fixtures) {
    if (!f.odds?.bwin || !f.modelModes || new Date(f.date).getTime() <= now) continue;
    priced++;
    if (f.modelModes.away.confidence !== 'ok') continue;
    const inv = ['home', 'draw', 'away'].map((s) => 1 / f.odds.bwin[s]);
    const margin = inv[0] + inv[1] + inv[2];
    [['homeWin', 'home', 'Home win'], ['draw', 'draw', 'Draw'], ['awayWin', 'away', 'Away win']].forEach(([mode, side, label], i) => {
      const ours = f.modelModes[mode].combined;
      const odds = f.odds.bwin[side];
      const ev = ours * odds - 1;
      if (ev > threshold) rows.push({ f, label, ours, market: inv[i] / margin, odds, ev });
    });
  }
  return { rows: rows.sort((a, b) => b.ev - a.ev), priced };
}

function renderValue() {
  els.valueView.hidden = state.view !== 'value';
  if (state.view !== 'value') return;
  els.valueThreshold.value = String(state.valueThreshold);
  const { rows, priced } = valueSelections(state.valueThreshold);
  els.valueBody.innerHTML = rows.length
    ? `<div class="track-list">${rows.map((r) => `
        <div class="track-row value-row">
          <span class="track-when">${kickoff(r.f.date)}</span>
          <span class="track-match"><span class="home">${r.f.home.name}</span><span class="vs">vs</span>${r.f.away.name} <span class="leg-mode">${r.label}</span></span>
          <span class="value-nums">ours ${pct(r.ours)} &middot; bwin ${pct(r.market)}</span>
          <span class="track-odds"><span class="leg-book">bwin</span>${r.odds.toFixed(2)} <span class="value-ev">${r.ev >= 0 ? '+' : ''}${(r.ev * 100).toFixed(0)}%</span></span>
        </div>`).join('')}</div>`
    : `<p class="track-note">No bwin-priced match clears a ${pct(state.valueThreshold)} edge right now (${priced} upcoming match${priced === 1 ? '' : 'es'} priced by bwin). bwin lists matches only a few days ahead.</p>`;
}

function syncViewUi() {
  const isResults = state.view === 'results';
  const isValue = state.view === 'value';
  els.viewUpcomingBtn.setAttribute('aria-pressed', String(state.view === 'upcoming'));
  els.viewResultsBtn.setAttribute('aria-pressed', String(isResults));
  els.viewValueBtn.setAttribute('aria-pressed', String(isValue));
  els.controls.hidden = isValue;
  els.table.hidden = isValue;
  if (isValue) { els.emptyState.hidden = true; els.resultsStats.hidden = true; }
  els.dayFilterLabel.hidden = isResults;
  els.emptyState.textContent = isResults
    ? 'No recent results match these filters.'
    : 'No fixtures match these filters.';
}

function render() {
  syncModeUi();
  syncViewUi();
  renderBestPicks();
  renderTrackRecord();
  renderMySlip();
  renderValue();
  if (state.view === 'value') return;
  const mode = { ...MODES[state.mode], key: state.mode };

  if (state.view === 'results') {
    const filtered = applyResultFilters();
    renderResultsStats(filtered, mode);
    els.emptyState.hidden = filtered.length > 0;
    els.rows.innerHTML = filtered.map((f) => matchRowHtml(f, mode, true)).join('');
    return;
  }

  els.resultsStats.hidden = true;
  const filtered = applyFilters();
  els.emptyState.hidden = filtered.length > 0;
  els.rows.innerHTML = filtered.map((f) => matchRowHtml(f, mode, false)).join('');
}

/* ------------------------------- PWA + alerts ------------------------------ */

const notifyPermission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** True once the page is running as an installed app (iOS requires this). */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function showInstallHint(message) {
  els.installHow.textContent = message
    || (isIos()
      ? 'In Safari: Share → Add to Home Screen, then open it from there and tap Alerts again.'
      : 'Install this app from your browser menu, then tap Alerts again.');
  els.installHint.hidden = false;
}

/** Notifications go through the service worker: iOS has no Notification ctor. */
async function notify(title, body, tag) {
  if (!state.notify || notifyPermission() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.showNotification) {
      await reg.showNotification(title, {
        body, tag: tag || 'btts-tracker', icon: './icons/icon-192.png', badge: './icons/icon-192.png',
      });
    }
  } catch { /* notification is best-effort */ }
}

function syncNotifyButton() {
  const on = state.notify && notifyPermission() === 'granted';
  els.notifyBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  els.notifyBtn.querySelector('span[aria-hidden]').textContent = on ? '●' : '○';
}

async function enableNotifications() {
  if (notifyPermission() === 'unsupported') {
    showInstallHint('This browser does not support notifications.');
    return;
  }
  // On iOS, asking from a Safari tab is denied outright; it only works once the
  // app has been added to the Home Screen.
  if (isIos() && !isStandalone()) {
    showInstallHint();
    return;
  }
  let perm = notifyPermission();
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    showInstallHint(perm === 'denied'
      ? 'Notifications are blocked for this site — enable them in your browser settings.'
      : undefined);
    state.notify = false;
  } else {
    state.notify = true;
    notify('Alerts on', `You'll be told when a fixture clears ${pct(ALERT_THRESHOLD)} away win + BTTS, and when a new match enters Best picks.`);
    maybeNotifyFixtures(state.fixtures);
    maybeNotifyBestPicks();
  }
  writeStore('btts-notify', state.notify);
  syncNotifyButton();
}

async function toggleNotifications() {
  if (state.notify) {
    state.notify = false;
    writeStore('btts-notify', false);
    syncNotifyButton();
    return;
  }
  await enableNotifications();
}

/**
 * Fire an alert for a fixture that just cleared the threshold, once per
 * fixture. Only "ok" confidence fixtures count — a low-sample fixture
 * hitting 100% from one lucky match isn't worth an interruption.
 */
function maybeNotifyFixtures(fixtures) {
  if (!state.notify) return;
  const notifiedIds = new Set(readStore('btts-notified-ids', []));
  const now = Date.now();
  const windowMs = ALERT_WINDOW_HOURS * 3600 * 1000;
  let changed = false;

  for (const f of fixtures) {
    if (f.score.confidence !== 'ok') continue;
    if (f.score.combined < ALERT_THRESHOLD) continue;
    const kickoffMs = new Date(f.date).getTime();
    if (kickoffMs < now || kickoffMs - now > windowMs) continue;
    if (notifiedIds.has(f.id)) continue;

    notifiedIds.add(f.id);
    changed = true;
    notify(
      `${f.home.name} vs ${f.away.name}`,
      `${pct(f.score.combined)} away win + BTTS · ${f.league} · ${kickoff(f.date)}`,
      `fixture-${f.id}`,
    );
  }

  if (changed) writeStore('btts-notified-ids', [...notifiedIds].slice(-300));
}

/**
 * Alert when a match enters the Best picks row. The first time this runs
 * on a device it only remembers the current picks, so turning alerts on
 * doesn't fire three notifications for picks already on screen.
 */
function maybeNotifyBestPicks() {
  if (!state.notify) return;
  const stored = readStore('btts-best-seen', null);
  const seen = new Set(stored || []);
  const picks = bestPicksNow();
  for (const f of picks) {
    const key = `${f.id}|${f.modes.best.sourceMode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (stored) {
      const odds = bwinOdds(f, f.modes.best.sourceMode);
      notify(
        `New best pick: ${f.home.name} vs ${f.away.name}`,
        `${MODES[f.modes.best.sourceMode].label} ${pct(f.modes.best.combined)}${odds ? ` · bwin ${odds.toFixed(2)}` : ''} · ${f.league} · ${kickoff(f.date)}`,
        `best-${key}`,
      );
    }
  }
  writeStore('btts-best-seen', [...seen].slice(-200));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
}

/* ---------------------------------------------------------------------- */

async function refreshData() {
  const [res, record] = await Promise.all([
    fetch('./data/fixtures.json', { cache: 'no-store' }),
    fetch('./data/history.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const payload = await res.json();
  state.record = record;
  state.fixtures = payload.fixtures;
  state.results = payload.results || [];
  renderMeta(payload);
  populateLeagues(state.fixtures);
  populateDays(state.fixtures);
  render();
  maybeNotifyFixtures(state.fixtures);
  maybeNotifyBestPicks();
}

async function main() {
  registerServiceWorker();
  state.notify = readStore('btts-notify', false) && notifyPermission() === 'granted';
  syncNotifyButton();

  await refreshData();

  els.leagueFilter.addEventListener('change', (e) => { state.league = e.target.value; render(); });
  els.rows.addEventListener('click', (e) => {
    const slipBtn = e.target.closest('.slip-toggle');
    if (slipBtn) { toggleSlipLeg(slipBtn.dataset.id, slipBtn.dataset.mode); return; }
    const detailBtn = e.target.closest('.detail-toggle');
    if (detailBtn) {
      const id = detailBtn.dataset.id;
      if (state.openDetails.has(id)) state.openDetails.delete(id); else state.openDetails.add(id);
      render();
    }
  });
  els.mySlipBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.leg-remove');
    if (!btn) return;
    state.mySlip = state.mySlip.filter((l) => l.id !== btn.dataset.id);
    saveMySlip();
    render();
  });
  els.mySlipClear.addEventListener('click', () => { state.mySlip = []; saveMySlip(); render(); });
  els.dayFilter.addEventListener('change', (e) => { state.day = e.target.value; render(); });
  els.hideLowSample.addEventListener('change', (e) => { state.hideLowSample = e.target.checked; render(); });
  els.teamSearch.addEventListener('input', (e) => { state.search = e.target.value; render(); });
  els.modeSelect.addEventListener('change', (e) => {
    state.mode = MODES[e.target.value] ? e.target.value : 'away';
    writeStore('btts-mode', state.mode);
    render();
  });
  els.notifyBtn.addEventListener('click', toggleNotifications);
  els.installHintClose.addEventListener('click', () => { els.installHint.hidden = true; });
  els.viewUpcomingBtn.addEventListener('click', () => { state.view = 'upcoming'; render(); });
  els.viewResultsBtn.addEventListener('click', () => { state.view = 'results'; render(); });
  els.viewValueBtn.addEventListener('click', () => { state.view = 'value'; render(); });
  els.valueThreshold.addEventListener('change', (e) => {
    state.valueThreshold = Number(e.target.value);
    writeStore('btts-value-threshold', state.valueThreshold);
    render();
  });

  // Alerts only fire while the page is open — refetch periodically (and
  // immediately on return to the tab) so a long-open tab still catches new
  // fixtures crossing the threshold between scheduled refreshes. Once we
  // have a first successful load, a later refresh failing shouldn't wipe
  // the page — just log it and keep showing the last good data.
  const backgroundRefresh = () => refreshData().catch((err) => console.error(err));
  setInterval(() => { if (document.visibilityState === 'visible') backgroundRefresh(); }, REFRESH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') backgroundRefresh();
  });
}

main().catch((err) => {
  console.error(err);
  els.rows.innerHTML = '';
  els.emptyState.hidden = false;
  els.emptyState.textContent = 'Could not load fixture data.';
});
