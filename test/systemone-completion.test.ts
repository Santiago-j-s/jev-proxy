import assert from "node:assert/strict";
import { test } from "node:test";

import { CompletionContext } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";

import { systemOneCompletion } from "../browser/systemone-completion.js";

function suggestions(marked: string) {
  const pos = marked.indexOf("|");
  const state = EditorState.create({
    doc: marked.replace("|", ""),
    extensions: [json()],
  });
  return systemOneCompletion(new CompletionContext(state, pos, true));
}

test("suggests System One fields only at their matching object level", () => {
  assert.deepEqual(suggestions('{"mo|')?.options.map((option) => option.label),
    ['"model"', '"state"', '"questions"']);
  assert.deepEqual(suggestions('{|}')?.options.map((option) => option.label),
    ['"model"', '"state"', '"questions"']);
  assert.deepEqual(suggestions('{"questions":{"my_question":{"ty|')?.options.map((option) => option.label),
    ['"type"', '"instructions"', '"criteria"']);
  assert.equal(suggestions('{"state":{"my_field":"value", "|'), null);
  assert.equal(suggestions('{"state":[{"|'), null);
  assert.equal(suggestions('{"questions":{"my_ques|'), null);
});

test("suggests question types and Noul criteria without prescribing arbitrary criteria", () => {
  assert.deepEqual(suggestions('{"questions":{"q":{"type":"no|')?.options.map((option) => option.label),
    ['"noul"', '"choice"', '"score"']);
  assert.deepEqual(suggestions('{"questions":{"q":{"type":"noul","criteria":{"tr|')?.options.map((option) => option.label),
    ['"true"', '"false"']);
  assert.equal(suggestions('{"questions":{"q":{"type":"choice","criteria":{"|'), null);
  assert.equal(suggestions('{"questions":{"q":{"type":"score","criteria":["|'), null);
});

test("keeps existing keys unique and preserves the colon when renaming", () => {
  const result = suggestions('{"model":"jev-latest", "st|ate": "text"}');
  assert.deepEqual(result?.options.map((option) => option.label), ['"state"', '"questions"']);
  assert.equal(result?.options[0]?.apply, '"state"');
  assert.deepEqual(suggestions('{"model":"jev-latest", "|')?.options.map((option) => option.label),
    ['"state"', '"questions"']);
});

test("suggests model names from the documented aliases and pinned example", () => {
  assert.deepEqual(suggestions('{"model":"jev-|')?.options.map((option) => option.label),
    ['"jev-latest"', '"jev-preview"', '"jev-1.13.0"']);
  assert.equal(suggestions('{"state":"je|'), null);
});

test("still suggests fields while the surrounding JSON is invalid", () => {
  assert.deepEqual(suggestions('{"bad\\x": 1, "|')?.options.map((option) => option.label),
    ['"model"', '"state"', '"questions"']);
});
