const elements = {
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  exchangeList: document.querySelector("#exchange-list"),
  emptyState: document.querySelector("#empty-state"),
  inspectorIdle: document.querySelector("#inspector-idle"),
  inspectorContent: document.querySelector("#inspector-content"),
  inspectorStatus: document.querySelector("#inspector-status"),
  inspectorTitle: document.querySelector("#inspector-title"),
  inspectorFacts: document.querySelector("#inspector-facts"),
  requestPayload: document.querySelector("#request-payload"),
  responsePayload: document.querySelector("#response-payload"),
  replayButton: document.querySelector("#replay-button"),
  refreshButton: document.querySelector("#refresh-button"),
  pagination: document.querySelector("#pagination"),
  previousPage: document.querySelector("#previous-page"),
  nextPage: document.querySelector("#next-page"),
  pageStatus: document.querySelector("#page-status"),
  metricExchanges: document.querySelector("#metric-exchanges"),
  metricErrors: document.querySelector("#metric-errors"),
  metricInput: document.querySelector("#metric-input"),
  metricOutput: document.querySelector("#metric-output"),
  metricCost: document.querySelector("#metric-cost"),
  metricLatency: document.querySelector("#metric-latency"),
};

let selectedExchangeId = null;
let selectedExchange = null;
const pageSize = 25;
let pageOffset = (readPageNumber() - 1) * pageSize;
writePageNumber(readPageNumber(), true);

async function refresh() {
  try {
    const [summary, list] = await Promise.all([
      getJson("/api/summary"),
      getJson(`/api/exchanges?limit=${pageSize}&offset=${pageOffset}`),
    ]);
    const pageCount = Math.max(1, Math.ceil(summary.exchangeCount / pageSize));
    const currentPage = Math.floor(pageOffset / pageSize) + 1;
    if (currentPage > pageCount) {
      pageOffset = (pageCount - 1) * pageSize;
      writePageNumber(pageCount, true);
      await refresh();
      return;
    }
    renderSummary(summary);
    const hasNextPage = pageOffset + list.exchanges.length < summary.exchangeCount;
    renderExchanges(list.exchanges);
    renderPagination(summary.exchangeCount, hasNextPage);
    setConnection(true);
  } catch (error) {
    setConnection(false);
    console.error(error);
  }
}

function renderSummary(summary) {
  elements.metricExchanges.textContent = formatInteger(summary.exchangeCount);
  elements.metricErrors.textContent = summary.errorCount === 0
    ? "No failures"
    : `${formatInteger(summary.errorCount)} failed`;
  elements.metricInput.textContent = formatCompact(summary.inputTokens);
  elements.metricOutput.textContent = `${formatCompact(summary.outputTokens)} output tokens`;
  elements.metricCost.textContent = formatUsd(summary.costNanoUsd);
  elements.metricCost.title = summary.unknownCostCount === 0
    ? "All captured costs are known"
    : `${summary.unknownCostCount} exchange${summary.unknownCostCount === 1 ? " has" : "s have"} unknown cost`;
  elements.metricCost.nextElementSibling.textContent = summary.unknownCostCount === 0
    ? "Calculated from resolved model"
    : `Plus ${summary.unknownCostCount} unknown`;
  elements.metricLatency.textContent = summary.averageDurationMs === null
    ? "—"
    : formatDuration(summary.averageDurationMs);
}

function renderExchanges(exchanges) {
  elements.emptyState.hidden = exchanges.length !== 0;
  elements.exchangeList.replaceChildren(...exchanges.map(exchangeRow));
}

function renderPagination(exchangeCount, hasNextPage) {
  const hasPreviousPage = pageOffset > 0;
  const pageCount = Math.max(1, Math.ceil(exchangeCount / pageSize));
  const currentPage = Math.floor(pageOffset / pageSize) + 1;
  const firstExchange = pageOffset + 1;
  const lastExchange = Math.min(pageOffset + pageSize, exchangeCount);
  elements.pagination.hidden = exchangeCount === 0;
  elements.previousPage.disabled = !hasPreviousPage;
  elements.nextPage.disabled = !hasNextPage;
  elements.pageStatus.textContent = `${formatInteger(firstExchange)}–${formatInteger(lastExchange)} of ${formatInteger(exchangeCount)} · Page ${currentPage} of ${pageCount}`;
}

async function changePage(direction) {
  pageOffset = Math.max(0, pageOffset + direction * pageSize);
  writePageNumber(Math.floor(pageOffset / pageSize) + 1, false);
  await refresh();
  elements.exchangeList.scrollIntoView({ behavior: "smooth", block: "start" });
}

