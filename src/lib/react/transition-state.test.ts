/**
 * Repo guard: no state setter runs after an `await` inside an async
 * transition unless it is wrapped in the transition again.
 *
 * WHY THIS EXISTS
 * ---------------
 * In React 19, `start(async () => { const r = await action(); setError(r.error); })`
 * only keeps the updates made BEFORE the first `await` inside the transition.
 * Anything after it commits urgently while `pending` is still true, so for one
 * render the screen shows the new state (an error message, a closed dialog)
 * beside a control that still says "Saving…" and is still disabled. React's
 * documented fix is to wrap the post-await update in the transition again:
 *
 *     start(async () => {
 *       const r = await action();
 *       start(() => { setError(r.error); });
 *     });
 *
 * Reference fix: staff/(dashboard)/queue/[id]/amend-form.tsx.
 *
 * WHAT IT FLAGS
 * -------------
 * Every call `X(async () => { … })` / `X(async function () { … })` where X is a
 * transition starter (the second element of `useTransition()` destructured in
 * the same file, or `startTransition` imported from "react"), and inside it
 * every call to a state setter (the second element of a `useState` /
 * `useReducer` destructure, or — as a fallback — any `setXxx` identifier) that
 * executes after the first `await` of that callback, including inside nested
 * callbacks, try/catch/finally and `.then` bodies. A setter inside a nested
 * synchronous `X(() => …)` is fine, and is how the fix is written.
 *
 * Known limit: position is lexical. A helper closure declared BEFORE the first
 * await but called after it is not seen.
 *
 * If a setter really must commit urgently, add `"<file>#<setter>"` to
 * `ALLOWED` with a `why` that argues it is correct.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const SRC_DIR = join(process.cwd(), "src");

/** Keyed `<path relative to src/>#<setterName>`; value is the required `why`. */
const ALLOWED: Record<string, string> = {};

/** `/^set[A-Z]/` also matches these browser globals; they are not state. */
const NOT_SETTERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const DEFERRED_CALLS = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "requestAnimationFrame",
  "queueMicrotask",
]);

const isCheckable = (p: string) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\.d\.ts$/.test(p);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}

const rel = (full: string) => relative(SRC_DIR, full).split(sep).join("/");

export interface Hit {
  file: string;
  line: number;
  setter: string;
}

const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

const isFunctionLike = (n: ts.Node) =>
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n);

const isAsync = (n: ts.ArrowFunction | ts.FunctionExpression) =>
  !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

