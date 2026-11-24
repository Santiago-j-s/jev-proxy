import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";

test("rejects an API key that cannot be sent as a header, without echoing it", () => {
  const key = "ts_secret\nvalue";
  assert.throws(
    () => loadConfig({ TYPESAFE_API_KEY: key }),
    (error: unknown) => error instanceof Error && !error.message.includes("ts_secret"),
  );
  assert.equal(loadConfig({ TYPESAFE_API_KEY: "  ts_valid-key  " }).apiKey, "ts_valid-key");
  assert.equal(loadConfig({ TYPESAFE_API_KEY: " " }).apiKey, null);
});
