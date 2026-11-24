import { formatDuration, parseJsonText, renderJson, renderJudgment, setConnection } from "./ui.js";
import { basicSetup, EditorView, keymap, json, jsonLanguage, jsonParseLinter, linter, Prec, systemOneCompletion } from "../browser/codemirror.js";

const sampleRequest = {
  model: "jev-1.13.0",
  state: {
    message: "The customer renewed their subscription and thanked the support team.",
  },
  questions: {
    positive: {
      type: "noul",
      instructions: "Is the customer's sentiment positive?",
    },
  },
};

const elements = {
  connection: document.querySelector("#connection"),
  editor: document.querySelector("#request-editor"),
  apiKeyRow: document.querySelector("#api-key-row"),
  apiKey: document.querySelector("#api-key"),
  error: document.querySelector("#request-error"),
  sendButton: document.querySelector("#send-button"),
  responseStatus: document.querySelector("#response-status"),
  responseTitle: document.querySelector("#response-title"),
  responseDuration: document.querySelector("#response-duration"),
  capturesLink: document.querySelector("#captures-link"),
  responseEmpty: document.querySelector("#response-empty"),
  responseContent: document.querySelector("#response-content"),
  responseError: document.querySelector("#response-error"),
  responseErrorMessage: document.querySelector("#response-error-message"),
  judgmentSection: document.querySelector("#judgment-section"),
  judgment: document.querySelector("#judgment"),
  responseOutput: document.querySelector("#response-output"),
};

const editor = new EditorView({
  doc: JSON.stringify(sampleRequest, null, 2),
  extensions: [
    basicSetup,
    json(),
    jsonLanguage.data.of({ autocomplete: systemOneCompletion }),
    linter(jsonParseLinter()),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-labelledby": "request-label",
      "aria-describedby": "request-error",
    }),
    // basicSetup uses Mod-Enter for a blank line; the playground uses it to send.
    Prec.highest(keymap.of([{
      key: "Mod-Enter",
      run: () => {
        void sendRequest();
        return true;
      },
    }])),
  ],
  parent: elements.editor,
});

async function checkConnection() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    setConnection(elements.connection, response.ok, "Proxy ready");
    // Only ask for a key when the proxy cannot supply one itself.
    elements.apiKeyRow.hidden = health.upstreamKeyConfigured !== false;
  } catch {
    setConnection(elements.connection, false);
    elements.apiKeyRow.hidden = false;
  }
}

let sending = false;

async function sendRequest() {
  if (sending) return;
  elements.error.textContent = "";
  const requestText = editor.state.doc.toString();
  if (parseJsonText(requestText) === undefined) {
    elements.error.textContent = "Fix the JSON before sending.";
    editor.focus();
    return;
  }

  sending = true;
  elements.sendButton.disabled = true;
  elements.sendButton.textContent = "Sending…";
  showStatus("···", "pending", "In flight");
  elements.responseDuration.textContent = "";

  const started = performance.now();
  try {
    const headers = {
      "content-type": "application/json",
      "x-jev-app": "playground",
      "x-jev-feature": "manual-request",
    };
    const apiKey = elements.apiKey.value.trim();
    if (apiKey !== "") {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch("/v1/systemone", {
      method: "POST",
      headers,
      body: JSON.stringify(JSON.parse(requestText)),
    });
    const responseText = await response.text();
    showStatus(String(response.status), response.ok ? "success" : "upstream_error", response.ok ? "Response" : "Upstream error");
    showResponse(requestText, responseText, response.ok ? null : errorMessage(responseText));
  } catch (error) {
    showStatus("NET", "network_error", "Network error");
    showResponse(requestText, null, error instanceof Error ? error.message : String(error));
    setConnection(elements.connection, false);
  } finally {
    elements.responseDuration.textContent = formatDuration(performance.now() - started);
    elements.sendButton.disabled = false;
    elements.sendButton.textContent = "Send request";
    sending = false;
  }
}

function showStatus(code, outcome, title) {
  elements.responseStatus.hidden = false;
  elements.responseStatus.textContent = code;
  elements.responseStatus.dataset.outcome = outcome;
  elements.responseTitle.textContent = title;
}

function showResponse(requestText, responseText, failure) {
  elements.responseEmpty.hidden = true;
  elements.responseContent.hidden = false;
  elements.capturesLink.hidden = false;
  elements.responseError.hidden = failure === null;
  elements.responseErrorMessage.textContent = failure ?? "";
  const judgment = failure === null ? renderJudgment(requestText, responseText) : null;
  elements.judgmentSection.hidden = judgment === null;
  elements.judgment.replaceChildren(...(judgment ? [judgment] : []));
  renderJson(elements.responseOutput, responseText ?? "No response");
}

function errorMessage(text) {
  const body = parseJsonText(text);
  const message = body?.error?.message ?? body?.message ?? body?.detail;
  if (message === undefined) return text || "The upstream returned an error without a body.";
  return typeof message === "string" ? message : JSON.stringify(message, null, 2);
}

elements.sendButton.addEventListener("click", () => void sendRequest());
void checkConnection();
