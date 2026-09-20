import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExchangeStore } from "../src/store.js";

test("stores a complete exchange and exact dimensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-proxy-store-"));
  const databasePath = join(directory, "capture.sqlite");
  const store = new ExchangeStore(
    databasePath,
    () => new Date("2026-09-20T12:00:00.000Z"),
  );
  const id = "exchange-1";

  store.beginExchange({
    id,
    startedAt: "2026-09-20T10:00:00.000Z",
    method: "POST",
    path: "/v1/systemone",
    requestedModel: "jev-latest",
    questionCount: 1,
    requestBody: '{"state":"secret input"}',
    dimensions: { app: "test-suite", "tag.dataset": "gold" },
  });
  store.completeExchange(id, {
    outcome: "success",
    finishedAt: "2026-09-20T10:00:00.120Z",
    durationMs: 120,
    httpStatus: 200,
    resolvedModel: "jev-1.13.0",
    responseBody: '{"answers":{}}',
    upstreamRequestId: "req_upstream",
    usage: { inputTokens: 300, outputTokens: 20 },
    cost: {
      status: "calculated",
      billableInputTokens: 300,
      nanoUsd: 12_600,
      pricingRuleId: "jev-1.13.0@2026-09",
    },
  });

  const exchange = store.getExchange(id);
  assert.equal(exchange?.outcome, "success");
  assert.equal(exchange?.costNanoUsd, 12_600);
  assert.deepEqual(exchange?.dimensions, { app: "test-suite", "tag.dataset": "gold" });
  assert.deepEqual(store.summarize(), {
    exchangeCount: 1,
    successCount: 1,
    errorCount: 0,
    inputTokens: 300,
    outputTokens: 20,
    costNanoUsd: 12_600,
    unknownCostCount: 0,
    averageDurationMs: 120,
  });
  store.close();

  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
});

test("an empty store has a zero summary", () => {
  const store = new ExchangeStore(":memory:");
  assert.deepEqual(store.summarize(), {
    exchangeCount: 0,
    successCount: 0,
    errorCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costNanoUsd: 0,
    unknownCostCount: 0,
    averageDurationMs: null,
  });
  store.close();
});

test("retains only exchanges from the last seven days", () => {
  let now = new Date("2026-09-20T12:00:00.000Z");
  const store = new ExchangeStore(":memory:", () => now);

  store.beginExchange({
    id: "boundary",
    startedAt: "2026-09-13T12:00:00.000Z",
    method: "POST",
    path: "/v1/systemone",
    requestedModel: "jev-1.13.0",
    questionCount: 1,
    requestBody: "{}",
    dimensions: { app: "retention-test" },
  });
  assert.equal(store.listExchanges().length, 1);

  now = new Date("2026-09-20T12:00:00.001Z");
  assert.deepEqual(store.listExchanges(), []);
  assert.equal(store.getExchange("boundary"), null);
  store.close();
});
