/**
 * Regression test for the client escape hatch that every live read funnels through.
 *
 * `nexusGet` used to pin `method:'GET'` last, so a caller that passed `{ method:'POST', body }` —
 * which `lib/data`'s live AI reads (search/compare) and the AI-search BFF route all do — produced a
 * GET-with-body request that undici rejects ("Request with GET/HEAD method cannot have body"),
 * surfacing a real, reachable service as `upstream_unreachable`. This locks that GET is only the
 * DEFAULT and an explicit verb is honoured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nexusAuthedGet, nexusGet, nexusFetch } from '@/lib/api/base';

/**
 * The ambient request jar. `nexusAuthedGet` reads it only when the caller passes no explicit
 * header — the console gate derives its own header and that one must win.
 */
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'nexus_session'
        ? { value: 'sess-ambient' }
        : name === 'nexus_csrf'
          ? { value: 'csrf-ambient' }
          : undefined,
  }),
}));

const fetchMock = vi.fn();

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function firstCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0] ?? [];
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

describe('nexusGet — GET is the default, never a forced override', () => {
  it('defaults to GET when no method is passed', async () => {
    await nexusGet('platform', '/api/v1/merchants');
    expect(firstCall().init.method).toBe('GET');
  });

  it('honours an explicit POST with a body instead of pinning GET', async () => {
    await nexusGet('ai', '/ai/v1/search', { method: 'POST', body: { query: 'x', limit: 3 } });
    const { url, init } = firstCall();
    expect(url).toContain('/ai/v1/search');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ query: 'x', limit: 3 }));
  });
});

describe('nexusFetch — the raw seam still returns the parsed body + demo flag', () => {
  it('resolves data and request id for a POST', async () => {
    const { data, requestId } = await nexusFetch<{ items: unknown[] }>('ai', '/ai/v1/compare', {
      method: 'POST',
      body: { subject_ids: ['a', 'b'] },
    });
    expect(Array.isArray(data.items)).toBe(true);
    expect(requestId).toBe('req-1');
  });
});

describe('nexusAuthedGet — the console session rides the platform read', () => {
  it('an explicit cookie header wins over the ambient request jar', async () => {
    await nexusAuthedGet('platform', '/api/v1/me', {
      cookieHeader: 'nexus_session=sess-explicit; nexus_csrf=csrf-explicit',
    });
    const headers = firstCall().init.headers as Record<string, string>;
    expect(headers.cookie).toBe('nexus_session=sess-explicit; nexus_csrf=csrf-explicit');
  });

  it('falls back to the request jar when the caller passes no header', async () => {
    await nexusAuthedGet('platform', '/api/v1/me');
    const headers = firstCall().init.headers as Record<string, string>;
    expect(headers.cookie).toBe('nexus_session=sess-ambient; nexus_csrf=csrf-ambient');
  });

  it('never attaches the session to the AI target', async () => {
    await nexusAuthedGet('ai', '/ai/v1/search');
    const headers = firstCall().init.headers as Record<string, string>;
    expect(headers.cookie).toBeUndefined();
  });
});
