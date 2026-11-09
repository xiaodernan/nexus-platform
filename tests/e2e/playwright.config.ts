import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = process.env.NEXUS_WEB_URL ?? 'http://127.0.0.1:3000';
const EVIDENCE = path.resolve(here, '..', 'evidence');

/**
 * NEXUS browser test suite.
 *
 * The stack must already be running. `make e2e` exports the three URLs this harness and `lib/fixture.ts`
 * read, pointing them at the ports `make dev-web`, `make dev-ai` and `make dev-platform` boot on; run the
 * suite by hand against another plane and export them yourself. The fallbacks below are the framework
 * defaults, which is the plane CI builds its own stack on. There is no autostart in this file.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: path.join(here, '.artifacts', 'test-results'),
  fullyParallel: true,
  /**
   * The suite runs against a live stack — the platform on 8090, the AI on 8010, the web on 3002 —
   * and the harness's own servers are dev servers, where the first request for a route compiles
   * it. Playwright's 30s default is the framework's budget, not this project's: a cold compile on
   * this machine measured 16-32s for one route, which is a latency of the harness and not a
   * verdict on the product. 60s is the smallest budget that leaves the assertions, and not the
   * tooling, deciding what is red.
   */
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The suite runs against ONE Next.js server and one FastAPI process; it does not scale out. The
  // framework default (`undefined` = half the host's cores) put 6+ browser contexts on a single prod
  // build and the SSE streams each context waits on timed out together — the failing set was
  // whichever slice happened to get through. Serialised, every spec passed in 15.8s. Local default
  // sits at 2 workers; CI keeps its measured 3. The 12-core laptop and the 2-vCPU runner differ in
  // exactly the way that made the framework default wrong in both directions.
  workers: process.env.CI ? 3 : 2,
  reporter: [['list'], ['html', { outputFolder: path.join(here, 'report'), open: 'never' }]],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'zh-HK',
    timezoneId: 'Asia/Hong_Kong',
    geolocation: { latitude: 22.3809, longitude: 114.1861 }, // Sha Tin — spec §112 cold-start geography
    permissions: ['geolocation'],
  },
  projects: [
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'visual',
      testDir: './specs/visual',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'api', testDir: './specs/api', use: {} },
  ],
});

export { EVIDENCE, WEB };
