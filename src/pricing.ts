import type { Cost, Usage } from "./domain.js";

export type PricingRule = {
  readonly id: string;
  readonly model: string;
  readonly inputNanoUsdPerToken: number;
  readonly outputNanoUsdPerToken: number;
};

export const PRICING_RULES: readonly PricingRule[] = [
  {
    id: "jev-1.13.0@2026-09",
    model: "jev-1.13.0",
    inputNanoUsdPerToken: 42,
    outputNanoUsdPerToken: 0,
  },
];

export function calculateCost(
  resolvedModel: string | null,
  usage: Usage | null,
): Cost {
  if (usage === null) {
    return { status: "unknown", reason: "missing_usage" };
  }

  const pricingRule = PRICING_RULES.find((rule) => rule.model === resolvedModel);
  if (pricingRule === undefined) {
    return { status: "unknown", reason: "unrecognized_model" };
  }

  const nanoUsd =
    usage.inputTokens * pricingRule.inputNanoUsdPerToken +
    usage.outputTokens * pricingRule.outputNanoUsdPerToken;

  if (!Number.isSafeInteger(nanoUsd)) {
    throw new RangeError("Calculated cost exceeds JavaScript's safe integer range");
  }

  return {
    status: "calculated",
    billableInputTokens: usage.inputTokens,
    nanoUsd,
    pricingRuleId: pricingRule.id,
  };
}
