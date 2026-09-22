import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { Config } from "./config.js";
import type { JsonValue } from "./domain.js";
import { calculateCost } from "./pricing.js";
import { parseJson, readRequestFacts, readResponseFacts } from "./protocol.js";
import { ExchangeStore } from "./store.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const PUBLIC_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../public");
const PRIVATE_DIMENSION_HEADERS = new Set([
  "x-jev-app",
  "x-jev-feature",
  "x-jev-run",
  "x-jev-tags",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type RunningProxy = {
  readonly server: Server;
  readonly url: URL;
  close(): Promise<void>;
};

export async function startProxy(config: Config): Promise<RunningProxy> {
  const store = new ExchangeStore(config.databasePath);
  const server = createServer((request, response) => {
    routeRequest({ request, response, config, store }).catch((error: unknown) => {
      logDiagnostic("request_handler_failed", error);
      if (!response.headersSent) {
        writeJson(response, 500, { error: "The local proxy could not handle this request" });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Proxy did not receive a TCP address");
  }

  const url = new URL(`http://${formatHost(config.host)}:${address.port}`);
  return {
    server,
    url,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      store.close();
    },
  };
}

type RouteContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: Config;
  readonly store: ExchangeStore;
};

async function routeRequest(context: RouteContext): Promise<void> {
  const { request, response, store } = context;
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/summary") {
    writeJson(response, 200, store.summarize());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/exchanges") {
    const limit = readLimit(url.searchParams.get("limit"));
    const offset = readOffset(url.searchParams.get("offset"));
    writeJson(response, 200, { exchanges: store.listExchanges(limit, offset) });
    return;
  }

  const exchangeRoute = matchExchangeRoute(url.pathname);
  if (request.method === "GET" && exchangeRoute?.action === "detail") {
    const exchange = store.getExchange(exchangeRoute.id);
    if (exchange === null) {
      writeJson(response, 404, { error: "Exchange not found" });
      return;
    }
    writeJson(response, 200, exchange);
    return;
  }

  if (request.method === "POST" && exchangeRoute?.action === "replay") {
    await replayExchange(context, exchangeRoute.id);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/systemone") {
    const body = await readRequestBody(request);
    const result = await captureSystemOne({
      config: context.config,
      store,
      body,
      incomingHeaders: request.headers,
      dimensions: readDimensions(request.headers),
    });
    writeUpstreamResponse(response, result);
    return;
  }

  if (url.pathname.startsWith("/v1/")) {
    await passthrough(context, url);
    return;
  }

  await serveDashboard(response, url.pathname);
}

type CaptureInput = {
  readonly config: Config;
  readonly store: ExchangeStore;
  readonly body: Buffer;
  readonly incomingHeaders: IncomingHttpHeaders;
  readonly dimensions: Readonly<Record<string, string>>;
};

type UpstreamResult = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Buffer;
};

async function captureSystemOne(input: CaptureInput): Promise<UpstreamResult> {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const requestText = input.body.toString("utf8");
  const requestFacts = readRequestFacts(parseJson(requestText));

  let recording = true;
  try {
    input.store.beginExchange({
      id,
      startedAt,
      method: "POST",
      path: "/v1/systemone",
      requestedModel: requestFacts.model,
      questionCount: requestFacts.questionCount,
      requestBody: requestText,
      dimensions: input.dimensions,
    });
  } catch (error) {
    recording = false;
    logDiagnostic("capture_begin_failed", error, { exchangeId: id });
  }

  const upstreamUrl = new URL("/v1/systemone", input.config.upstreamBaseUrl);
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: buildUpstreamHeaders(input.incomingHeaders, input.config.apiKey),
      body: new Uint8Array(input.body),
      signal: AbortSignal.timeout(60_000),
    });
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());

    if (recording) {
      try {
        const responseText = responseBody.toString("utf8");
        const responseFacts = readResponseFacts(parseJson(responseText));
        input.store.completeExchange(id, {
          outcome: upstreamResponse.ok ? "success" : "upstream_error",
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          httpStatus: upstreamResponse.status,
          resolvedModel: responseFacts.model,
          responseBody: responseText,
          upstreamRequestId: upstreamResponse.headers.get("x-typesafe-request-id"),
          usage: responseFacts.usage,
          cost: calculateCost(responseFacts.model, responseFacts.usage),
        });
      } catch (error) {
        logDiagnostic("capture_completion_failed", error, { exchangeId: id });
      }
    }

    return {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
      body: responseBody,
    };
  } catch (error) {
    if (recording) {
      try {
        input.store.completeExchange(id, {
          outcome: "network_error",
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch (storageError) {
        logDiagnostic("capture_completion_failed", storageError, { exchangeId: id });
      }
    }
    throw error;
  }
}

async function replayExchange(context: RouteContext, id: string): Promise<void> {
  const exchange = context.store.getExchange(id);
  if (exchange === null) {
    writeJson(context.response, 404, { error: "Exchange not found" });
    return;
  }
  if (exchange.requestBody === null) {
    writeJson(context.response, 409, { error: "This exchange has no request body to replay" });
    return;
  }
  if (context.config.apiKey === null) {
    writeJson(context.response, 409, {
      error: "Replay requires TYPESAFE_API_KEY on the proxy process",
    });
    return;
  }

  const result = await captureSystemOne({
    config: context.config,
    store: context.store,
    body: Buffer.from(exchange.requestBody),
    incomingHeaders: { "content-type": "application/json" },
    dimensions: { ...exchange.dimensions, replay_of: id },
  });
  writeUpstreamResponse(context.response, result);
}

async function passthrough(context: RouteContext, requestUrl: URL): Promise<void> {
  const method = context.request.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await readRequestBody(context.request);
  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, context.config.upstreamBaseUrl);
  const requestInit: RequestInit = {
    method,
    headers: buildUpstreamHeaders(context.request.headers, context.config.apiKey),
    signal: AbortSignal.timeout(60_000),
  };
  if (body !== undefined) {
    requestInit.body = new Uint8Array(body);
  }
  const upstreamResponse = await fetch(upstreamUrl, requestInit);
  writeUpstreamResponse(context.response, {
    status: upstreamResponse.status,
    headers: upstreamResponse.headers,
    body: Buffer.from(await upstreamResponse.arrayBuffer()),
  });
}

function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  configuredApiKey: string | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name) ||
      PRIVATE_DIMENSION_HEADERS.has(name)
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (configuredApiKey !== null) {
    headers.set("authorization", `Bearer ${configuredApiKey}`);
  }
  return headers;
}

