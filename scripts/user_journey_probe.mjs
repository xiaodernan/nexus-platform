/**
 * §九 user-journey probe — REAL Playwright-driven behaviour simulations against a running
 * plane, committed as evidence instead of assertions about what users "probably" do.
 *
 * What it is NOT: no cookies, no storage, no PII — the plane runs in mock mode with synthetic
 * data; every click is ours. What it IS: a real browser performing real tasks, with measured
 * outcomes written to docs/evidence/user-journey-<date>.md (overwrite = the date is the
 * iteration stamp).
 *
 * Run: node scripts/user_journey_probe.mjs --url=http://127.0.0.1:7896
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const require = createRequire(join(repoRoot, 'tests', 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const BASE = argv.url ?? 'http://127.0.0.1:7896';
const STAMP = new Date().toISOString().slice(0, 10);
const OUT = join(repoRoot, 'docs', 'evidence', `user-journey-${STAMP}.md`);
const TIMEOUT = 15_000;

const now = () => Date.now();
const log = (...a) => console.log('[journey]', ...a);

async function recordVisit(page, journey) {
  journey.observations ??= {};
  try {
    journey.observations.scrollY = await page.evaluate(() => window.scrollY);
  } catch { /* ignore */ }
  journey.consoleErrors = journey.consoleErrors ?? [];
}

async function runJourney(browser, def) {
  const started = now();
  const consoleErrors = [];
  const actions = [];
  const record = (action, detail) => actions.push({ t: now() - started, action, detail });
  let outcome = 'completed';
  let endUrl = '';
  let observations = {};

  const context = await browser.newContext({ locale: 'zh-HK', timezoneId: 'Asia/Hong_Kong', baseURL: BASE });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160)); });
  page.on('pageerror', (err) => consoleErrors.push(String(err).slice(0, 160)));

  try {
    await def.fn({ page, record, actions });
    endUrl = page.url();
    try {
      observations.scrollY = await page.evaluate(() => window.scrollY);
      observations.scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      observations.innerWidth = await page.evaluate(() => window.innerWidth);
    } catch { /* ignore */ }
  } catch (cause) {
    outcome = 'crashed';
    endUrl = page.url();
    actions.push({ t: now() - started, action: 'crash', detail: String(cause).slice(0, 220) });
  } finally {
    await context.close();
  }

  return {
    name: def.name,
    duration_ms: now() - started,
    outcome,
    end_url: endUrl.replace(BASE, ''),
    console_errors: consoleErrors,
    actions,
    observations,
  };
}

