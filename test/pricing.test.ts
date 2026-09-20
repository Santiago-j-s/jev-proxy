import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateCost } from "../src/pricing.js";

test("calculates Jev 1.13 cost with integer nanodollars", () => {
  assert.deepEqual(
    calculateCost("jev-1.13.0", { inputTokens: 1_000_000, outputTokens: 50_000 }),
    {
      status: "calculated",
      billableInputTokens: 1_000_000,
      nanoUsd: 42_000_000,
      pricingRuleId: "jev-1.13.0@2026-09",
    },
  );
});

test("does not treat an unknown model as free", () => {
  assert.deepEqual(
    calculateCost("jev-2.0.0", { inputTokens: 100, outputTokens: 10 }),
    { status: "unknown", reason: "unrecognized_model" },
  );
});

test("distinguishes missing usage from unknown pricing", () => {
  assert.deepEqual(
    calculateCost("jev-1.13.0", null),
    { status: "unknown", reason: "missing_usage" },
  );
});
