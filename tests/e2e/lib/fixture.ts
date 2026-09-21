import { test as base, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { WEB } from '../playwright.config.js';

const PLATFORM = process.env.NEXUS_PLATFORM_URL ?? 'http://127.0.0.1:8080';
const AI = process.env.NEXUS_AI_URL ?? 'http://127.0.0.1:8000';

export type NexusFixtures = {
  platform: APIRequestContext;
  ai: APIRequestContext;
  demoConsumer: Page;
};

/** Demo sessions need no registration — spec §87. */
export async function demoLogin(api: APIRequestContext, role: 'consumer' | 'merchant' | 'admin') {
  const res = await api.post(`${PLATFORM}/api/v1/auth/demo`, { data: { role } });
  if (!res.ok()) {
    throw new Error(
      `demo login (${role}) failed: ${res.status()} ${await res.text()} — ` +
        `is the platform service running on ${PLATFORM}?`,
    );
  }
  const body = await res.json();
  return body as { access_token: string; user: { id: string; role: string } };
}

export async function bearer(api: APIRequestContext, token: string) {
  return { Authorization: `Bearer ${token}`, 'X-Tenant': 'hong-kong' };
}

/**
 * Every card must carry facts for the numbers it renders (spec §19).
 * Returns the violations so a test can fail with the offending payload rather than a vague assert.
 */
export function unauditedNumbers(card: {
  price?: unknown;
  rating?: unknown;
  distance?: unknown;
  open?: unknown;
  facts?: Array<{ attribute: string }>;
}): string[] {
  const present = new Set((card.facts ?? []).map((f) => f.attribute));
  const required: Array<[keyof typeof card, string]> = [
    ['price', 'price'],
    ['rating', 'rating'],
    ['distance', 'distance'],
    ['open', 'opening_hours'],
  ];
  return required
    .filter(([key, fact]) => card[key] != null && !present.has(fact))
    .map(([key]) => `${String(key)} rendered without a backing fact`);
}

export const test = base.extend<NexusFixtures>({
  platform: async ({}, use) => {
    const ctx = await request.newContext({ baseURL: PLATFORM, extraHeaders: { 'X-Tenant': 'hong-kong' } });
    await use(ctx);
    await ctx.dispose();
  },
  ai: async ({}, use) => {
    const ctx = await request.newContext({ baseURL: AI });
    await use(ctx);
    await ctx.dispose();
  },
  demoConsumer: async ({ page }, use) => {
    const ctx = await request.newContext({ baseURL: PLATFORM });
    const { access_token } = await demoLogin(ctx, 'consumer');
    await ctx.dispose();
    await page.addInitScript(
      ([token]) => window.localStorage.setItem('nexus.dev_token', token),
      [access_token],
    );
    await use(page);
  },
});

export { expect, WEB, PLATFORM, AI };