function readDimensions(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const dimensions: Record<string, string> = {};
  copyHeaderDimension(headers, dimensions, "x-jev-app", "app");
  copyHeaderDimension(headers, dimensions, "x-jev-feature", "feature");
  copyHeaderDimension(headers, dimensions, "x-jev-run", "run");

  const tags = headers["x-jev-tags"];
  if (typeof tags === "string") {
    for (const entry of tags.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const name = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (name !== "" && value !== "") {
        dimensions[`tag.${name}`] = value;
      }
    }
  }
  return dimensions;
}

function copyHeaderDimension(
  headers: IncomingHttpHeaders,
  target: Record<string, string>,
  header: string,
  dimension: string,
): void {
  const value = headers[header];
  if (typeof value === "string" && value.trim() !== "") {
    target[dimension] = value.trim();
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeUpstreamResponse(response: ServerResponse, result: UpstreamResult): void {
  for (const [name, value] of result.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name)) {
      response.setHeader(name, value);
    }
  }
  response.writeHead(result.status);
  response.end(result.body);
}

function writeJson(response: ServerResponse, status: number, body: JsonValue | object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function serveDashboard(response: ServerResponse, pathname: string): Promise<void> {
  const relativePath = pathname === "/"
    ? "index.html"
    : pathname === "/playground"
      ? "playground.html"
      : pathname.slice(1);
  if (!new Set(["index.html", "playground.html", "app.js", "playground.js", "codemirror.js", "styles.css"]).has(relativePath)) {
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const content = await readFile(join(PUBLIC_DIRECTORY, relativePath));
    response.writeHead(200, { "content-type": contentType(relativePath) });
    response.end(content);
  } catch (error) {
    logDiagnostic("dashboard_asset_failed", error, { path: relativePath });
    writeJson(response, 500, { error: "Dashboard asset could not be read" });
  }
}

function matchExchangeRoute(
  pathname: string,
): { readonly id: string; readonly action: "detail" | "replay" } | null {
  const match = /^\/api\/exchanges\/([^/]+)(?:\/(replay))?$/.exec(pathname);
  if (match === null) {
    return null;
  }
  const encodedId = match[1];
  if (encodedId === undefined) {
    return null;
  }
  return {
    id: decodeURIComponent(encodedId),
    action: match[2] === "replay" ? "replay" : "detail",
  };
}

function readLimit(value: string | null): number {
  if (value === null) {
    return 100;
  }
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
}

function readOffset(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function logDiagnostic(
  event: string,
  error: unknown,
  context: Readonly<Record<string, string>> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ event, message, ...context })}\n`);
}
