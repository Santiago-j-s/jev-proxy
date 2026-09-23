import { basicSetup, EditorView, keymap, json, jsonLanguage, jsonParseLinter, linter, Prec, systemOneCompletion } from "/codemirror.js";

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
  connectionLabel: document.querySelector("#connection-label"),
  editor: document.querySelector("#request-editor"),
  apiKey: document.querySelector("#api-key"),
  error: document.querySelector("#request-error"),
  sendButton: document.querySelector("#send-button"),
  responseStatus: document.querySelector("#response-status"),
  responseDuration: document.querySelector("#response-duration"),
  responseEmpty: document.querySelector("#response-empty"),
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
    setConnection(response.ok);
  } catch {
    setConnection(false);
  }
}

async function sendRequest() {
  elements.error.textContent = "";
  let body;
  try {
    body = JSON.stringify(JSON.parse(editor.state.doc.toString()));
  } catch {
    elements.error.textContent = "Fix the JSON before sending.";
    editor.focus();
    return;
  }

  elements.sendButton.disabled = true;
  elements.sendButton.textContent = "Sending…";
  elements.responseStatus.textContent = "In flight";
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
      body,
    });
    const responseText = await response.text();
    elements.responseStatus.textContent = `${response.status} ${response.ok ? "received" : "upstream error"}`;
    elements.responseStatus.dataset.outcome = response.ok ? "success" : "error";
    showResponse(responseText);
  } catch (error) {
    elements.responseStatus.textContent = "Network error";
    elements.responseStatus.dataset.outcome = "error";
    showResponse(error instanceof Error ? error.message : String(error));
    setConnection(false);
  } finally {
    elements.responseDuration.textContent = formatDuration(performance.now() - started);
    elements.sendButton.disabled = false;
    elements.sendButton.textContent = "Send request";
  }
}

function showResponse(text) {
  elements.responseEmpty.hidden = true;
  elements.responseOutput.hidden = false;
  renderJson(elements.responseOutput, text);
}

function setConnection(online) {
  elements.connection.classList.toggle("online", online);
  elements.connection.classList.toggle("offline", !online);
  elements.connectionLabel.textContent = online ? "Proxy ready" : "Proxy unavailable";
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

function formatDuration(milliseconds) {
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(2)} s`;
}

elements.sendButton.addEventListener("click", () => void sendRequest());
void checkConnection();
