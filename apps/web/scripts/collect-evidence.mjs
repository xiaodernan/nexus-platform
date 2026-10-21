#!/usr/bin/env node
/**
 * `npm run evidence` — capture the §170 review pack from a running build.
 *
 * The pack is five surfaces, each with the marker that proves it rendered for real: landing,
 * a streamed search, the first merchant the search links to, and the two console gates. A page
 * whose marker is missing fails the run and still leaves its screenshot and error in the manifest,
 * because the picture of the failure is evidence too.
 *
 * Screenshots and `manifest.json` are gitignored (`tests/evidence/*`); only `.gitkeep` is tracked.
 * Nothing here starts or stops a service: point `--base-url` at a build that is already serving.
 *
 * Usage: npm run evidence [-- --base-url http://127.0.0.1:3002 --query "适合约会 餐厅" --headed]
 */

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const VIEWPORT = { width: 1440, height: 900 };
const LOCALE = 'zh-HK';

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const base = flag('base-url', process.env.NEXUS_WEB_URL || 'http://127.0.0.1:3002').replace(/\/+$/, '');
const query = flag('query', '适合约会 餐厅');
const outDir = path.resolve(flag('out', path.join(ROOT, 'tests/evidence')));
const headed = process.argv.includes('--headed');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const wait = (page, locator, what, timeout = 20000) =>
  locator.first().waitFor({ state: 'visible', timeout }).catch(() => {
    throw new Error(`${what} did not appear within ${timeout}ms`);
  });

/**
 * Playwright's `visible` is a layout fact, not a paint fact: a Reveal wrapper still sitting at
 * `opacity: 0` before hydration counts as visible, and a screenshot taken there shows a blank
 * section. Wait until every on-screen element that carries an inline opacity has reached 1.
 */
async function settled(page, timeout = 15000) {
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[style*="opacity"]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]');
          })
          .every((el) => Number.parseFloat(getComputedStyle(el).opacity) >= 0.99),
      null,
      { timeout },
    )
    .catch(() => {
      throw new Error(`the page never reached full opacity within ${timeout}ms`);
    });
}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0];
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: VIEWPORT, locale: LOCALE, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'nexus_locale', value: LOCALE, url: base }]);
  const page = await context.newPage();
  const pages = [];

  async function snap({ name, url, check }) {
    const entry = { name, requested_url: url, captured_at: new Date().toISOString(), ok: true };
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      entry.status = response ? response.status() : null;
      entry.final_url = page.url();
      entry.title = await page.title();
      entry.markers = await check(page);
      await settled(page);
      entry.rendered_opaque = true;
    } catch (error) {
      entry.ok = false;
      entry.error = firstLine(error);
    }

    const file = path.join(outDir, `${String(pages.length + 1).padStart(2, '0')}-${name}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      const bytes = readFileSync(file);
      entry.screenshot = path.basename(file);
      entry.screenshot_bytes = bytes.length;
      entry.screenshot_sha256 = sha256(bytes);
    } catch (error) {
      entry.ok = false;
      entry.screenshot_error = firstLine(error);
    }

    pages.push(entry);
    const verdict = entry.ok ? 'ok  ' : 'FAIL';
    const detail = entry.ok ? entry.status : `${entry.status ?? '-'} ${entry.error ?? ''}`;
    console.log(`${verdict} ${name} ${detail}`);
    return entry.markers ?? {};
  }

  const home = await snap({
    name: 'home',
    url: `${base}/`,
    check: async (surface) => {
      await wait(surface, surface.locator('h1'), 'the landing heading', 15000);
      const input = surface.getByLabel(/想要|需要|Tell me|What are you looking for/i);
      await wait(surface, input, 'the landing search input', 15000);
      const rails = await surface.locator('section[aria-labelledby], section h2').count();
      const heading = surface.locator('h1').first();
      return {
        heading: (await heading.innerText()).trim(),
        // The computed size is recorded because the first pack had a heading that was present,
        // "visible", and 16px: Tailwind had never scanned `app/`, so the hero's own classes
        // (`text-4xl sm:text-5xl lg:text-6xl`) were absent from the build.
        heading_font_px: Number.parseFloat(await heading.evaluate((el) => getComputedStyle(el).fontSize)),
        search_input: true,
        sections: rails,
      };
    },
  });

  const search = await snap({
    name: 'search',
    url: `${base}/search?q=${encodeURIComponent(query)}`,
    check: async (surface) => {
      const cards = surface.locator('article[data-card-type]');
      await wait(surface, cards, 'the first result card', 25000);
      // `done` is the only event that prints the run meta; waiting for it proves the stream ended.
      await wait(surface, surface.getByText(/运行编号|run [0-9a-f]{8}-/i), 'the stream run id', 20000);
      const body = await surface.locator('body').innerText();
      const href = await cards.first().locator('a[href^="/m/"]').first().getAttribute('href');
      return {
        heading: (await surface.locator('h1').first().innerText()).trim(),
        cards: await cards.count(),
        summary: /来源事实|source facts/i.test(body),
        model_free_notice: /模型暂不可用|model is unavailable/i.test(body),
        fallback_notice: /流式搜索失败|Streaming failed/i.test(body),
        first_merchant: href,
      };
    },
  });

  const merchantPath = search.first_merchant;
  if (typeof merchantPath !== 'string' || !merchantPath.startsWith('/m/')) {
    throw new Error(`the search returned no merchant link (got ${JSON.stringify(merchantPath)})`);
  }

  await snap({
    name: 'merchant',
    url: `${base}${merchantPath}`,
    check: async (surface) => {
      const reviews = surface.locator('section[aria-labelledby="reviews-title"]');
      await wait(surface, reviews, 'the reviews section', 20000);
      await wait(surface, reviews.locator('li'), 'a review row', 10000);
      const body = await surface.locator('body').innerText();
      return {
        heading: (await surface.locator('h1').first().innerText()).trim(),
        slug: merchantPath,
        reviews: await reviews.locator('li').count(),
        opening_state: /Open|营业|開館|營業/i.test(body),
      };
    },
  });

  await snap({
    name: 'merchant-console',
    url: `${base}/merchant`,
    check: async (surface) => {
      await wait(surface, surface.getByText(/需要登录后查看|Sign-in required/i), 'the merchant sign-in gate', 15000);
      return { gate: 'sign-in-required' };
    },
  });

  await snap({
    name: 'admin-console',
    url: `${base}/admin`,
    check: async (surface) => {
      await wait(surface, surface.getByText(/身份认证之后|sits behind identity/i), 'the admin sign-in gate', 15000);
      return { gate: 'sign-in-required' };
    },
  });

  const manifest = {
    captured_at: new Date().toISOString(),
    base_url: base,
    viewport: VIEWPORT,
    locale: LOCALE,
    full_page: true,
    browser: { name: 'chromium', version: browser.version() },
    ok: pages.every((entry) => entry.ok),
    pages,
    notes: [
      'Screenshots and this manifest are gitignored; only tests/evidence/.gitkeep is tracked.',
      '/merchant and /admin render their sign-in gates: there is no login page yet, so the pack records the gate, not business data.',
      'done.degraded is answer provenance (a model-free answer), not a transport failure; the search page labels the two separately.',
    ],
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await context.close();
  await browser.close();

  const failed = pages.filter((entry) => !entry.ok);
  console.log(`\n${pages.length - failed.length}/${pages.length} surfaces captured · manifest ${path.join(outDir, 'manifest.json')}`);
  if (failed.length) {
    console.log(`failed: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(firstLine(error));
  process.exitCode = 1;
});
