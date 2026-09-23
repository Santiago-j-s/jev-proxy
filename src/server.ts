import { randomUUID } from "node:crypto";

import dashboard from "../public/index.html";
import playground from "../public/playground.html";

import type { Config } from "./config.js";
import type { ExchangeFilters } from "./domain.js";
import { calculateCost } from "./pricing.js";
import { parseJson, readRequestFacts, readResponseFacts } from "./protocol.js";
import { ExchangeStore } from "./store.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
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
  readonly server: Bun.Server<undefined>;
  readonly url: URL;
  close(): Promise<void>;
};

export async function startProxy(config: Config): Promise<RunningProxy> {
  const store = new ExchangeStore(config.databasePath);
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: config.host,
      port: config.port,
      development: process.env.NODE_ENV === "development",
      routes: { "/": dashboard, "/playground": playground },
      fetch(request) {
        return routeRequest({ request, config, store }).catch((error: unknown) => {
          logDiagnostic("request_handler_failed", error);
          return Response.json({ error: "The local proxy could not handle this request" }, { status: 500 });
        });
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }

  return {
    server,
    url: server.url,
    async close() {
      await server.stop();
      store.close();
    },
  };
}

type RouteContext = {
  readonly request: Request;
  readonly config: Config;
  readonly store: ExchangeStore;
};

async function routeRequest(context: RouteContext): Promise<Response> {
  const { request, store } = context;
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return Response.json({ status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/api/summary") {
    return Response.json(store.summarize(readExchangeFilters(url.searchParams)));
  }

  if (request.method === "GET" && url.pathname === "/api/filters") {
    return Response.json(store.listFilterValues());
  }

  if (request.method === "GET" && url.pathname === "/api/exchanges") {
    const limit = readLimit(url.searchParams.get("limit"));
    const offset = readOffset(url.searchParams.get("offset"));
    return Response.json({ exchanges: store.listExchanges(limit, offset, readExchangeFilters(url.searchParams)) });
  }

  const exchangeRoute = matchExchangeRoute(url.pathname);
  if (request.method === "GET" && exchangeRoute?.action === "detail") {
    const exchange = store.getExchange(exchangeRoute.id);
    if (exchange === null) {
      return Response.json({ error: "Exchange not found" }, { status: 404 });
    }
    return Response.json(exchange);
  }

  if (request.method === "POST" && exchangeRoute?.action === "replay") {
    return replayExchange(context, exchangeRoute.id);
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
    return upstreamResponse(result);
  }

  if (url.pathname.startsWith("/v1/")) {
    return passthrough(context, url);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

type CaptureInput = {
  readonly config: Config;
  readonly store: ExchangeStore;
  readonly body: Buffer;
  readonly incomingHeaders: Headers;
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

async function replayExchange(context: RouteContext, id: string): Promise<Response> {
  const exchange = context.store.getExchange(id);
  if (exchange === null) {
    return Response.json({ error: "Exchange not found" }, { status: 404 });
  }
  if (exchange.requestBody === null) {
    return Response.json({ error: "This exchange has no request body to replay" }, { status: 409 });
  }
  if (context.config.apiKey === null) {
    return Response.json({
      error: "Replay requires TYPESAFE_API_KEY on the proxy process",
    }, { status: 409 });
  }

  const result = await captureSystemOne({
    config: context.config,
    store: context.store,
    body: Buffer.from(exchange.requestBody),
    incomingHeaders: new Headers({ "content-type": "application/json" }),
    dimensions: { ...exchange.dimensions, replay_of: id },
  });
  return upstreamResponse(result);
}

async function passthrough(context: RouteContext, requestUrl: URL): Promise<Response> {
  const method = context.request.method;
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
  const response = await fetch(upstreamUrl, requestInit);
  return upstreamResponse({
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer()),
  }, method === "HEAD");
}

function buildUpstreamHeaders(
  incoming: Headers,
  configuredApiKey: string | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      PRIVATE_DIMENSION_HEADERS.has(name)
    ) {
      continue;
    }
    headers.set(name, value);
  }
  if (configuredApiKey !== null) {
    headers.set("authorization", `Bearer ${configuredApiKey}`);
  }
  return headers;
}

function readDimensions(headers: Headers): Readonly<Record<string, string>> {
  const dimensions: Record<string, string> = {};
  for (const [header, dimension] of [
    ["x-jev-app", "app"],
    ["x-jev-feature", "feature"],
    ["x-jev-run", "run"],
  ] as const) {
    const value = headers.get(header)?.trim();
    if (value) dimensions[dimension] = value;
  }

  const tags = headers.get("x-jev-tags");
  if (tags !== null) {
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

async function readRequestBody(request: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = request.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      void reader.cancel();
      throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function upstreamResponse(result: UpstreamResult, headRequest = false): Response {
  const headers = new Headers();
  for (const [name, value] of result.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name)) {
      headers.set(name, value);
    }
  }
  const body = headRequest || result.status === 204 || result.status === 205 || result.status === 304
    ? null
    : new Uint8Array(result.body);
  return new Response(body, { status: result.status, headers });
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

function readExchangeFilters(parameters: URLSearchParams): ExchangeFilters {
  return {
    app: parameters.get("app")?.trim() || null,
    feature: parameters.get("feature")?.trim() || null,
  };
}

function readOffset(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function logDiagnostic(
  event: string,
  error: unknown,
  context: Readonly<Record<string, string>> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ event, message, ...context })}\n`);
}
