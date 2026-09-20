import type { JsonObject, JsonValue, Usage } from "./domain.js";

export type SystemOneRequestFacts = {
  readonly model: string | null;
  readonly questionCount: number | null;
};

export type SystemOneResponseFacts = {
  readonly model: string | null;
  readonly usage: Usage | null;
};

export function parseJson(text: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parseJsonValue(parsed);
  } catch {
    return null;
  }
}

export function readRequestFacts(body: JsonValue | null): SystemOneRequestFacts {
  if (!isJsonObject(body)) {
    return { model: null, questionCount: null };
  }

  const model = typeof body.model === "string" ? body.model : null;
  const questionCount = isJsonObject(body.questions)
    ? Object.keys(body.questions).length
    : null;

  return { model, questionCount };
}

export function readResponseFacts(body: JsonValue | null): SystemOneResponseFacts {
  if (!isJsonObject(body)) {
    return { model: null, usage: null };
  }

  const model = typeof body.model === "string" ? body.model : null;
  if (!isJsonObject(body.usage)) {
    return { model, usage: null };
  }

  const inputTokens = body.usage.input_tokens;
  const outputTokens = body.usage.output_tokens;
  const usage = isNonNegativeInteger(inputTokens) && isNonNegativeInteger(outputTokens)
    ? { inputTokens, outputTokens }
    : null;

  return { model, usage };
}

function parseJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(parseJsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, parseJsonValue(entry)]),
    );
  }

  throw new TypeError("Value is not representable as JSON");
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
