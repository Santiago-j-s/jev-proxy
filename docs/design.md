# Design

## Purpose

Jev Proxy makes local TypeSafe Jev work inspectable. It is a debugging instrument, not a production billing gateway or a multi-tenant service. That distinction lets it optimize for complete evidence and simple local operation while keeping credentials out of storage.

The proxy is the capture boundary. An SDK logger could observe one language or one call site, but a compatible HTTP endpoint observes JavaScript, Python, cURL, and any future client in the same way.

## The central record

One inbound `POST /v1/systemone` request creates one immutable exchange. The exchange owns:

- the complete request body;
- the complete response body or network failure;
- requested and resolved model identities;
- timing and upstream request identity;
- token usage and the pricing rule applied at capture time;
- caller-supplied dimensions.

An exchange is first inserted as `pending`, before network work starts. It transitions once to `success`, `upstream_error`, or `network_error`. This makes interrupted work visible without representing failures as partially successful records.

## Request flow

```text
local caller
  -> POST /v1/systemone
      -> read body, but do not reinterpret it
      -> append pending exchange to SQLite
      -> remove local dimension headers
      -> add configured upstream credential, if present
      -> forward unchanged body to TypeSafe
      -> buffer upstream response
      -> parse model and usage for derived metadata
      -> complete exchange
      -> return upstream status, headers, and body
```

The proxy parses request and response JSON only to derive observable metadata. The original UTF-8 body is the stored source of truth and the bytes forwarded upstream are the bytes received from the caller.

Other `/v1/*` routes, such as `GET /v1/models`, pass through but are not exchange records because they are not Jev judgments and have no usage or cost.

## Authentication

The proxy chooses an upstream credential in this order:

1. `TYPESAFE_API_KEY` on the proxy process;
2. the incoming `Authorization` header.

Neither source is persisted or exposed in dashboard APIs. A configured key is required for replay because a stored exchange deliberately cannot recover the original credential.

## Failure policy

Capture is fail-open. If SQLite cannot begin or complete a record, the proxy emits a structured diagnostic to stderr but preserves the upstream exchange for the caller. Observability must not become a hidden availability dependency during development.

An upstream network failure is different: it is recorded and then returned through the caller's normal HTTP client failure path. Jev validation, authentication, rate-limit, and overload responses are `upstream_error` exchanges with their complete response body.

## Retry semantics

Each HTTP request received by the proxy is one exchange. Official SDK retries therefore appear as separate exchanges. The proxy does not group requests by body similarity because that would turn an inference into recorded fact.

Callers that need logical-call grouping can supply a stable value through `X-Jev-Run` or `X-Jev-Tags`. A future client helper may add a dedicated call identifier without changing the raw exchange model.

## Replay

Replay sends the stored request body as a new Jev call. The new exchange contains a `replay_of` dimension pointing to the source exchange. The original remains immutable.

Replay requires `TYPESAFE_API_KEY` on the running proxy. It never stores or reconstructs a historical credential.

## Security boundary

The application stores cleartext model inputs and outputs. Its security model is deliberately narrow:

- bind only to `127.0.0.1`, `localhost`, or `::1`;
- reject configuration that exposes the server on a network interface;
- never store headers;
- strip attribution headers before forwarding;
- create the database directory with user-only permissions;
- make retention and deletion explicit to the user.

Exchange payloads are retained for seven days from their start time. Cleanup runs when the store opens and during normal reads and writes, so the same retention boundary applies to the dashboard, CLI, exports, and persisted rows. Deleting an exchange cascades to its dimensions.

This is suitable for personal local debugging. Sharing, team access, or remote deployment requires a new design that introduces authentication, payload redaction, encryption, retention limits, and auditable access control.

## Dashboard direction

The dashboard is a local signal desk: part lab notebook, part packet inspector. Its visual signature is the capture rail on each exchange rather than a generic analytics chart. The page uses a cool mineral palette, editorial display type for orientation, and monospace utility type for evidence.

The interface has one job: move quickly from aggregate behavior to the exact request and answer. It therefore consists of a usage strip, a chronological stream, and a persistent payload inspector.

## Deliberate limits in the first version

- no payload redaction;
- no distributed or multi-user deployment;
- no request-body search;
- no inferred grouping of retries;
- no pricing fetched dynamically from documentation;
- no streaming upstream endpoints.

These are boundaries, not hidden assumptions. Each would change ownership or security semantics and should be designed explicitly when needed.
