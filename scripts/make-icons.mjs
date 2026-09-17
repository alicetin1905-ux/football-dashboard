#!/usr/bin/env node
/**
 * Renders the app icons with headless Chromium (no image libraries needed).
 *
 * The mark is a flat soccer-ball glyph — a central pentagon with five outer
 * patches and seam lines connecting them — on the app's dark surface.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Not a project dependency (this is a one-off local tool, run once and the
// output committed) — resolved via NODE_PATH against a global Playwright
// install instead, e.g.: NODE_PATH=$(npm root -g) node scripts/make-icons.mjs
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/icons');
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SURFACE = '#1a1a19';
const BALL_LIGHT = '#f2f2ee';
const BALL_DARK = '#151513';

/** Regular pentagon vertices as an SVG points string. */
const pentagon = (cx, cy, r, rotationDeg) => {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = (rotationDeg + i * 72) * (Math.PI / 180);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
};

/** @param {number} inset fraction of the canvas kept clear for mask cropping */
const svg = (size, inset) => {
  const pad = size * inset;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - pad;

  const centralR = R * 0.34;
  const patchR = R * 0.26;
  const patchDist = R * 0.72;
  const strokeW = R * 0.045;

  let patches = '';
  let seams = '';
  for (let i = 0; i < 5; i++) {
    const angle = -90 + i * 72;
    const rad = angle * (Math.PI / 180);
    const vx = cx + centralR * Math.cos(rad);
    const vy = cy + centralR * Math.sin(rad);
    const px = cx + patchDist * Math.cos(rad);
    const py = cy + patchDist * Math.sin(rad);
    seams += `<line x1="${vx.toFixed(2)}" y1="${vy.toFixed(2)}" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}" stroke="${BALL_DARK}" stroke-width="${strokeW.toFixed(2)}" stroke-linecap="round"/>`;
    patches += `<polygon points="${pentagon(px, py, patchR, angle + 180)}" fill="${BALL_DARK}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${SURFACE}"/>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="${BALL_LIGHT}" stroke="${BALL_DARK}" stroke-width="${strokeW.toFixed(2)}"/>
    ${seams}
    ${patches}
    <polygon points="${pentagon(cx, cy, centralR, -90)}" fill="${BALL_DARK}"/>
  </svg>`;
};

const TARGETS = [
  { file: 'icon-192.png', size: 192, inset: 0.16 },
  { file: 'icon-512.png', size: 512, inset: 0.16 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.24 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.16 },
];

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
await mkdir(OUT, { recursive: true });
for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;background:${SURFACE}">${svg(t.size, t.inset)}</body>`,
    { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/${t.file}`, omitBackground: false });
  await page.close();
  console.log(`  ${t.file}  ${t.size}x${t.size}`);
}
await browser.close();
console.log('icons written to docs/icons');
