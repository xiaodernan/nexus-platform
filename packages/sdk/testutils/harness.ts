/**
 * Test harness: start the fake API, hand the test a factory for clients pointed
 * at it with fast retry/timeout, and always close the server.
 */
import { createClient, type CreateClientOptions, type NexusClient } from "../src/index.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

export interface WithApiResult {
  api: FakeApi;
  make: (overrides?: Partial<CreateClientOptions>) => NexusClient;
}

export async function withApi(run: (ctx: WithApiResult) => Promise<void>): Promise<void> {
  const api = await startFakeApi();
  try {
    const make = (overrides: Partial<CreateClientOptions> = {}): NexusClient =>
      createClient({
        baseUrl: api.baseUrl,
        tenant: "hong-kong",
        locale: "zh-HK",
        retries: 2,
        backoffBaseMs: 1,
        backoffCapMs: 8,
        timeoutMs: 2000,
        ...overrides,
      });
    await run({ api, make });
  } finally {
    await api.close();
  }
}
