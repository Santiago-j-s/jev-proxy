import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import type {
  ExchangeCompletion,
  ExchangeDetail,
  ExchangeFilters,
  ExchangeListItem,
  NewExchange,
  UsageSummary,
} from "./domain.js";
import { PRICING_RULES } from "./pricing.js";

type SqlRow = Record<string, unknown>;
const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const MATCH_DIMENSIONS = `
  (? IS NULL OR EXISTS (
    SELECT 1 FROM exchange_dimensions app
    WHERE app.exchange_id = e.id AND app.name = 'app' AND app.value = ?
  ))
  AND (? IS NULL OR EXISTS (
    SELECT 1 FROM exchange_dimensions feature
    WHERE feature.exchange_id = e.id AND feature.name = 'feature' AND feature.value = ?
  ))
`;

export class ExchangeStore {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(databasePath: string, now: () => Date = () => new Date()) {
    this.#now = now;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }

    this.#database = new Database(databasePath);
    if (databasePath !== ":memory:") {
      chmodSync(databasePath, 0o600);
    }
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
    this.#pruneExpired();
  }

  close(): void {
    this.#database.close(true);
  }

  beginExchange(exchange: NewExchange): void {
    this.#pruneExpired();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .query(`
          INSERT INTO exchanges (
            id, started_at, outcome, method, path, requested_model,
            question_count, request_body
          ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
        `)
        .run(
          exchange.id,
          exchange.startedAt,
          exchange.method,
          exchange.path,
          exchange.requestedModel,
          exchange.questionCount,
          exchange.requestBody,
        );

      const insertDimension = this.#database.query(`
        INSERT INTO exchange_dimensions (exchange_id, name, value)
        VALUES (?, ?, ?)
      `);
      for (const [name, value] of Object.entries(exchange.dimensions)) {
        insertDimension.run(exchange.id, name, value);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeExchange(id: string, completion: ExchangeCompletion): void {
    if (completion.outcome === "network_error") {
      this.#database
        .query(`
          UPDATE exchanges SET
            finished_at = ?, duration_ms = ?, outcome = 'network_error',
            error_message = ?
          WHERE id = ?
        `)
        .run(
          completion.finishedAt,
          completion.durationMs,
          completion.errorMessage,
          id,
        );
      return;
    }

    const calculatedCost = completion.cost.status === "calculated"
      ? completion.cost
      : null;
    const unknownReason = completion.cost.status === "unknown"
      ? completion.cost.reason
      : null;

    this.#database
      .query(`
        UPDATE exchanges SET
          finished_at = ?, duration_ms = ?, outcome = ?, http_status = ?,
          resolved_model = ?, response_body = ?, upstream_request_id = ?,
          input_tokens = ?, output_tokens = ?, cost_status = ?,
          cost_nano_usd = ?, pricing_rule_id = ?, cost_unknown_reason = ?
        WHERE id = ?
      `)
      .run(
        completion.finishedAt,
        completion.durationMs,
        completion.outcome,
        completion.httpStatus,
        completion.resolvedModel,
        completion.responseBody,
        completion.upstreamRequestId,
        completion.usage?.inputTokens ?? null,
        completion.usage?.outputTokens ?? null,
        completion.cost.status,
        calculatedCost?.nanoUsd ?? null,
        calculatedCost?.pricingRuleId ?? null,
        unknownReason,
        id,
      );
  }

  listExchanges(limit = 100, offset = 0, filters: ExchangeFilters = { app: null, feature: null }): readonly ExchangeListItem[] {
    this.#pruneExpired();
    const rows = this.#withDimensions(`
      SELECT
        e.id, e.started_at, e.duration_ms, e.outcome, e.http_status,
        e.requested_model, e.resolved_model, e.question_count,
        e.input_tokens, e.output_tokens, e.cost_nano_usd,
        COALESCE(
          json_group_object(d.name, d.value) FILTER (WHERE d.name IS NOT NULL),
          '{}'
        ) AS dimensions_json
      FROM exchanges e
      LEFT JOIN exchange_dimensions d ON d.exchange_id = e.id
      WHERE ${MATCH_DIMENSIONS}
      GROUP BY e.id
      ORDER BY e.started_at DESC
      LIMIT ?
      OFFSET ?
    `, filters.app, filters.app, filters.feature, filters.feature, limit, offset);

    return rows.map(parseListItem);
  }

  getExchange(id: string): ExchangeDetail | null {
    this.#pruneExpired();
    const row = this.#withDimensions(`
      SELECT
        e.*,
        COALESCE(
          json_group_object(d.name, d.value) FILTER (WHERE d.name IS NOT NULL),
          '{}'
        ) AS dimensions_json
      FROM exchanges e
      LEFT JOIN exchange_dimensions d ON d.exchange_id = e.id
      WHERE e.id = ?
      GROUP BY e.id
    `, id)[0];

    return row === undefined ? null : parseDetail(row);
  }

  listFilterValues(): { readonly apps: readonly string[]; readonly features: readonly string[] } {
    this.#pruneExpired();
    const rows = this.#database.query<SqlRow, []>(`
      SELECT DISTINCT name, value
      FROM exchange_dimensions
      WHERE name IN ('app', 'feature') AND value != ''
      ORDER BY value
    `).all();
    return {
      apps: rows.filter((row) => readString(row, "name") === "app").map((row) => readString(row, "value")),
      features: rows.filter((row) => readString(row, "name") === "feature").map((row) => readString(row, "value")),
    };
  }

  summarize(filters: ExchangeFilters = { app: null, feature: null }): UsageSummary {
    this.#pruneExpired();
    const row = this.#database.query<SqlRow, [string | null, string | null, string | null, string | null]>(`
      SELECT
        COUNT(*) AS exchange_count,
        COALESCE(SUM(CASE WHEN e.outcome = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN e.outcome IN ('upstream_error', 'network_error') THEN 1 ELSE 0 END), 0) AS error_count,
        COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(e.cost_nano_usd), 0) AS cost_nano_usd,
        COALESCE(SUM(CASE WHEN e.cost_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cost_count,
        AVG(e.duration_ms) AS average_duration_ms
      FROM exchanges e
      WHERE ${MATCH_DIMENSIONS}
    `).get(filters.app, filters.app, filters.feature, filters.feature);

    if (row === null) {
      throw new Error("Summary query returned no row");
    }

    return {
      exchangeCount: readNumber(row, "exchange_count"),
      successCount: readNumber(row, "success_count"),
      errorCount: readNumber(row, "error_count"),
      inputTokens: readNumber(row, "input_tokens"),
      outputTokens: readNumber(row, "output_tokens"),
      costNanoUsd: readNumber(row, "cost_nano_usd"),
      unknownCostCount: readNumber(row, "unknown_cost_count"),
      averageDurationMs: readNullableNumber(row, "average_duration_ms"),
    };
  }

  exportExchanges(): readonly ExchangeDetail[] {
    this.#pruneExpired();
    const rows = this.#withDimensions(`
      SELECT
        e.*,
        COALESCE(
          json_group_object(d.name, d.value) FILTER (WHERE d.name IS NOT NULL),
          '{}'
        ) AS dimensions_json
      FROM exchanges e
      LEFT JOIN exchange_dimensions d ON d.exchange_id = e.id
      GROUP BY e.id
      ORDER BY e.started_at ASC
    `);
    return rows.map(parseDetail);
  }

  #withDimensions(sql: string, ...parameters: readonly (string | number | null)[]): SqlRow[] {
    return this.#database.query<SqlRow, (string | number | null)[]>(sql).all(...parameters);
  }

  #pruneExpired(): void {
    const cutoff = new Date(this.#now().getTime() - RETENTION_MILLISECONDS).toISOString();
    this.#database.query("DELETE FROM exchanges WHERE started_at < ?").run(cutoff);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS exchanges (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN (
          'pending', 'success', 'upstream_error', 'network_error'
        )),
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        http_status INTEGER,
        requested_model TEXT,
        resolved_model TEXT,
        question_count INTEGER,
        request_body TEXT,
        response_body TEXT,
        error_message TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_status TEXT CHECK (cost_status IN ('calculated', 'unknown')),
        cost_nano_usd INTEGER,
        pricing_rule_id TEXT,
        cost_unknown_reason TEXT,
        upstream_request_id TEXT
      );

      CREATE INDEX IF NOT EXISTS exchanges_started_at_idx
        ON exchanges(started_at DESC);

      CREATE TABLE IF NOT EXISTS exchange_dimensions (
        exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (exchange_id, name)
      );

      CREATE INDEX IF NOT EXISTS exchange_dimensions_lookup_idx
        ON exchange_dimensions(name, value);

      CREATE TABLE IF NOT EXISTS pricing_rules (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        input_nano_usd_per_token INTEGER NOT NULL,
        output_nano_usd_per_token INTEGER NOT NULL
      );
    `);

    const insertPricingRule = this.#database.query(`
      INSERT OR IGNORE INTO pricing_rules (
        id, model, input_nano_usd_per_token, output_nano_usd_per_token
      ) VALUES (?, ?, ?, ?)
    `);
    for (const rule of PRICING_RULES) {
      insertPricingRule.run(
        rule.id,
        rule.model,
        rule.inputNanoUsdPerToken,
        rule.outputNanoUsdPerToken,
      );
    }
  }
}

function parseListItem(row: SqlRow): ExchangeListItem {
  return {
    id: readString(row, "id"),
    startedAt: readString(row, "started_at"),
    durationMs: readNullableNumber(row, "duration_ms"),
    outcome: readOutcome(row, "outcome"),
    httpStatus: readNullableNumber(row, "http_status"),
    requestedModel: readNullableString(row, "requested_model"),
    resolvedModel: readNullableString(row, "resolved_model"),
    questionCount: readNullableNumber(row, "question_count"),
    inputTokens: readNullableNumber(row, "input_tokens"),
    outputTokens: readNullableNumber(row, "output_tokens"),
    costNanoUsd: readNullableNumber(row, "cost_nano_usd"),
    dimensions: readDimensions(row),
  };
}

function parseDetail(row: SqlRow): ExchangeDetail {
  return {
    ...parseListItem(row),
    finishedAt: readNullableString(row, "finished_at"),
    method: readString(row, "method"),
    path: readString(row, "path"),
    requestBody: readNullableString(row, "request_body"),
    responseBody: readNullableString(row, "response_body"),
    errorMessage: readNullableString(row, "error_message"),
    pricingRuleId: readNullableString(row, "pricing_rule_id"),
    costStatus: readCostStatus(row, "cost_status"),
    costUnknownReason: readNullableString(row, "cost_unknown_reason"),
    upstreamRequestId: readNullableString(row, "upstream_request_id"),
  };
}

function readDimensions(row: SqlRow): Readonly<Record<string, string>> {
  const text = readString(row, "dimensions_json");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Database returned invalid dimensions JSON");
  }

  const dimensions: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Database returned a non-string dimension");
    }
    dimensions[name] = value;
  }
  return dimensions;
}

function readString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string`);
  }
  return value;
}

function readNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string or null`);
  }
  return value;
}

function readNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new Error(`Expected ${column} to be a number`);
  }
  return value;
}

function readNullableNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`Expected ${column} to be a number or null`);
  }
  return value;
}

function readOutcome(row: SqlRow, column: string): ExchangeListItem["outcome"] {
  const value = readString(row, column);
  switch (value) {
    case "pending":
    case "success":
    case "upstream_error":
    case "network_error":
      return value;
    default:
      throw new Error(`Unexpected exchange outcome: ${value}`);
  }
}

function readCostStatus(
  row: SqlRow,
  column: string,
): ExchangeDetail["costStatus"] {
  const value = readNullableString(row, column);
  if (value === null || value === "calculated" || value === "unknown") {
    return value;
  }
  throw new Error(`Unexpected cost status: ${value}`);
}
