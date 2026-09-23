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
  let upstreamPath: string | undefined;
  let upstreamBody = "";
  const upstream = createServer(async (request, response) => {
    upstreamPath = request.url;
    upstreamAuthorization = request.headers.authorization;
    const localHeader = request.headers["x-jev-app"];
    upstreamLocalHeader = Array.isArray(localHeader) ? localHeader.join(", ") : localHeader;
    for await (const chunk of request) {
      upstreamBody += chunk.toString();
    }
    if (request.url === "/v1/empty") {
      response.writeHead(204, { "x-upstream-result": "empty" });
      response.end();
      return;
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
  const playgroundHtml = await playground.text();
  assert.match(playgroundHtml, /POST \/v1\/systemone/);

  const scriptPath = /<script type="module"[^>]*src="([^"]+)"/.exec(playgroundHtml)?.[1];
  assert.ok(scriptPath);
  const playgroundScript = await fetch(new URL(scriptPath, proxy.url));
  assert.equal(playgroundScript.status, 200);
  assert.match(playgroundScript.headers.get("content-type") ?? "", /javascript/);
  const playgroundSource = await playgroundScript.text();
  assert.match(playgroundSource, /x-jev-app/);
  assert.match(playgroundSource, /jev-1\.13\.0/);
  assert.match(playgroundSource, /Fix the JSON before sending/);

  const stylesheetPath = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(playgroundHtml)?.[1];
  assert.ok(stylesheetPath);
  const stylesheet = await fetch(new URL(stylesheetPath, proxy.url));
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /css/);

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

  const passthrough = await fetch(new URL("/v1/models?demo=1", proxy.url), {
    headers: { authorization: "Bearer caller-secret", "x-jev-app": "passthrough" },
  });
  assert.equal(passthrough.status, 200);
  assert.equal(upstreamPath, "/v1/models?demo=1");
  assert.equal(upstreamAuthorization, "Bearer upstream-secret");
  assert.equal(upstreamLocalHeader, undefined);

  const empty = await fetch(new URL("/v1/empty", proxy.url));
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get("x-upstream-result"), "empty");

  const head = await fetch(new URL("/v1/models", proxy.url), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const exchangesResponse = await fetch(new URL("/api/exchanges", proxy.url));
  const listing = await exchangesResponse.json();
  const originalId = listing.exchanges[0].id;
  const replay = await fetch(new URL(`/api/exchanges/${originalId}/replay`, proxy.url), { method: "POST" });
  assert.equal(replay.status, 200);
  assert.equal(upstreamPath, "/v1/systemone");

  await proxy.close();
  await new Promise<void>((resolve, reject) => upstream.close((error) => error === undefined ? resolve() : reject(error)));

  const store = new ExchangeStore(databasePath);
  const exchange = store.listExchanges().find((item) => item.id === originalId);
  assert.equal(exchange?.requestedModel, "jev-latest");
  assert.equal(exchange?.resolvedModel, "jev-1.13.0");
  assert.equal(exchange?.costNanoUsd, 10_500);
  assert.deepEqual(exchange?.dimensions, { app: "server-test", "tag.dataset": "gold" });
  assert.equal(store.listExchanges().length, 2);
  assert.ok(store.listExchanges().some((item) => item.dimensions.replay_of === originalId));

  const exported = JSON.stringify(store.exportExchanges());
  assert.equal(exported.includes("upstream-secret"), false);
  assert.equal(exported.includes("caller-secret"), false);
  assert.equal(exported.includes("private state"), true);
  store.close();
});

test("rejects oversized requests before forwarding or capturing them", async () => {
  const proxy = await startProxy({
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    upstreamBaseUrl: new URL("http://127.0.0.1:1"),
    apiKey: null,
  });
  try {
    const response = await fetch(new URL("/v1/systemone", proxy.url), {
      method: "POST",
      body: new Uint8Array(8 * 1024 * 1024 + 1),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, "The local proxy could not handle this request");

    const summary = await fetch(new URL("/api/summary", proxy.url));
    assert.equal((await summary.json()).exchangeCount, 0);
  } finally {
    await proxy.close();
  }
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
