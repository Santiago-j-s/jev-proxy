// Rendering shared by the captures and playground pages. Everything here reads
// captured payloads defensively: a stored body may be truncated, non-JSON, or
// an upstream error document rather than a System One response.

/** Creates an element with classes and children; strings become text nodes. */
export function h(tag, className = "", ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

export function parseJsonText(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pretty-prints JSON text with token spans, or shows non-JSON text unchanged. */
export function renderJson(element, text) {
  const value = parseJsonText(text);
  if (value === undefined) {
    element.textContent = text ?? "";
    return;
  }
  const pretty = JSON.stringify(value, null, 2);
  const tokens = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of pretty.matchAll(tokens)) {
    fragment.append(pretty.slice(last, match.index));
    const [token, string, colon, boolean, nullValue] = match;
    const kind = string !== undefined ? (colon ? "property" : "string") : boolean ? "boolean" : nullValue ? "null" : "number";
    fragment.append(h("span", `token ${kind}`, string !== undefined ? string : token));
    if (colon) fragment.append(colon);
    last = match.index + token.length;
  }
  fragment.append(pretty.slice(last));
  element.replaceChildren(fragment);
}

/**
 * Pairs each requested question with its answer. Returns null when the request
 * has no questions object, so callers can fall back to raw payloads.
 */
export function renderJudgment(requestText, responseText) {
  const request = parseJsonText(requestText);
  const response = parseJsonText(responseText);
  const questions = isObject(request?.questions) ? Object.entries(request.questions) : [];
  const answers = isObject(response?.answers) ? response.answers : {};
  if (questions.length === 0) return null;

  return h("ol", "divide-y divide-line",
    ...questions.map(([name, question]) => {
      const answer = answers[name];
      return h("li", "grid gap-2 px-4 py-3",
        h("div", "flex items-baseline justify-between gap-3",
          h("span", "min-w-0 truncate font-utility text-[11px] font-semibold", name),
          h("span", "shrink-0 font-utility text-[9px] tracking-[0.08em] text-muted uppercase", String(question?.type ?? "question")),
        ),
        question?.instructions === undefined ? null
          : h("p", "text-[13px] leading-[1.45] text-ink/85", contentText(question.instructions)),
        answer === undefined
          ? h("p", "font-utility text-[10px] text-muted", "No answer returned")
          : renderAnswer(answer),
      );
    }),
  );
}

function renderAnswer(answer) {
  if (answer?.type === "noul" && typeof answer.noul === "number") {
    return h("div", "grid gap-1", probabilityBar("yes", answer.noul, true));
  }
  if (answer?.type === "choice" && isObject(answer.probabilities)) {
    const options = numericEntries(answer.probabilities).sort((left, right) => right[1] - left[1]);
    // Ties can push the returned choice past the cutoff; it must always be visible.
    const shown = options.slice(0, 6);
    const chosen = options.find(([label]) => label === answer.choice);
    if (chosen && !shown.includes(chosen)) shown.splice(shown.length - 1, 1, chosen);
    return h("div", "grid gap-1",
      ...shown.map(([label, probability]) => probabilityBar(label, probability, label === answer.choice)),
      options.length > shown.length
        ? h("p", "font-utility text-[10px] text-muted", `+ ${options.length - shown.length} more options`)
        : null,
      confidenceText(answer.confidence),
    );
  }
  if (answer?.type === "score" && isObject(answer.probabilities)
    && Object.keys(answer.probabilities).every((level) => /^\d+$/.test(level))) {
    // `score` is the expected level (e.g. 1.48), so show it alongside every level in scale order.
    const legend = isObject(answer.legend) ? answer.legend : {};
    const levels = numericEntries(answer.probabilities).sort((left, right) => Number(left[0]) - Number(right[0]));
    const likeliest = levels.reduce((best, level) => (best === null || level[1] > best[1] ? level : best), null)?.[0];
    const top = levels.at(-1)?.[0];
    return h("div", "grid gap-1",
      typeof answer.score === "number"
        ? h("p", "font-utility text-[12px]", h("strong", "font-semibold", answer.score.toFixed(2)), top === undefined ? null : h("span", "text-muted", ` / ${top}`))
        : null,
      ...levels.map(([level, probability]) => {
        const description = legend[level] === undefined ? null : contentText(legend[level]);
        return probabilityBar(description ? `${level} · ${description}` : level, probability, level === likeliest);
      }),
      confidenceText(answer.confidence),
    );
  }
  if (answer?.type === "box" && isObject(answer.box)) {
    const { top, right, bottom, left } = answer.box;
    return h("div", "grid gap-1",
      h("p", "font-utility text-[11px]", `top ${top} · right ${right} · bottom ${bottom} · left ${left}`),
      confidenceText(answer.confidence),
    );
  }
  const raw = h("pre", "overflow-auto font-utility text-[10.5px] leading-[1.6] whitespace-pre-wrap");
  renderJson(raw, JSON.stringify(answer));
  return raw;
}

function numericEntries(object) {
  return Object.entries(object).filter(([, probability]) => typeof probability === "number");
}

function probabilityBar(label, probability, emphasized) {
  const percent = Math.max(0, Math.min(1, probability)) * 100;
  const labelElement = h("span", `truncate ${emphasized ? "font-semibold text-ink" : "text-muted"}`, label);
  labelElement.title = label;
  return h("div", "grid grid-cols-[minmax(0,min(14rem,40%))_minmax(3rem,1fr)_3.25rem] items-center gap-3 font-utility text-[11px]",
    labelElement,
    h("span", "relative h-1.5 overflow-hidden rounded-full bg-fog",
      Object.assign(h("span", `absolute inset-y-0 left-0 rounded-full ${emphasized ? "bg-signal" : "bg-line"}`), {
        style: `width: ${percent}%`,
      }),
    ),
    h("span", `text-right tabular-nums ${emphasized ? "font-semibold" : "text-muted"}`, `${percent.toFixed(percent < 10 ? 1 : 0)}%`),
  );
}

function confidenceText(confidence) {
  return typeof confidence === "number"
    ? h("p", "font-utility text-[10px] text-muted", `confidence ${confidence.toFixed(2)}`)
    : null;
}

/** Renders `state` for reading: strings stay prose, everything else stays JSON. */
export function renderState(requestText) {
  const state = parseJsonText(requestText)?.state;
  if (state === undefined) return null;
  if (typeof state === "string") return h("p", "px-4 py-3 text-[13px] leading-[1.5] whitespace-pre-wrap", state);
  if (isObject(state)) {
    return h("dl", "divide-y divide-line",
      ...Object.entries(state).map(([key, value]) => h("div", "grid gap-1 px-4 py-3",
        h("dt", "font-utility text-[9px] tracking-[0.08em] text-muted uppercase", key),
        h("dd", "text-[13px] leading-[1.5] whitespace-pre-wrap break-words", contentText(value)),
      )),
    );
  }
  return h("p", "px-4 py-3 font-utility text-[11px] whitespace-pre-wrap", JSON.stringify(state, null, 2));
}

function contentText(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Updates the header connection indicator shared by both pages. */
export function setConnection(element, online, onlineLabel) {
  element.dataset.state = online ? "online" : "offline";
  element.querySelector("[data-connection-label]").textContent = online ? onlineLabel : "Proxy unavailable";
}

export function formatInteger(value) { return new Intl.NumberFormat().format(value); }
export function formatCompact(value) { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
export function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
export function formatDateTime(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
export function formatDuration(value) { return value === null ? "—" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`; }
export function formatUsd(nanoUsd) {
  const usd = nanoUsd / 1_000_000_000;
  if (usd === 0) return "$0.00";
  return `$${usd.toFixed(usd < 0.001 ? 6 : 4)}`;
}