export function scanSource(text: string, full: string): Hit[] {
  const src = ts.createSourceFile(
    full,
    text,
    ts.ScriptTarget.Latest,
    true,
    full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const file = rel(full);

  const starters = new Set<string>();
  const setters = new Set<string>();
  let reactNs: string | null = null;

  const calleeName = (e: ts.Expression): string | null =>
    ts.isIdentifier(e)
      ? e.text
      : ts.isPropertyAccessExpression(e)
        ? e.name.text
        : null;

  // Pass 1: collect starters and declared setters.
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (node.moduleSpecifier.text === "react" && clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if ((el.propertyName ?? el.name).text === "startTransition") {
              starters.add(el.name.text);
            }
          }
        } else reactNs = clause.namedBindings.name.text;
      }
      if (node.moduleSpecifier.text === "react" && clause?.name) {
        reactNs = clause.name.text;
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const fn = calleeName(node.initializer.expression);
      const second = node.name.elements[1];
      if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) {
        if (fn === "useTransition") starters.add(second.name.text);
        if (fn === "useState" || fn === "useReducer") setters.add(second.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(src);

  const isStarterCall = (n: ts.Node): n is ts.CallExpression => {
    if (!ts.isCallExpression(n)) return false;
    const c = n.expression;
    if (ts.isIdentifier(c)) return starters.has(c.text);
    return (
      ts.isPropertyAccessExpression(c) &&
      c.name.text === "startTransition" &&
      ts.isIdentifier(c.expression) &&
      c.expression.text === reactNs
    );
  };

  const isSetterName = (name: string) =>
    setters.has(name) || (!NOT_SETTERS.has(name) && /^set[A-Z]/.test(name));

  /** A function passed to a timer / scheduler, or used as an event handler. */
  const isDeferred = (fn: ts.Node): boolean => {
    const p = fn.parent;
    if (!p) return false;
    if (ts.isCallExpression(p) && p.arguments.includes(fn as ts.Expression)) {
      const name = calleeName(p.expression);
      return !!name && (DEFERRED_CALLS.has(name) || name === "addEventListener");
    }
    return ts.isJsxExpression(p) && !!p.parent && ts.isJsxAttribute(p.parent);
  };

  const hits = new Map<string, Hit>();

  const analyse = (cb: ts.ArrowFunction | ts.FunctionExpression) => {
    // First await whose nearest enclosing function is the callback itself.
    let firstAwaitEnd = Infinity;
    const findAwait = (n: ts.Node) => {
      if (n !== cb && isFunctionLike(n)) return;
      if (ts.isAwaitExpression(n)) firstAwaitEnd = Math.min(firstAwaitEnd, n.getEnd());
      ts.forEachChild(n, findAwait);
    };
    findAwait(cb);
    if (firstAwaitEnd === Infinity) return;

    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        isSetterName(n.expression.text) &&
        n.getEnd() > firstAwaitEnd
      ) {
        // Exempt only when the setter's NEAREST enclosing function is the
        // synchronous starter callback itself (no other function boundary),
        // or when it sits in a deferred callback (timer / event handler):
        // that runs later, outside the post-await continuation, on purpose.
        let wrapped = false;
        let first = true;
        for (let p: ts.Node | undefined = n.parent; p && p !== cb; p = p.parent) {
          if (!isFunctionLike(p)) continue;
          if (
            first &&
            isFn(p) &&
            !isAsync(p) &&
            p.parent &&
            isStarterCall(p.parent) &&
            p.parent.arguments[0] === p
          ) {
            wrapped = true;
            break;
          }
          first = false;
          if (isDeferred(p)) {
            wrapped = true;
            break;
          }
        }
        if (!wrapped) {
          const line = src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
          hits.set(`${n.getStart(src)}`, {
            file,
            line,
            setter: n.expression.text,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(cb.body);
  };

  const walk = (node: ts.Node) => {
    if (isStarterCall(node)) {
      const arg = node.arguments[0];
      if (arg && isFn(arg) && isAsync(arg)) analyse(arg);
    }
    ts.forEachChild(node, walk);
  };
  walk(src);

  return [...hits.values()].sort((a, b) => a.line - b.line);
}

const HEAD = `import { useState, useTransition } from "react";
export function C() {
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
`;
const scan = (body: string) =>
  scanSource(`${HEAD}${body}\n}`, join(SRC_DIR, "x/demo.tsx")).map((h) => h.setter);

describe("transition-state detector", () => {
  it("flags a bare post-await setter", () => {
    expect(
      scan(`start(async () => { const r = await go(); setError(r.error); });`),
    ).toEqual(["setError"]);
  });

  it("ignores a pre-await setter", () => {
    expect(
      scan(`start(async () => { setError(""); await go(); });`),
    ).toEqual([]);
  });

  it("ignores a post-await setter re-wrapped in start(() => …)", () => {
    expect(
      scan(`start(async () => { await go(); start(() => { setError("x"); }); });`),
    ).toEqual([]);
  });

  it("flags a setter in catch and in finally", () => {
    expect(
      scan(`start(async () => {
        try { await go(); } catch { setError("a"); } finally { setError("b"); }
      });`),
    ).toEqual(["setError", "setError"]);
  });

  it("flags a setter in a .then callback after an await", () => {
    expect(
      scan(`start(async () => { await go(); p.then(() => setError("x")); });`),
    ).toEqual(["setError"]);
  });

  it("flags a setter whose own argument awaits", () => {
    expect(
      scan(`start(async () => { setError(await go()); });`),
    ).toEqual(["setError"]);
  });

  it("does not treat a wrapped async start as a safe wrapper", () => {
    expect(
      scan(`start(async () => { await go(); start(async () => { setError("x"); }); });`),
    ).toEqual(["setError"]);
  });

  it("ignores a callback with no await and a non-transition async function", () => {
    expect(scan(`start(async () => { setError("x"); });`)).toEqual([]);
    expect(scan(`run(async () => { await go(); setError("x"); });`)).toEqual([]);
  });

  it("only counts awaits in the callback itself, not in nested functions", () => {
    expect(
      scan(`start(async () => { const f = async () => { await go(); }; setError("x"); });`),
    ).toEqual([]);
  });

  it("ignores a setter in a setTimeout inside a sync wrap", () => {
    expect(
      scan(`start(async () => { await go(); start(() => { setTimeout(() => setError(""), 5); }); });`),
    ).toEqual([]);
  });

  it("ignores a setter in a setTimeout in the post-await part", () => {
    expect(
      scan(`start(async () => { await go(); setTimeout(() => setError(""), 5); });`),
    ).toEqual([]);
  });

  it("flags a .then setter nested inside a sync wrap (function boundary)", () => {
    expect(
      scan(`start(async () => { await go(); start(() => { p.then(() => setError("x")); }); });`),
    ).toEqual(["setError"]);
  });

  it("does not treat setTimeout/setInterval/setImmediate as setters", () => {
    expect(
      scan(`start(async () => { await go(); setTimeout(fn, 1); setInterval(fn, 1); setImmediate(fn); });`),
    ).toEqual([]);
  });

  it("recognises the imported startTransition", () => {
    const code = `import { startTransition, useState } from "react";
export function C() {
  const [, setX] = useState(0);
  startTransition(async () => { await go(); setX(1); });
}`;
    expect(scanSource(code, join(SRC_DIR, "x/demo.tsx")).map((h) => h.setter)).toEqual([
      "setX",
    ]);
  });

  it("recognises an aliased useTransition starter", () => {
    const code = `import { useState, useTransition } from "react";
export function C() {
  const [, setX] = useState(0);
  const [, startSave] = useTransition();
  startSave(async () => { await go(); setX(1); });
}`;
    expect(scanSource(code, join(SRC_DIR, "x/demo.tsx")).map((h) => h.setter)).toEqual([
      "setX",
    ]);
  });
});

describe("repo: no post-await state setter outside the transition", () => {
  const hits = walkFiles(SRC_DIR).flatMap((f) => scanSource(readFileSync(f, "utf8"), f));
  const keyOf = (h: Hit) => `${h.file}#${h.setter}`;

  it("has no un-allowlisted offender", () => {
    const offenders = hits
      .filter((h) => !(keyOf(h) in ALLOWED))
      .map((h) => `${h.file}:${h.line} ${h.setter}`);
    expect(
      offenders,
      "wrap post-await setters in start(() => { … }) — see the header of this file",
    ).toEqual([]);
  });

  it("keeps every allowlist entry live and justified", () => {
    const live = new Set(hits.map(keyOf));
    for (const [key, why] of Object.entries(ALLOWED)) {
      expect(live.has(key), `stale allowlist entry ${key}`).toBe(true);
      expect(why.length, `${key} needs a real why`).toBeGreaterThan(40);
    }
  });
});