function readPageNumber() {
  const value = Number(new URL(window.location.href).searchParams.get("page"));
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function writePageNumber(page, replace) {
  const url = new URL(window.location.href);
  url.searchParams.set("page", String(page));
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function exchangeRow(exchange) {
  const item = document.createElement("li");
  item.className = "exchange-row";
  item.dataset.outcome = exchange.outcome;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-current", String(exchange.id === selectedExchangeId));
  button.addEventListener("click", () => void selectExchange(exchange.id));

  const timeCell = document.createElement("span");
  timeCell.className = "exchange-time";
  const time = document.createElement("time");
  time.dateTime = exchange.startedAt;
  time.textContent = formatTime(exchange.startedAt);
  const status = document.createElement("span");
  status.className = "status-label";
  status.textContent = exchange.durationMs === null
    ? statusText(exchange)
    : `${statusText(exchange)} · ${formatDuration(exchange.durationMs)}`;
  timeCell.append(time, status);

  const modelCell = document.createElement("span");
  modelCell.className = "exchange-model";
  const model = document.createElement("strong");
  model.textContent = exchange.resolvedModel ?? exchange.requestedModel ?? "Unknown model";
  const dimensions = document.createElement("small");
  dimensions.textContent = dimensionText(exchange.dimensions, exchange.questionCount);
  modelCell.append(model, dimensions);

  const usageCell = document.createElement("span");
  usageCell.className = "exchange-usage";
  const tokens = document.createElement("strong");
  tokens.textContent = exchange.inputTokens === null ? "—" : formatCompact(exchange.inputTokens);
  const cost = document.createElement("small");
  cost.textContent = exchange.costNanoUsd === null ? "cost unknown" : formatUsd(exchange.costNanoUsd);
  usageCell.append(tokens, cost);

  button.append(timeCell, modelCell, usageCell);
  item.append(button);
  return item;
}

async function selectExchange(id) {
  selectedExchangeId = id;
  const exchange = await getJson(`/api/exchanges/${encodeURIComponent(id)}`);
  selectedExchange = exchange;
  renderInspector(exchange);
  await refresh();
}

function renderInspector(exchange) {
  elements.inspectorIdle.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.inspectorStatus.textContent = statusText(exchange);
  elements.inspectorTitle.textContent = exchange.resolvedModel ?? exchange.requestedModel ?? "Exchange details";
  elements.inspectorFacts.replaceChildren(
    fact("Started", formatDateTime(exchange.startedAt)),
    fact("Transit", formatDuration(exchange.durationMs)),
    fact("HTTP", exchange.httpStatus ?? "—"),
    fact("Input", exchange.inputTokens === null ? "—" : `${formatInteger(exchange.inputTokens)} tok`),
    fact("Output", exchange.outputTokens === null ? "—" : `${formatInteger(exchange.outputTokens)} tok`),
    fact("Cost", exchange.costNanoUsd === null ? "Unknown" : formatUsd(exchange.costNanoUsd)),
    fact("Questions", exchange.questionCount ?? "—"),
    fact("Price rule", exchange.pricingRuleId ?? exchange.costUnknownReason ?? "—"),
    fact("Request ID", exchange.upstreamRequestId ?? "—"),
  );
  renderJson(elements.requestPayload, exchange.requestBody ?? "No payload captured");
  renderJson(
    elements.responsePayload,
    exchange.responseBody ?? exchange.errorMessage ?? "No response captured",
  );
}

function fact(label, value) {
  const container = document.createElement("div");
  container.className = "fact";
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = String(value);
  description.title = String(value);
  container.append(term, description);
  return container;
}

async function replaySelected() {
  if (selectedExchangeId === null) return;
  elements.replayButton.disabled = true;
  elements.replayButton.textContent = "Replaying";
  try {
    const response = await fetch(`/api/exchanges/${encodeURIComponent(selectedExchangeId)}/replay`, { method: "POST" });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error ?? "Replay failed");
    }
    await refresh();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  } finally {
    elements.replayButton.disabled = false;
    elements.replayButton.textContent = "Replay";
  }
}

async function copyPayload(kind, button) {
  const payload = kind === "request" ? selectedExchange?.requestBody : selectedExchange?.responseBody;
  if (payload == null) return;
  await navigator.clipboard.writeText(payload);
  const previous = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => { button.textContent = previous; }, 1000);
}

function setConnection(online) {
  elements.connection.classList.toggle("online", online);
  elements.connection.classList.toggle("offline", !online);
  elements.connectionLabel.textContent = online ? "Capturing locally" : "Proxy unavailable";
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function statusText(exchange) {
  if (exchange.outcome === "pending") return "In flight";
  if (exchange.outcome === "success") return `${exchange.httpStatus} captured`;
  if (exchange.outcome === "network_error") return "Network error";
  return `${exchange.httpStatus ?? "—"} upstream error`;
}

function dimensionText(dimensions, questionCount) {
  const values = Object.values(dimensions);
  const questionLabel = questionCount === null ? null : `${questionCount} question${questionCount === 1 ? "" : "s"}`;
  return [...values, questionLabel].filter(Boolean).join(" · ") || "Unlabeled exchange";
}

function renderJson(element, text) {
  try {
    element.textContent = JSON.stringify(JSON.parse(text), null, 2);
    element.classList.add("language-json");
    window.Prism?.highlightElement(element);
  } catch {
    element.classList.remove("language-json");
    element.textContent = text;
  }
}

function formatInteger(value) { return new Intl.NumberFormat().format(value); }
function formatCompact(value) { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function formatDateTime(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function formatDuration(value) { return value === null ? "—" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`; }
function formatUsd(nanoUsd) {
  const usd = nanoUsd / 1_000_000_000;
  if (usd === 0) return "$0.00";
  return `$${usd.toFixed(usd < 0.001 ? 6 : 4)}`;
}

elements.refreshButton.addEventListener("click", () => void refresh());
elements.previousPage.addEventListener("click", () => void changePage(-1));
elements.nextPage.addEventListener("click", () => void changePage(1));
window.addEventListener("popstate", () => {
  pageOffset = (readPageNumber() - 1) * pageSize;
  void refresh();
});
elements.replayButton.addEventListener("click", () => void replaySelected());
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", () => void copyPayload(button.dataset.copy, button));
});

void refresh();
window.setInterval(() => void refresh(), 2500);
