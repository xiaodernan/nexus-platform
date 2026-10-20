/**
 * Regression test for the discovery path's §105 deterministic search fallback.
 *
 * The live branch of `POST /api/nexus/ai/search` must forward the exact strict body
 * `SearchRequest` accepts (`query, geo, limit, locale`) — the AI service model is `extra="forbid"`
 * and rejects any `context` wrapper with a 422. This asserts the BFF sends no invented envelope key
 * and, in live mode, never backfills the answer from fixtures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nexusGet = vi.fn();

vi.mock('@/lib/api/base', () => ({
  nexusGet: (...args: unknown[]) => nexusGet(...args),
}));

// Force LIVE mode for the module under test (IS_MOCK is a module-level const in env.ts).
vi.mock('@/lib/env', () => ({
  DEFAULT_GEO: [22.2817, 114.1585],
  IS_MOCK: false,
}));

// The mock branch must not be reachable in live mode; stub it to fail loudly if it is.
vi.mock('@/lib/data', () => ({
  runSearch: () => Promise.reject(new Error('runSearch must not be used in live mode')),
}));

import { POST } from '../../app/api/nexus/ai/search/route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/nexus/ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  nexusGet.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/nexus/ai/search — live fallback shape', () => {
  it('forwards only the strict SearchRequest fields, never a context wrapper', async () => {
    nexusGet.mockResolvedValue({ items: [{ id: 'm1', slug: 'alder-kitchen-0253' }], degraded: false });

    const response = await POST(
      request({ query: '龍苑', geo: { lat: 22.3809, lng: 114.1861 }, locale: 'zh-HK', limit: 5 }),
    );

    expect(response.status).toBe(200);
    expect(nexusGet).toHaveBeenCalledTimes(1);
    const [target, path, options] = nexusGet.mock.calls[0] ?? [];
    expect(target).toBe('ai');
    expect(path).toBe('/ai/v1/search');
    expect(options.method).toBe('POST');
    expect(options.body).toEqual({
      query: '龍苑',
      geo: { lat: 22.3809, lng: 114.1861 },
      limit: 5,
      locale: 'zh-HK',
    });
    expect(options.body).not.toHaveProperty('context');

    const payload = await response.json();
    expect(payload.mocked).toBe(false);
    expect(payload.items[0].slug).toBe('alder-kitchen-0253');
  });

  it('does not invent a result set: an empty live answer is returned empty', async () => {
    nexusGet.mockResolvedValue({ items: [], degraded: false });
    const response = await POST(request({ query: 'zzzz-not-a-merchant' }));
    const payload = await response.json();
    expect(payload.items).toEqual([]);
    expect(payload.mocked).toBe(false);
  });
});
