import assert from "node:assert/strict";
import { test } from "node:test";

import { parseJson, readRequestFacts, readResponseFacts } from "../src/protocol.js";

test("reads request facts without changing the source representation", () => {
  const body = parseJson(JSON.stringify({
    model: "jev-latest",
    state: "hello",
    questions: {
      relevant: { type: "noul", instructions: "Is this relevant?" },
      tone: { type: "choice", instructions: "What tone?", criteria: { calm: null } },
    },
  }));

  assert.deepEqual(readRequestFacts(body), {
    model: "jev-latest",
    questionCount: 2,
  });
});

test("accepts usage only when both token counts are non-negative integers", () => {
  const valid = parseJson('{"model":"jev-1.13.0","usage":{"input_tokens":296,"output_tokens":20}}');
  assert.deepEqual(readResponseFacts(valid), {
    model: "jev-1.13.0",
    usage: { inputTokens: 296, outputTokens: 20 },
  });

  const invalid = parseJson('{"model":"jev-1.13.0","usage":{"input_tokens":-1,"output_tokens":20}}');
  assert.deepEqual(readResponseFacts(invalid), {
    model: "jev-1.13.0",
    usage: null,
  });
});

test("invalid JSON produces no inferred facts", () => {
  assert.equal(parseJson("not json"), null);
  assert.deepEqual(readRequestFacts(null), { model: null, questionCount: null });
});
