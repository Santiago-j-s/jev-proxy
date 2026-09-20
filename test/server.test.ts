import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/config.js";
import { startProxy } from "../src/server.js";
import { ExchangeStore } from "../src/store.js";

test("forwards a Jev request and captures its full exchange without credentials", async () => {
  let upstreamAuthorization: string | undefined;
  let upstreamLocalHeader: string | undefined;
  let upstreamBody = "";
  const upstream = createServer(async (request, response) => {
    upstreamAuthorization = request.headers.authorization;
    const localHeader = request.headers["x-jev-app"];
    upstreamLocalHeader = Array.isArray(localHeader) ? localHeader.join(", ") : localHeader;
    for await (const chunk of request) {
      upstreamBody += chunk.toString();
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("x-typesafe-request-id", "req_test");
    response.end(JSON.stringify({
      model: "jev-1.13.0",
      answers: { relevant: { type: "noul", noul: 0.91 } },
      usage: { input_tokens: 250, output_tokens: 20 },
    }));
  });
  await listen(upstream);
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("Missing upstream address");

  const directory = await mkdtemp(join(tmpdir(), "jev-proxy-server-"));
  const databasePath = join(directory, "capture.sqlite");
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    databasePath,
    upstreamBaseUrl: new URL(`http://127.0.0.1:${address.port}`),
    apiKey: "upstream-secret",
  };
  const proxy = await startProxy(config);

  const playground = await fetch(new URL("/playground", proxy.url));
  assert.equal(playground.status, 200);
  assert.match(await playground.text(), /POST \/v1\/systemone/);

  const playgroundScript = await fetch(new URL("/playground.js", proxy.url));
  assert.equal(playgroundScript.status, 200);
  const playgroundSource = await playgroundScript.text();
  assert.match(playgroundSource, /x-jev-app/);
  assert.match(playgroundSource, /headers\.authorization/);
  assert.match(playgroundSource, /state:\s*\{/);
  assert.doesNotMatch(playgroundSource, /subject:\s*/);

  const requestBody = JSON.stringify({
    state: "private state",
    model: "jev-latest",
    questions: { relevant: { type: "noul", instructions: "Is it relevant?" } },
  });
  const response = await fetch(new URL("/v1/systemone", proxy.url), {
    method: "POST",
    headers: {
      authorization: "Bearer caller-secret",
      "content-type": "application/json",
      "x-jev-app": "server-test",
      "x-jev-tags": "dataset=gold",
    },
    body: requestBody,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "jev-1.13.0");
  assert.equal(upstreamAuthorization, "Bearer upstream-secret");
  assert.equal(upstreamLocalHeader, undefined);
  assert.equal(upstreamBody, requestBody);

  await proxy.close();
  await new Promise<void>((resolve, reject) => upstream.close((error) => error === undefined ? resolve() : reject(error)));

  const store = new ExchangeStore(databasePath);
  const [exchange] = store.listExchanges();
  assert.equal(exchange?.requestedModel, "jev-latest");
  assert.equal(exchange?.resolvedModel, "jev-1.13.0");
  assert.equal(exchange?.costNanoUsd, 10_500);
  assert.deepEqual(exchange?.dimensions, { app: "server-test", "tag.dataset": "gold" });

  const exported = JSON.stringify(store.exportExchanges());
  assert.equal(exported.includes("upstream-secret"), false);
  assert.equal(exported.includes("caller-secret"), false);
  assert.equal(exported.includes("private state"), true);
  store.close();
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
