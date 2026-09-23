import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const fieldNames = {
  request: ["model", "state", "questions"],
  question: ["type", "instructions", "criteria"],
  noulCriteria: ["true", "false"],
} as const;

const valueNames = {
  model: ["jev-latest", "jev-preview", "jev-1.13.0"],
  questionType: ["noul", "choice", "score"],
} as const;

type CompletionTarget =
  | { kind: "field"; scope: keyof typeof fieldNames; from: number; to: number; insertColon: boolean; usedNames: ReadonlySet<string> }
  | { kind: "value"; scope: keyof typeof valueNames; from: number; to: number };

// An editor document can be incomplete while the user is typing.
function readString(node: SyntaxNode | null | undefined, document: Text): string | null {
  if (!node) return null;
  try {
    const value: unknown = JSON.parse(document.sliceString(node.from, node.to));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function objectScope(object: SyntaxNode, document: Text): keyof typeof fieldNames | null {
  const path: string[] = [];
  let current = object;
  while (current.parent?.name === "Property") {
    const property = current.parent;
    const name = readString(property.getChild("PropertyName"), document);
    if (name === null || property.parent?.name !== "Object") return null;
    path.unshift(name);
    current = property.parent;
  }
  if (current.parent?.name !== "JsonText") return null;

  if (path.length === 0) return "request";
  if (path.length === 2 && path[0] === "questions") return "question";
  if (path.length === 3 && path[0] === "questions" && path[2] === "criteria") {
    const question = object.parent?.parent;
    if (question?.name !== "Object") return null;
    const type = question.getChildren("Property")
      .find((property) => readString(property.getChild("PropertyName"), document) === "type");
    if (readString(type?.getChild("String"), document) === "noul") return "noulCriteria";
  }
  return null;
}

function completionTarget(context: CompletionContext): CompletionTarget | null {
  const document = context.state.doc;
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);

  if ((node.name === "String" || node.name === "⚠") && node.parent?.name === "Property") {
    if ((node.name === "String" && context.pos === node.to)
      || !document.sliceString(node.from, context.pos).startsWith('"')) return null;

    const property = node.parent;
    const object = property.parent;
    const scope = object?.name === "Object" ? objectScope(object, document) : null;
    const name = readString(property.getChild("PropertyName"), document);
    if (scope === "request" && name === "model") {
      return { kind: "value", scope: "model", from: node.from, to: node.to };
    }
    if (scope === "question" && name === "type") {
      return { kind: "value", scope: "questionType", from: node.from, to: node.to };
    }
    return null;
  }

  let object: SyntaxNode | null;
  let from = context.pos;
  let to = context.pos;
  let currentProperty: SyntaxNode | null = null;
  if (node.name === "PropertyName") {
    currentProperty = node.parent;
    object = currentProperty?.parent ?? null;
    from = node.from;
    to = node.to;
  } else if (node.name === "⚠" && node.parent?.name === "Object" && document.sliceString(node.from, context.pos).startsWith('"')) {
    object = node.parent;
    from = node.from;
  } else if (context.explicit && (node.name === "Object" || node.name === "{" || node.name === ",")) {
    object = node.name === "Object" ? node : node.parent;
  } else {
    return null;
  }

  if (object?.name !== "Object") return null;
  const scope = objectScope(object, document);
  if (scope === null) return null;
  return {
    kind: "field",
    scope,
    from,
    to,
    insertColon: currentProperty === null || currentProperty.getChild(":") === null,
    usedNames: new Set(object.getChildren("Property")
      .filter((property) => property.from !== currentProperty?.from)
      .map((property) => readString(property.getChild("PropertyName"), document))
      .filter((name): name is string => name !== null)),
  };
}

export function systemOneCompletion(context: CompletionContext): CompletionResult | null {
  const target = completionTarget(context);
  if (target === null) return null;

  if (target.kind === "value") {
    return {
      from: target.from,
      to: target.to,
      options: valueNames[target.scope].map((value) => ({ label: JSON.stringify(value), type: "enum" })),
    };
  }

  const options = fieldNames[target.scope]
    .filter((name) => !target.usedNames.has(name))
    .map((name) => ({
      label: JSON.stringify(name),
      apply: `${JSON.stringify(name)}${target.insertColon ? ": " : ""}`,
      type: "property",
    }));
  return options.length ? { from: target.from, to: target.to, options } : null;
}
