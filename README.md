# Jev Proxy

Jev Proxy is a local observability gateway for [TypeSafe Jev](https://docs.typesafe.ai/). It records every System One request and response that passes through it, including full payloads, latency, token usage, the resolved model, and cost.

It is intentionally a personal debugging tool:

- it binds only to a loopback address;
- it stores complete payloads in cleartext on your machine;
- it never persists authorization headers or API keys;
- it returns the upstream status, headers, and body without wrapping them.

## Start capturing

Jev Proxy requires Bun 1.3.14 or later.

```bash
bun install
TYPESAFE_API_KEY=ts_... bun run start
```

The proxy and dashboard start at `http://127.0.0.1:7788`. The raw JSON playground is available at `http://127.0.0.1:7788/playground`; its requests make real TypeSafe calls and are recorded like any other exchange.

Point a Jev client at it:

```bash
TYPESAFE_BASE_URL=http://127.0.0.1:7788 your-command
```

Both official SDKs support this setting. A JavaScript client can also set it explicitly:

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({
  baseURL: "http://127.0.0.1:7788",
});
```

For Python:

```py
from typesafe_sdk import TypeSafeClient

client = TypeSafeClient(base_url="http://127.0.0.1:7788")
```

When the proxy process has `TYPESAFE_API_KEY`, it uses that key for upstream requests. Otherwise it forwards the caller's `Authorization` header. Credentials are never written to SQLite.

## Attribute calls

Optional headers add searchable context without changing the Jev payload:

```http
X-Jev-App: experiment-runner
X-Jev-Feature: contact-classification
X-Jev-Run: eval-2026-09-20
X-Jev-Tags: dataset=gold,branch=threshold-test
```

These headers stop at the proxy and are not forwarded to TypeSafe.

## Commands

```text
jev-proxy start       Start the proxy and dashboard
jev-proxy open        Open the dashboard
jev-proxy list        List the 50 most recent exchanges
jev-proxy show <id>   Print a complete exchange
jev-proxy export      Export every exchange as JSON Lines
```

During development, use `bun run dev`. To make the command available globally from this checkout, run `bun link`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | forwarded caller key | Upstream TypeSafe credential |
| `JEV_PROXY_HOST` | `127.0.0.1` | Loopback listen address |
| `JEV_PROXY_PORT` | `7788` | Local HTTP port |
| `JEV_PROXY_DATABASE` | `~/.jev-proxy/jev-proxy.sqlite` | SQLite database path |
| `JEV_PROXY_UPSTREAM_URL` | `https://api.typesafe.ai` | TypeSafe API root; useful for tests |

`JEV_PROXY_HOST` rejects non-loopback addresses because stored payloads may be sensitive.

## Payload retention

SQLite retains exchanges for seven days. Expired exchanges and their dimensions are deleted automatically when the store opens and during normal reads and writes.

Do not share an export without reviewing it. Request state, question criteria, and answers are all included by design.

## Cost calculation

The upstream response supplies token usage and the resolved model version. Jev Proxy calculates cost against that resolved version—not an alias such as `jev-latest`—and stores the pricing rule with the exchange.

Jev 1.13 currently costs `$42` per billion input tokens and has free output tokens. The corresponding rule uses exact integer arithmetic:

```text
cost in nanodollars = input tokens × 42
```

Unknown models produce an unknown cost rather than `$0`. See `docs/design.md` for the complete model.

## Verification

```bash
bun run check
bun test
```

## Documentation

- `docs/design.md` explains ownership, request flow, failures, retries, and security boundaries.
- `docs/data-model.md` documents the SQLite records and pricing semantics.
