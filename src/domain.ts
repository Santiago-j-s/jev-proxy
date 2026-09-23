export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type ExchangeOutcome =
  | "pending"
  | "success"
  | "upstream_error"
  | "network_error";

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type ExchangeFilters = {
  readonly app: string | null;
  readonly feature: string | null;
};

export type CalculatedCost = {
  readonly status: "calculated";
  readonly billableInputTokens: number;
  readonly nanoUsd: number;
  readonly pricingRuleId: string;
};

export type UnknownCost = {
  readonly status: "unknown";
  readonly reason: "unrecognized_model" | "missing_usage";
};

export type Cost = CalculatedCost | UnknownCost;

export type NewExchange = {
  readonly id: string;
  readonly startedAt: string;
  readonly method: string;
  readonly path: string;
  readonly requestedModel: string | null;
  readonly questionCount: number | null;
  readonly requestBody: string | null;
  readonly dimensions: Readonly<Record<string, string>>;
};

export type ExchangeCompletion =
  | {
      readonly outcome: "success" | "upstream_error";
      readonly finishedAt: string;
      readonly durationMs: number;
      readonly httpStatus: number;
      readonly resolvedModel: string | null;
      readonly responseBody: string;
      readonly upstreamRequestId: string | null;
      readonly usage: Usage | null;
      readonly cost: Cost;
    }
  | {
      readonly outcome: "network_error";
      readonly finishedAt: string;
      readonly durationMs: number;
      readonly errorMessage: string;
    };

export type ExchangeListItem = {
  readonly id: string;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly outcome: ExchangeOutcome;
  readonly httpStatus: number | null;
  readonly requestedModel: string | null;
  readonly resolvedModel: string | null;
  readonly questionCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costNanoUsd: number | null;
  readonly dimensions: Readonly<Record<string, string>>;
};

export type ExchangeDetail = ExchangeListItem & {
  readonly finishedAt: string | null;
  readonly method: string;
  readonly path: string;
  readonly requestBody: string | null;
  readonly responseBody: string | null;
  readonly errorMessage: string | null;
  readonly pricingRuleId: string | null;
  readonly costStatus: "calculated" | "unknown" | null;
  readonly costUnknownReason: string | null;
  readonly upstreamRequestId: string | null;
};

export type UsageSummary = {
  readonly exchangeCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly unknownCostCount: number;
  readonly averageDurationMs: number | null;
};
