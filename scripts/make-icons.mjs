#!/usr/bin/env node
/**
 * Renders the app icons with headless Chromium (no image libraries needed).
 *
 * The mark is the dashboard's own visual language: the three meter bars from
 * each fixture row (away win, BTTS, combined), on the app's dark surface.
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
const BLUE = '#3987e5';
const GREEN = '#0ca30c';

/** @param {number} inset fraction of the canvas kept clear for mask cropping */
const svg = (size, inset) => {
  const pad = size * inset;
  const w = size - pad * 2;
  const bars = [
    { y: 0.22, len: 0.55, c: BLUE },
    { y: 0.44, len: 0.80, c: BLUE },
    { y: 0.66, len: 0.66, c: GREEN },
  ];
  const h = size * 0.14;
  const r = h / 2.4;
  const rects = bars.map((b) => {
    const bw = Math.max(w * b.len, h);
    return `<rect x="${pad}" y="${pad + w * b.y}" width="${bw}" height="${h}" rx="${r}" fill="${b.c}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${SURFACE}"/>
    ${rects}
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
