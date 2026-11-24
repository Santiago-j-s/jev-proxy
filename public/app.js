import {
  formatCompact, formatDateTime, formatDuration, formatInteger, formatTime, formatUsd,
  h, parseJsonText, renderJson, renderJudgment, renderState, setConnection,
} from "./ui.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  connection: $("#connection"),
  exchangeList: $("#exchange-list"),
  emptyState: $("#empty-state"),
  emptyMessage: $("#empty-message"),
  emptyHint: $("#empty-hint"),
  appFilter: $("#app-filter"),
  featureFilter: $("#feature-filter"),
  statusButtons: document.querySelectorAll("[data-status]"),
  inspector: $("#inspector"),
  inspectorIdle: $("#inspector-idle"),
  inspectorContent: $("#inspector-content"),
  inspectorStatus: $("#inspector-status"),
  inspectorTitle: $("#inspector-title"),
  inspectorFacts: $("#inspector-facts"),
  inspectorDimensions: $("#inspector-dimensions"),
  inspectorError: $("#inspector-error"),
  inspectorErrorTitle: $("#inspector-error-title"),
  inspectorErrorMessage: $("#inspector-error-message"),
  judgmentSection: $("#judgment-section"),
  judgment: $("#judgment"),
  stateSection: $("#state-section"),
  state: $("#state"),
  payload: $("#payload"),
  payloadTabs: document.querySelectorAll("[data-payload]"),
  copyPayload: $("#copy-payload"),
  replayButton: $("#replay-button"),
  replayMessage: $("#replay-message"),
  closeInspector: $("#close-inspector"),
  pagination: $("#pagination"),
  previousPage: $("#previous-page"),
  nextPage: $("#next-page"),
  pageStatus: $("#page-status"),
  metricExchanges: $("#metric-exchanges"),
  metricErrors: $("#metric-errors"),
  metricInput: $("#metric-input"),
  metricOutput: $("#metric-output"),
  metricCost: $("#metric-cost"),
  metricCostNote: $("#metric-cost-note"),
  metricLatency: $("#metric-latency"),
};

const PAGE_SIZE = 50;

// The URL is the source of truth for what the page shows, so views survive reloads and back/forward.
function readView() {
  const parameters = new URL(window.location.href).searchParams;
  const page = Number(parameters.get("page"));
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    app: parameters.get("app") ?? "",
    feature: parameters.get("feature") ?? "",
    status: parameters.get("status") === "failed" ? "failed" : "",
    exchange: parameters.get("exchange"),
  };
}

function writeView(changes, { push }) {
  const url = new URL(window.location.href);
  const next = { ...readView(), ...changes };
  for (const [name, value] of Object.entries(next)) {
    if (value === "" || value === null || (name === "page" && value === 1)) url.searchParams.delete(name);
    else url.searchParams.set(name, String(value));
  }
  if (url.href !== window.location.href) window.history[push ? "pushState" : "replaceState"]({}, "", url);
}

let exchanges = [];
let total = 0;
let upstreamKeyConfigured = true;
let selected = null; // { id, signature, detail }
let payloadKind = "response";
let refreshGeneration = 0;
const rows = new Map(); // id -> { signature, item, button }

async function refresh() {
  const generation = ++refreshGeneration;
  const view = readView();
  const dimensionQuery = new URLSearchParams();
  if (view.app) dimensionQuery.set("app", view.app);
  if (view.feature) dimensionQuery.set("feature", view.feature);
  const listQuery = new URLSearchParams(dimensionQuery);
  if (view.status) listQuery.set("status", view.status);
  listQuery.set("limit", String(PAGE_SIZE));
  listQuery.set("offset", String((view.page - 1) * PAGE_SIZE));

  try {
    const [filters, summary, list] = await Promise.all([
      getJson("/api/filters"),
      getJson(`/api/summary?${dimensionQuery}`),
      getJson(`/api/exchanges?${listQuery}`),
    ]);
    if (generation !== refreshGeneration) return;
    setConnection(elements.connection, true, "Capturing locally");

    const pageCount = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
    if (view.page > pageCount) {
      writeView({ page: pageCount }, { push: false });
      return refresh();
    }

    exchanges = list.exchanges;
    total = list.total;
    renderFilterOptions(elements.appFilter, filters.apps, view.app, "All apps");
    renderFilterOptions(elements.featureFilter, filters.features, view.feature, "All features");
    for (const button of elements.statusButtons) button.setAttribute("aria-pressed", String(button.dataset.status === view.status));
    renderSummary(summary, view.status);
    renderExchanges(view);
    renderPagination(view.page);
    await syncSelection(view.exchange);
  } catch (error) {
    if (generation !== refreshGeneration) return;
    setConnection(elements.connection, false);
    console.error(error);
  }
}

