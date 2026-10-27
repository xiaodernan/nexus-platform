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
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 3 : undefined,
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