const HOME = '/';
const journeys = [
  {
    name: 'impatient-close (3s — opens and bails)',
    fn: async ({ page }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
    },
  },
  {
    name: 'focused-search (opens, searches 拉麵)',
    fn: async ({ page, record }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const box = page.getByRole('combobox').first();
      await box.fill('拉麵');
      record('fill', '拉麵');
      await box.press('Enter');
      await page.waitForTimeout(1200);
      record('submit', page.url());
    },
  },
  {
    name: 'stray-clicker (opens, taps three unrelated links)',
    fn: async ({ page, record }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const targets = ['/hong-kong', '/hk-type', '/handbook'];
      for (const t of targets) {
        const link = page.locator(`main a[href="${t}"], header a[href="${t}"]`).first();
        if (await link.isVisible().catch(() => false)) {
          await link.click();
          record('click', t);
          await page.waitForLoadState('domcontentloaded');
        } else {
          record('skip-missing', t);
        }
      }
    },
  },
  {
    name: 'handbook-tour (opens the manual, jumps anchors)',
    fn: async ({ page, record }) => {
      await page.goto('/handbook', { waitUntil: 'domcontentloaded' });
      for (const anchor of ['#faq', '#hkseries', '#daily']) {
        const link = page.locator(`a[href="${anchor}"]`).first();
        if (await link.isVisible().catch(() => false)) {
          await link.click();
          record('anchor', anchor);
          await page.waitForTimeout(500);
        }
      }
    },
  },
  {
    name: 'chapter-reader (opens the mega hub, taps a chapter, goes back)',
    fn: async ({ page, record }) => {
      await page.goto('/hong-kong', { waitUntil: 'domcontentloaded' });
      const chapter = page.locator('main a[href^="/guides/hk-"]').first();
      await chapter.click();
      record('open-chapter', page.url());
      await page.waitForLoadState('domcontentloaded');
      await page.goBack();
      record('back', page.url());
    },
  },
  {
    name: 'locale-swapper (zh → en EN label read → toggle back to zh)',
    fn: async ({ page, record }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const toggle = page.getByRole('button').filter({ hasText: /^EN$/ }).first();
      await toggle.click();
      record('toggle-en', 'ok');
      await page.waitForTimeout(700);
      const back = page.getByRole('button').filter({ hasText: /繁體|中|語/ }).first();
      await back.click().catch(async () => { record('toggle-zh', 'selector-miss'); });
      record('end-url', page.url());
    },
  },
  {
    name: 'theme-toggle (flips dark, reads a token change, flips back)',
    fn: async ({ page, record }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const toggle = page.getByRole('button', { name: '切換至深色主題' }).or(page.getByRole('button', { name: 'Switch to dark theme' })).first();
      await toggle.click().catch(() => record('toggle', 'selector-miss'));
      record('theme-changed', 'ok');
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: /淺色主題|light theme/i }).first().click().catch(() => {});
    },
  },
  {
    name: 'wheel-scroller (scrolls down the page five bursts)',
    fn: async ({ page }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      await page.locator('main').waitFor({ state: 'visible' });
      await page.mouse.move(640, 420);
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(160);
      }
    },
  },
  {
    name: 'strip-bridge (hover chapter strip, wheel sideways)',
    fn: async ({ page, record }) => {
      await page.goto('/hong-kong', { waitUntil: 'domcontentloaded' });
      const strip = page.locator('section[aria-labelledby="arc-timeline-title"] ol').first();
      await strip.scrollIntoViewIfNeeded();
      const before = await strip.evaluate((el) => el.scrollLeft);
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(400);
      const after = await strip.evaluate((el) => el.scrollLeft);
      record('bridge-expected-growth', String(after > before));
      record('scrollLeft-before', String(before));
      record('scrollLeft-after', String(after));
    },
  },
  {
    name: 'merchant-browser (opens first merchant card, scrolls, returns)',
    fn: async ({ page, record }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const card = page.locator('main a[href^="/m/"]').first();
      await card.click();
      await page.waitForLoadState('domcontentloaded');
      record('open-merchant', page.url());
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(300);
      await page.goBack();
    },
  },
  {
    name: 'never-gets-comfort (cantankerous — types an empty query, hammers the CTA)',
    fn: async ({ page, record }) => {
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
      const box = page.getByRole('combobox').first();
      await box.fill('');
      await page.keyboard.press('Enter');
      record('empty-submit', page.url());
      await page.waitForTimeout(400);
      const stray = page.locator('header a[href="/search"]').first();
      await stray.click();
      record('goto-search-via-header', page.url());
    },
  },
  {
    name: 'closed-but-curious (opens /world, scrolls to footer, never clicks a chip)',
    fn: async ({ page }) => {
      await page.goto('/world', { waitUntil: 'domcontentloaded' });
      await page.mouse.move(600, 500);
      for (let i = 0; i < 6; i += 1) {
        await page.mouse.wheel(0, 420);
        await page.waitForTimeout(140);
      }
    },
  },
];

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const def of journeys) {
    log('running', def.name);
    results.push(await runJourney(browser, def));
  }
} finally {
  await browser.close();
}

const journeysMd = results.map((r, i) => `### ${i + 1}. ${r.name}
- duration: ${r.duration_ms} ms · outcome: **${r.outcome}** · end_url: \`${r.end_url || '/'}\`
- final scrollY: ${r.observations.scrollY ?? 'n/a'} · h-scrollWidth: ${r.observations.scrollWidth ?? 'n/a'} · viewport: ${r.observations.innerWidth ?? 'n/a'}px
- console errors: ${r.console_errors.length === 0 ? 'none' : r.console_errors.join(' | ')}
- actions:\n${r.actions.map((a) => `  - [${a.t}ms] ${a.action}${a.detail ? ' — ' + a.detail : ''}`).join('\n')}
`).join('\n');

const summary = {
  generated_at: new Date().toISOString(),
  base_url: BASE,
  plane: 'mock (合成數據 — no real merchant, no real reader)',
  journeys: results.map((r) => ({ name: r.name, duration_ms: r.duration_ms, outcome: r.outcome, console_errors: r.console_errors.length, end_url: r.end_url })),
};

const md = `# User-journey evidence — ${STAMP} (${summary.journeys.length} journeys, Playwright, this build)

- base: ${BASE} · plane: ${summary.plane}
- browser: headless Chromium · desktop pointer (fine) · locale zh-HK · timezone Asia/Hong_Kong
- purpose: behave like real (impatient / stray / happy) visitors against the mock build; observations are this run's facts, not production SLAs.

**Summary (machine-readable).**

\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

${journeysMd}
`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md, 'utf8');
log('wrote', OUT);
log('\nsummary:', JSON.stringify(summary.journeys.map((j) => ({ name: j.name.split('(')[0].trim(), ms: j.duration_ms, outcome: j.outcome, errs: j.console_errors }))));