function renderFilterOptions(select, values, selectedValue, allLabel) {
  const wanted = ["", ...values];
  if (selectedValue && !values.includes(selectedValue)) wanted.push(selectedValue);
  const current = Array.from(select.options, (option) => option.value);
  if (current.length !== wanted.length || current.some((value, index) => value !== wanted[index])) {
    for (const option of Array.from(select.options)) option.remove();
    select.append(...wanted.map((value) => new Option(value || allLabel, value)));
  }
  if (select.value !== selectedValue) select.value = selectedValue;
}

function renderSummary(summary, status) {
  elements.metricExchanges.textContent = formatInteger(summary.exchangeCount);
  const failed = summary.errorCount > 0;
  elements.metricErrors.dataset.failed = String(failed);
  elements.metricErrors.disabled = !failed && status !== "failed";
  elements.metricErrors.textContent = status === "failed"
    ? "show all"
    : failed ? `${formatInteger(summary.errorCount)} failed` : "no failures";
  elements.metricInput.textContent = formatCompact(summary.inputTokens);
  elements.metricOutput.textContent = `in · ${formatCompact(summary.outputTokens)} out`;
  elements.metricCost.textContent = formatUsd(summary.costNanoUsd);
  elements.metricCostNote.textContent = summary.unknownCostCount === 0
    ? "resolved model"
    : `+ ${formatInteger(summary.unknownCostCount)} unknown`;
  elements.metricCostNote.title = summary.unknownCostCount === 0
    ? "Calculated from each exchange's resolved model"
    : "Exchanges without usage or with an unrecognized model have no cost";
  elements.metricLatency.textContent = formatDuration(summary.averageDurationMs);
}

// Rows are patched in place so polling never steals focus, hover, or scroll position.
function renderExchanges(view) {
  const filtered = view.app !== "" || view.feature !== "" || view.status !== "";
  elements.emptyState.hidden = exchanges.length !== 0;
  elements.exchangeList.hidden = exchanges.length === 0;
  elements.emptyMessage.textContent = filtered ? "No exchanges match these filters." : "No exchanges captured yet.";
  elements.emptyHint.hidden = filtered;

  const visible = new Set();
  exchanges.forEach((exchange, index) => {
    visible.add(exchange.id);
    const signature = JSON.stringify(exchange);
    let row = rows.get(exchange.id);
    if (row === undefined || row.signature !== signature) {
      const next = exchangeRow(exchange);
      if (row !== undefined) row.item.replaceWith(next.item);
      row = { signature, ...next };
      rows.set(exchange.id, row);
    }
    const atIndex = elements.exchangeList.children[index];
    if (atIndex !== row.item) elements.exchangeList.insertBefore(row.item, atIndex ?? null);
  });
  for (const [id, row] of rows) {
    if (!visible.has(id)) {
      row.item.remove();
      rows.delete(id);
    }
  }
  markSelectedRow();
}

function exchangeRow(exchange) {
  const failed = exchange.outcome === "upstream_error" || exchange.outcome === "network_error";
  const item = h("li", [
    "relative border-b border-line/70 before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
    "before:origin-center before:scale-y-0 before:transition-transform motion-reduce:before:transition-none",
    "has-[[aria-current=true]]:before:scale-y-100",
    exchange.outcome === "pending" ? "before:bg-pending" : failed ? "before:bg-fault" : "before:bg-success",
  ].join(" "));
  const dimensions = dimensionSummary(exchange);
  const button = h("button", "exchange-columns w-full cursor-pointer px-3 py-2 text-left text-inherit hover:bg-fog focus-visible:bg-fog focus-visible:outline-offset-[-2px] aria-[current=true]:bg-fog",
    statusPill(exchange),
    h("time", "col-time font-utility text-[11px] tabular-nums text-muted", formatTime(exchange.startedAt)),
    h("span", "flex min-w-0 items-baseline gap-2",
      h("span", "min-w-0 truncate text-[13px]", dimensions),
      h("span", "shrink-0 font-utility text-[10.5px] text-muted", exchange.resolvedModel ?? exchange.requestedModel ?? "unknown model"),
    ),
    h("span", "text-right font-utility text-[12px] tabular-nums", exchange.inputTokens === null ? "—" : formatCompact(exchange.inputTokens)),
    h("span", "col-cost text-right font-utility text-[11px] tabular-nums text-muted", exchange.costNanoUsd === null ? "—" : formatUsd(exchange.costNanoUsd)),
    h("span", "col-latency text-right font-utility text-[11px] tabular-nums text-muted", formatDuration(exchange.durationMs)),
  );
  button.type = "button";
  button.dataset.id = exchange.id;
  button.title = `${formatDateTime(exchange.startedAt)} · ${dimensions}`;
  button.addEventListener("click", () => void select(exchange.id, { focus: false }));
  item.append(button);
  return { item, button };
}

