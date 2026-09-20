# Data model

The SQLite database is both the durable capture log and the source for dashboard summaries. WAL mode allows the CLI and dashboard to read while the proxy writes.

## `exchanges`

One row represents one request received at the System One boundary.

| Column | Meaning |
| --- | --- |
| `id` | Locally generated UUID |
| `started_at`, `finished_at` | UTC ISO timestamps |
| `duration_ms` | End-to-end upstream duration measured by the proxy |
| `outcome` | `pending`, `success`, `upstream_error`, or `network_error` |
| `method`, `path` | Captured HTTP operation |
| `http_status` | Upstream status when an HTTP response exists |
| `requested_model` | Model or alias in the request body |
| `resolved_model` | Versioned model in the upstream response |
| `question_count` | Number of named questions when the request is parseable |
| `request_body`, `response_body` | Complete UTF-8 bodies |
| `error_message` | Local network error when no response exists |
| `input_tokens`, `output_tokens` | Upstream-reported usage |
| `cost_status` | `calculated` or `unknown` |
| `cost_nano_usd` | Exact integer nanodollars when calculable |
| `pricing_rule_id` | Immutable rule used for this exchange |
| `cost_unknown_reason` | Why cost was not calculated |
| `upstream_request_id` | TypeSafe's `x-typesafe-request-id`, when supplied |

The original bodies remain authoritative. Metadata is a parsed projection for navigation and aggregation.

## `exchange_dimensions`

Dimensions are caller-provided labels such as app, feature, run, dataset, or branch. The `(exchange_id, name)` primary key prevents a single exchange from claiming two values for the same dimension.

Standard headers map as follows:

| Header | Dimension |
| --- | --- |
| `X-Jev-App` | `app` |
| `X-Jev-Feature` | `feature` |
| `X-Jev-Run` | `run` |
| `X-Jev-Tags: dataset=gold` | `tag.dataset` |

Replay adds `replay_of`.

## `pricing_rules`

Pricing rules use nanodollars per token so calculations remain integer operations. `$1` is one billion nanodollars.

The current Jev 1.13 rule is:

| ID | Model | Input | Output |
| --- | --- | ---: | ---: |
| `jev-1.13.0@2026-09` | `jev-1.13.0` | 42 nanodollars/token | 0 nanodollars/token |

The response's resolved model selects the rule. Aliases never select prices because their target may move. If usage is absent or no exact model rule exists, the exchange records an unknown cost rather than silently assuming zero.
