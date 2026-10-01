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
 * `useReducer` destructure, a state-setting method of a custom hook listed in
 * `STATE_HOOK_METHODS` such as `outcome.show(…)`, or — as a fallback — any
 * `setXxx` identifier) that
 * executes after the first `await` of that callback, including inside nested
 * callbacks, try/catch/finally and `.then` bodies. A setter inside a nested
 * synchronous `X(() => …)` is fine, and is how the fix is written.
 *
 * A setter counts as "after the await" when it follows the callback's first
 * await, sits in a `.then/.catch/.finally` callback, or follows the first await
 * of a nested async function. Aliases are resolved: `useTransition as x`,
 * `startTransition as x`, `React.*`, and `const y = setX;` / `const run = start;`.
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

/**
 * Custom hooks whose returned object's methods set React state, so a post-await
 * call is the same bug as a bare setter: `const outcome = useReleaseOutcome();`
 * then `outcome.show(text)` after an await showed a refusal beside a button
 * still reading "Releasing…" (the bulk-action-bar flake, 2026-10-01).
 */
const STATE_HOOK_METHODS: Record<string, readonly string[]> = {
  useReleaseOutcome: ["show"],
  // Both row-selection contexts (visits/[id] and components/staff/row-selection).
  useRowSelection: ["clear", "clearIds", "clearKeys", "toggle"],
};

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
  // `const outcome = useReleaseOutcome();` → outcome ↦ its state-setting methods.
  const stateObjects = new Map<string, readonly string[]>();
  let reactNs: string | null = null;
  // Local names of React hooks, so `import { useTransition as usePending }` resolves.
  const transitionHooks = new Set(["useTransition"]);
  const stateHooks = new Set(["useState", "useReducer"]);
  // `const alias = other;` declarations, resolved to a fixpoint after pass 1.
  const aliasDecls: { name: string; target: string }[] = [];

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
            const imported = (el.propertyName ?? el.name).text;
            if (imported === "startTransition") starters.add(el.name.text);
            if (imported === "useTransition") transitionHooks.add(el.name.text);
            if (imported === "useState" || imported === "useReducer") {
              stateHooks.add(el.name.text);
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
        if (fn && transitionHooks.has(fn)) starters.add(second.name.text);
        if (fn && stateHooks.has(fn)) setters.add(second.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const fn = calleeName(node.initializer.expression);
      const methods = fn ? STATE_HOOK_METHODS[fn] : undefined;
      if (methods && ts.isIdentifier(node.name)) stateObjects.set(node.name.text, methods);
      if (methods && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = (el.propertyName ?? el.name) as ts.Node;
          if (ts.isIdentifier(key) && methods.includes(key.text) && ts.isIdentifier(el.name)) {
            setters.add(el.name.text);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer)
    ) {
      aliasDecls.push({ name: node.name.text, target: node.initializer.text });
    }
    ts.forEachChild(node, collect);
  };
  collect(src);

  // `const reportError = setError;` / `const run = start;` (and chains of them).
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, target } of aliasDecls) {
      if (starters.has(target) && !starters.has(name)) {
        starters.add(name);
        changed = true;
      }
      if (setters.has(target) && !setters.has(name)) {
        setters.add(name);
        changed = true;
      }
    }
  }

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

  /** The setter's display name when `call` sets state: `setX(…)` or `outcome.show(…)`. */
  const setterCalled = (call: ts.CallExpression): string | null => {
    const c = call.expression;
    if (ts.isIdentifier(c)) return isSetterName(c.text) ? c.text : null;
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
      const methods = stateObjects.get(c.expression.text);
      if (methods?.includes(c.name.text)) return `${c.expression.text}.${c.name.text}`;
    }
    return null;
  };

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

  /** End of the first await whose nearest enclosing function is `fn` itself. */
  const firstAwaitEndOf = (fn: ts.Node): number => {
    let end = Infinity;
    const findAwait = (n: ts.Node) => {
      if (n !== fn && isFunctionLike(n)) return;
      if (ts.isAwaitExpression(n)) end = Math.min(end, n.getEnd());
      ts.forEachChild(n, findAwait);
    };
    findAwait(fn);
    return end;
  };

  /** A function passed to `.then` / `.catch` / `.finally`: runs after suspension. */
  const isPromiseCallback = (fn: ts.Node): boolean => {
    const p = fn.parent;
    return (
      !!p &&
      ts.isCallExpression(p) &&
      p.arguments.includes(fn as ts.Expression) &&
      ts.isPropertyAccessExpression(p.expression) &&
      ["then", "catch", "finally"].includes(p.expression.name.text)
    );
  };

  const analyse = (cb: ts.ArrowFunction | ts.FunctionExpression) => {
    const firstAwaitEnd = firstAwaitEndOf(cb);

    /**
     * Does `n` execute after a suspension? Either it follows the callback's
     * own first await, or it sits in a promise-chain callback, or it follows
     * the first await of a nested async function (which suspends by itself,
     * however the outer callback awaits it).
     */
    const afterSuspension = (n: ts.Node): boolean => {
      if (n.getEnd() > firstAwaitEnd) return true;
      for (let p: ts.Node | undefined = n.parent; p && p !== cb; p = p.parent) {
        if (!isFunctionLike(p)) continue;
        if (isPromiseCallback(p)) return true;
        if (
          isFn(p) &&
          isAsync(p) &&
          !(p.parent && isStarterCall(p.parent) && p.parent.arguments[0] === p) &&
          n.getEnd() > firstAwaitEndOf(p)
        ) {
          return true;
        }
      }
      return false;
    };

    const visit = (n: ts.Node) => {
      const setter = ts.isCallExpression(n) ? setterCalled(n) : null;
      if (setter && afterSuspension(n)) {
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
            setter,
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

  describe("awaited promise callbacks and nested async functions", () => {
    it("flags a setter in a .then callback inside the awaited expression", () => {
      expect(
        scan(`start(async () => { await go().then(() => setError("x")); });`),
      ).toEqual(["setError"]);
    });

    it("flags a setter in .catch / .finally callbacks inside the awaited expression", () => {
      expect(
        scan(`start(async () => { await go().catch(() => setError("a")).finally(() => setError("b")); });`),
      ).toEqual(["setError", "setError"]);
    });

    it("flags a setter after the inner await of an awaited Promise.all(map(async))", () => {
      expect(
        scan(`start(async () => {
          await Promise.all(items.map(async (i) => { await f(i); setError("x"); }));
        });`),
      ).toEqual(["setError"]);
    });

    it("flags a setter after the inner await of a nested async arrow", () => {
      expect(
        scan(`start(async () => {
          const inner = async () => { await go(); setError("x"); };
          await inner();
        });`),
      ).toEqual(["setError"]);
    });

    it("flags a nested async setter even when the outer callback never awaits", () => {
      expect(
        scan(`start(async () => { items.forEach(async (i) => { await f(i); setError("x"); }); });`),
      ).toEqual(["setError"]);
    });

    it("ignores a setter before the inner await of a nested async function", () => {
      expect(
        scan(`start(async () => {
          await Promise.all(items.map(async (i) => { setError("x"); await f(i); }));
        });`),
      ).toEqual([]);
    });

    it("accepts a setter re-wrapped inside a .then / nested async function", () => {
      expect(
        scan(`start(async () => {
          await go().then(() => { start(() => setError("x")); });
          await Promise.all(items.map(async (i) => { await f(i); start(() => setError("y")); }));
        });`),
      ).toEqual([]);
    });
  });

  describe("aliases", () => {
    const at = (code: string) =>
      scanSource(code, join(SRC_DIR, "x/demo.tsx")).map((h) => h.setter);

    it("resolves an aliased useTransition import", () => {
      expect(
        at(`import { useState, useTransition as usePending } from "react";
export function C() {
  const [, setX] = useState(0);
  const [, run] = usePending();
  run(async () => { await go(); setX(1); });
}`),
      ).toEqual(["setX"]);
    });

    it("resolves React.useTransition via a default or namespace import", () => {
      for (const imp of [`import React from "react";`, `import * as React from "react";`]) {
        expect(
          at(`${imp}
export function C() {
  const [, setX] = React.useState(0);
  const [, run] = React.useTransition();
  run(async () => { await go(); setX(1); });
}`),
        ).toEqual(["setX"]);
      }
    });

    it("resolves startTransition imported under another name and React.startTransition", () => {
      expect(
        at(`import { startTransition as st, useState } from "react";
export function C() {
  const [, setX] = useState(0);
  st(async () => { await go(); setX(1); });
}`),
      ).toEqual(["setX"]);
      expect(
        at(`import React, { useState } from "react";
export function C() {
  const [, setX] = useState(0);
  React.startTransition(async () => { await go(); setX(1); });
}`),
      ).toEqual(["setX"]);
    });

    it("resolves an aliased useState import for a non-set* setter name", () => {
      expect(
        at(`import { useState as useS, useTransition } from "react";
export function C() {
  const [, update] = useS(0);
  const [, run] = useTransition();
  run(async () => { await go(); update(1); });
}`),
      ).toEqual(["update"]);
    });

    it("resolves a simple setter alias, and chained aliases", () => {
      expect(
        scan(`const reportError = setError;
        start(async () => { await go(); reportError("x"); });`),
      ).toEqual(["reportError"]);
      expect(
        scan(`const a = setError; const b = a;
        start(async () => { await go(); b("x"); });`),
      ).toEqual(["b"]);
    });

    it("resolves a starter alias", () => {
      expect(
        scan(`const run = start;
        run(async () => { await go(); setError("x"); });`),
      ).toEqual(["setError"]);
    });

    it("accepts an aliased setter re-wrapped in the transition", () => {
      expect(
        scan(`const reportError = setError;
        start(async () => { await go(); start(() => reportError("x")); });`),
      ).toEqual([]);
    });
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

describe("state-setting hook methods (STATE_HOOK_METHODS)", () => {
  const OUTCOME = `const outcome = useReleaseOutcome();\n`;

  it("flags outcome.show / outcome?.show after an await", () => {
    expect(
      scan(`${OUTCOME}start(async () => { const r = await go(); outcome.show(r.error); });`),
    ).toEqual(["outcome.show"]);
    expect(
      scan(`${OUTCOME}start(async () => { const r = await go(); if (outcome) outcome?.show(r.error); });`),
    ).toEqual(["outcome.show"]);
  });

  it("ignores outcome.show re-wrapped in start(() => …) or called before the await", () => {
    expect(
      scan(`${OUTCOME}start(async () => { const r = await go(); start(() => outcome.show(r.error)); });`),
    ).toEqual([]);
    expect(scan(`${OUTCOME}start(async () => { outcome.show("…"); await go(); });`)).toEqual([]);
  });

  it("flags a destructured show, and ignores other methods or objects", () => {
    expect(
      scan(`const { show: announce } = useReleaseOutcome();
start(async () => { await go(); announce("x"); });`),
    ).toEqual(["announce"]);
    expect(
      scan(`${OUTCOME}const other = useOther();
start(async () => { await go(); outcome.hide(); other.show("x"); });`),
    ).toEqual([]);
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