function statusPill(exchange) {
  const pill = h("span", "status-pill", statusCode(exchange));
  pill.dataset.outcome = exchange.outcome;
  pill.title = statusText(exchange);
  return pill;
}

function statusCode(exchange) {
  if (exchange.outcome === "pending") return "···";
  if (exchange.outcome === "network_error") return "NET";
  return String(exchange.httpStatus ?? "—");
}

function statusText(exchange) {
  if (exchange.outcome === "pending") return "In flight";
  if (exchange.outcome === "success") return `${exchange.httpStatus} captured`;
  if (exchange.outcome === "network_error") return "Network error";
  return `${exchange.httpStatus ?? "—"} upstream error`;
}

function dimensionSummary(exchange) {
  const { app, feature, run, ...rest } = exchange.dimensions;
  const parts = [
    [app, feature].filter(Boolean).join(" / "),
    run,
    exchange.questionCount === null ? null : `${exchange.questionCount}q`,
    rest.replay_of ? "replay" : null,
  ].filter(Boolean);
  return parts.join(" · ") || "unlabeled";
}

function renderPagination(page) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  elements.pagination.hidden = total === 0;
  elements.previousPage.disabled = page <= 1;
  elements.nextPage.disabled = page >= pageCount;
  elements.pageStatus.textContent = `${formatInteger(first)}–${formatInteger(last)} of ${formatInteger(total)}`;
}

function changeView(changes) {
  writeView(changes, { push: true });
  void refresh();
}

// Selection

async function select(id, { focus }) {
  writeView({ exchange: id }, { push: false });
  elements.replayMessage.hidden = true;
  markSelectedRow();
  if (focus) {
    const button = rows.get(id)?.button;
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  }
  await syncSelection(id);
  if (window.matchMedia("(max-width: 980px)").matches && !focus) {
    elements.inspector.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/** Loads the selected exchange's detail when it changes; keeps an in-flight exchange current. */
async function syncSelection(id) {
  if (id === null) {
    selected = null;
    elements.inspectorIdle.hidden = false;
    elements.inspectorContent.hidden = true;
    return;
  }
  const signature = rows.get(id)?.signature ?? null;
  if (selected?.id === id && (signature === null || selected.signature === signature)) return;
  try {
    const detail = await getJson(`/api/exchanges/${encodeURIComponent(id)}`);
    if (readView().exchange !== id) return;
    const replaced = selected?.id !== id;
    selected = { id, signature, detail };
    renderInspector(detail, replaced);
  } catch {
    if (readView().exchange !== id) return;
    writeView({ exchange: null }, { push: false });
    void syncSelection(null);
  }
}

function markSelectedRow() {
  const id = readView().exchange;
  for (const [rowId, row] of rows) row.button.setAttribute("aria-current", String(rowId === id));
}

function moveSelection(delta) {
  if (exchanges.length === 0) return;
  const index = exchanges.findIndex((exchange) => exchange.id === readView().exchange);
  const nextIndex = index === -1 ? (delta > 0 ? 0 : exchanges.length - 1) : index + delta;
  const page = readView().page;
  if (nextIndex >= exchanges.length && page * PAGE_SIZE < total) {
    void goToPageAndSelect(page + 1, "first");
  } else if (nextIndex < 0 && page > 1) {
    void goToPageAndSelect(page - 1, "last");
  } else {
    const target = exchanges[Math.max(0, Math.min(exchanges.length - 1, nextIndex))];
    void select(target.id, { focus: true });
  }
}

async function goToPageAndSelect(page, position) {
  writeView({ page, exchange: null }, { push: true });
  await refresh();
  const target = position === "first" ? exchanges[0] : exchanges.at(-1);
  if (target) await select(target.id, { focus: true });
}

function clearSelection() {
  const previous = readView().exchange;
  writeView({ exchange: null }, { push: false });
  markSelectedRow();
  void syncSelection(null);
  if (previous) rows.get(previous)?.button.focus({ preventScroll: true });
}

// Inspector

function renderInspector(exchange, replaced) {
  elements.inspectorIdle.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.inspectorStatus.textContent = statusCode(exchange);
  elements.inspectorStatus.dataset.outcome = exchange.outcome;
  elements.inspectorStatus.title = statusText(exchange);
  elements.inspectorTitle.replaceChildren(
    exchange.resolvedModel ?? exchange.requestedModel ?? "unknown model",
    h("span", "ml-2 font-normal text-muted", formatShortDateTime(exchange.startedAt)),
  );
  elements.inspectorTitle.title = formatDateTime(exchange.startedAt);

  elements.replayButton.disabled = !upstreamKeyConfigured || exchange.requestBody === null;
  elements.replayButton.title = upstreamKeyConfigured
    ? "Send this request body again as a new exchange (uses API credits)"
    : "Replay needs TYPESAFE_API_KEY on the proxy process";

  elements.inspectorFacts.replaceChildren(
    fact("Latency", formatDuration(exchange.durationMs)),
    fact("Tokens in / out", exchange.inputTokens === null ? "—" : `${formatInteger(exchange.inputTokens)} / ${formatInteger(exchange.outputTokens ?? 0)}`),
    fact("Cost", exchange.costNanoUsd === null ? "unknown" : formatUsd(exchange.costNanoUsd),
      exchange.costUnknownReason ? `Unknown: ${exchange.costUnknownReason.replaceAll("_", " ")}` : undefined),
    fact("Model", modelChange(exchange)),
    fact("Price rule", exchange.pricingRuleId ?? "—"),
    fact("Request ID", exchange.upstreamRequestId ?? "—"),
  );

  const chips = Object.entries(exchange.dimensions).map(([name, value]) => dimensionChip(name, value));
  elements.inspectorDimensions.hidden = chips.length === 0;
  elements.inspectorDimensions.replaceChildren(...chips);

  const failure = failureSummary(exchange);
  elements.inspectorError.hidden = failure === null;
  if (failure !== null) {
    elements.inspectorErrorTitle.textContent = failure.title;
    elements.inspectorErrorMessage.textContent = failure.message;
  }

  const judgment = renderJudgment(exchange.requestBody, exchange.responseBody);
  elements.judgmentSection.hidden = judgment === null;
  elements.judgment.replaceChildren(...(judgment ? [judgment] : []));
  const state = renderState(exchange.requestBody);
  elements.stateSection.hidden = state === null;
  elements.state.replaceChildren(...(state ? [state] : []));

  renderPayload();
  if (replaced) elements.inspector.scrollTop = 0;
}

function modelChange(exchange) {
  const { requestedModel: requested, resolvedModel: resolved } = exchange;
  if (requested === null) return resolved ?? "—";
  if (resolved === null || resolved === requested) return requested;
  return `${requested} → ${resolved}`;
}

function formatShortDateTime(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function fact(label, value, title) {
  const text = String(value);
  const description = h("dd", "mt-1 truncate font-utility text-[11px] leading-[1.3]", text);
  description.title = title ?? text;
  return h("div", "",
    h("dt", "font-utility text-[8.5px] leading-none tracking-[0.08em] text-muted uppercase", label),
    description,
  );
}

function dimensionChip(name, value) {
  if (name === "replay_of") {
    const button = h("button", "chip cursor-pointer hover:border-signal hover:text-signal",
      h("span", "chip-name", "replay of"), value.slice(0, 8));
    button.type = "button";
    button.title = "Open the original exchange";
    button.addEventListener("click", () => void select(value, { focus: false }));
    return button;
  }
  const chip = h("span", "chip", h("span", "chip-name", name.replace(/^tag\./, "#")), h("span", "truncate", value));
  chip.title = `${name}=${value}`;
  return chip;
}

function failureSummary(exchange) {
  if (exchange.outcome === "network_error") {
    return { title: "Network error", message: exchange.errorMessage ?? "The upstream request failed before a response." };
  }
  if (exchange.outcome !== "upstream_error") return null;
  const body = parseJsonText(exchange.responseBody);
  const message = body?.error?.message ?? body?.message
    ?? (typeof body?.detail === "string" ? body.detail : null)
    ?? (body?.detail === undefined ? exchange.responseBody : JSON.stringify(body.detail, null, 2));
  return { title: `${exchange.httpStatus ?? "—"} upstream error`, message: message ?? "No response body" };
}

function renderPayload() {
  for (const tab of elements.payloadTabs) tab.setAttribute("aria-selected", String(tab.dataset.payload === payloadKind));
  const exchange = selected?.detail;
  if (!exchange) return;
  const text = payloadKind === "request"
    ? exchange.requestBody ?? "No request body captured"
    : exchange.responseBody ?? exchange.errorMessage ?? "No response captured";
  renderJson(elements.payload, text);
}

async function copyPayload() {
  const exchange = selected?.detail;
  const text = payloadKind === "request" ? exchange?.requestBody : exchange?.responseBody;
  if (text == null) return;
  const parsed = parseJsonText(text);
  await navigator.clipboard.writeText(parsed === undefined ? text : JSON.stringify(parsed, null, 2));
  elements.copyPayload.textContent = "Copied";
  window.setTimeout(() => { elements.copyPayload.textContent = "Copy"; }, 1000);
}

async function replaySelected() {
  const source = selected?.detail;
  if (!source) return;
  elements.replayButton.disabled = true;
  elements.replayButton.textContent = "Replaying…";
  showReplayMessage("Sending the stored request again…", "");
  try {
    const response = await fetch(`/api/exchanges/${encodeURIComponent(source.id)}/replay`, { method: "POST" });
    const replayId = response.headers.get("x-jev-exchange-id");
    if (replayId === null) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error ?? `Replay failed with ${response.status}`);
    }
    writeView({ page: 1, exchange: replayId }, { push: true });
    await refresh();
    rows.get(replayId)?.button.scrollIntoView({ block: "nearest" });
    showReplayMessage(response.ok ? "Replayed as a new exchange." : `Replay captured a ${response.status} response.`, response.ok ? "ok" : "error");
  } catch (error) {
    showReplayMessage(error instanceof Error ? error.message : String(error), "error");
  } finally {
    elements.replayButton.textContent = "Replay";
    elements.replayButton.disabled = !upstreamKeyConfigured;
  }
}

function showReplayMessage(text, tone) {
  elements.replayMessage.hidden = false;
  elements.replayMessage.dataset.tone = tone;
  elements.replayMessage.textContent = text;
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

// Events

elements.appFilter.addEventListener("change", () => changeView({ app: elements.appFilter.value, page: 1, exchange: null }));
elements.featureFilter.addEventListener("change", () => changeView({ feature: elements.featureFilter.value, page: 1, exchange: null }));
for (const button of elements.statusButtons) {
  button.addEventListener("click", () => changeView({ status: button.dataset.status, page: 1 }));
}
elements.metricErrors.addEventListener("click", () => {
  changeView({ status: readView().status === "failed" ? "" : "failed", page: 1 });
});
elements.previousPage.addEventListener("click", () => changeView({ page: readView().page - 1 }));
elements.nextPage.addEventListener("click", () => changeView({ page: readView().page + 1 }));
elements.replayButton.addEventListener("click", () => void replaySelected());
elements.closeInspector.addEventListener("click", clearSelection);
elements.copyPayload.addEventListener("click", () => void copyPayload());
for (const tab of elements.payloadTabs) {
  tab.addEventListener("click", () => {
    payloadKind = tab.dataset.payload;
    renderPayload();
  });
}
window.addEventListener("popstate", () => void refresh());

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
  const inList = target === document.body || elements.exchangeList.contains(target);
  if (event.key === "j" || (event.key === "ArrowDown" && inList)) moveSelection(1);
  else if (event.key === "k" || (event.key === "ArrowUp" && inList)) moveSelection(-1);
  else if (event.key === "Escape" && readView().exchange !== null) clearSelection();
  else return;
  event.preventDefault();
});

for (const origin of document.querySelectorAll("[data-origin]")) origin.textContent = window.location.origin;
getJson("/api/health")
  .then((health) => { upstreamKeyConfigured = health.upstreamKeyConfigured !== false; })
  .catch(() => {});
void refresh();
window.setInterval(() => void refresh(), 2500);
