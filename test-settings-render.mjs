// Render the bundle's settings card in Node and check the two region checkboxes.
//
//   node test-settings-render.mjs
//
// It proves the card shows one ticked region (international by default), that
// ticking the domestic one posts activeRegion=cn, and that the stated account
// count follows the region.
import { readFileSync } from "node:fs";

/* --------------------------------------------------------------- fake React */

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children };
}
const Fragment = Symbol("Fragment");

function makeHookRuntime() {
  const hooks = [];
  let index = 0;
  let pending = [];
  let repaint = null;

  const React = {
    createElement,
    Fragment,
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        const value = typeof next === "function" ? next(hooks[slot]) : next;
        if (Object.is(value, hooks[slot])) return;
        hooks[slot] = value;
        if (repaint !== null) repaint();
      };
      return [hooks[slot], set];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useEffect(effect, deps) {
      const slot = index++;
      const prev = hooks[slot];
      // A repaint must not fire the load effect again, or a fetched reply would
      // re-trigger the fetch forever.
      if (prev && prev.ran && sameDeps(prev.deps, deps)) {
        hooks[slot] = { ...prev, effect, deps };
        return;
      }
      hooks[slot] = { effect, deps, cleanup: undefined, ran: false };
      pending.push(slot);
    },
    useCallback(fn, deps) {
      const slot = index++;
      const prev = hooks[slot];
      if (prev && sameDeps(prev.deps, deps)) return prev.fn;
      hooks[slot] = { fn, deps };
      return fn;
    },
  };

  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    return a.every((value, i) => Object.is(value, b[i]));
  }

  function render(Component, props) {
    index = 0;
    pending = [];
    const tree = Component(props);
    for (const slot of pending) {
      const hook = hooks[slot];
      if (hook.ran && hook.deps !== undefined) continue;
      hook.cleanup?.();
      hook.cleanup = hook.effect();
      hook.ran = true;
    }
    return tree;
  }

  /** Re-run `fn` after every state change, so async replies land in the tree. */
  function schedule(fn) {
    repaint = fn;
  }

  return { React, render, schedule };
}

/* ------------------------------------------------------------ fake browser */

const windowStub = {
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
};
const documentStub = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: "" }),
  head: { appendChild() {} },
  body: {},
  documentElement: {},
  activeElement: null,
};
globalThis.window = windowStub;
globalThis.document = documentStub;

const fetchLog = [];
let config = { region: "ai", accounts: 7, minHoldMs: 320, effect: true, ringColor: "#00ff9d", language: "auto" };
const posts = [];
globalThis.fetch = async (url, init) => {
  fetchLog.push((init?.method ?? "GET") + " " + String(url));
  if (init?.method === "POST") {
    const body = JSON.parse(init.body);
    posts.push(body);
    if ("activeRegion" in body) {
      const region = body.activeRegion === "cn" ? "cn" : "ai";
      config = { ...config, region, accounts: region === "cn" ? 5 : 7 };
    } else {
      config = { ...config, ...body };
    }
    return { ok: true, status: 200, json: async () => ({ values: config }) };
  }
  return { ok: true, status: 200, json: async () => ({ ...config }) };
};

/* ------------------------------------------------------------------- load it */

const loaded = [];
windowStub.__ModuleLoader__ = { load({ id, factory }) { loaded.push({ id, factory }); } };
const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
new Function("window", "document", "navigator", "fetch", source)(windowStub, documentStub, {}, globalThis.fetch);

const runtime = makeHookRuntime();
const bundle = loaded[0].factory((name) => {
  if (name === "react") return runtime.React;
  if (name === "react-dom") throw new Error("absent");
  throw new Error("unexpected require: " + name);
});

const registrations = [];
const ctx = {
  effect() { return () => {}; },
  inject(names, fn) { /* locale service absent: the built-in table is used */ },
  slots: {
    inject(name, contribute) { contribute(); },
    register(registration, Component) { registrations.push({ registration, Component }); return () => {}; },
  },
};
bundle.apply(ctx);

const configEntry = registrations.find((entry) => entry.registration.name === "plugins.bundle.config");
if (!configEntry) throw new Error("settings card was not registered");
if (configEntry.registration.key !== "dsh-voice-input-wb-asr") throw new Error("wrong settings key: " + configEntry.registration.key);

/* ------------------------------------------------------------------- helpers */

/** Depth-first walk of the element tree built by the fake createElement. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  if (typeof node !== "object") { out.push({ text: String(node) }); return out; }
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}
const inputs = (tree) => walk(tree).filter((n) => n.type === "input");
const texts = (tree) => walk(tree).filter((n) => typeof n.text === "string").map((n) => n.text).join(" | ");
const ticks = (tree) => inputs(tree).filter((n) => n.props.type === "checkbox").map((n) => n.props.checked);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/* ------------------------------------------------------------------ case 1 */

// The registered entry is a thin wrapper; the card itself is its single child.
const cardElement = runtime.render(configEntry.Component, { view: "full" });
const paint = () => runtime.render(cardElement.type, cardElement.props);

let tree = null;
runtime.schedule(() => { tree = paint(); });
tree = paint();
await settle();
if (tree === null) throw new Error("card never rendered");
const firstTicks = ticks(tree);
console.log("1 default ticks        :", JSON.stringify(firstTicks));
if (firstTicks[0] !== true || firstTicks[1] !== false) throw new Error("international must be ticked by default");
const firstLine = texts(tree).split(" | ").find((s) => s.includes("账号")) ?? "(none)";
console.log("  account line         :", firstLine);
if (!firstLine.includes("7")) throw new Error("international count should be 7, got: " + firstLine);

/* ------------------------------------------------------------------ case 2 */

const boxes = inputs(tree).filter((n) => n.props.type === "checkbox");
// [0] international region, [1] domestic region, [2] effect toggle
runtime.schedule(() => { tree = paint(); });
boxes[1].props.onChange({ target: { checked: true } });
await settle();
console.log("2 posted to host       :", JSON.stringify(posts));
console.log("  ticks after tick cn  :", JSON.stringify(ticks(tree)));
const cnLine = texts(tree).split(" | ").find((s) => s.includes("账号")) ?? "(none)";
console.log("  account line         :", cnLine);
if (!cnLine.includes("5")) throw new Error("domestic count should be 5, got: " + cnLine);
if (posts.length !== 1 || posts[0].activeRegion !== "cn") throw new Error("ticking the domestic box must post activeRegion=cn");
const afterTicks = ticks(tree);
if (afterTicks[0] !== false || afterTicks[1] !== true) throw new Error("domestic must become the only ticked box");

/* ------------------------------------------------------------------ case 3 */

runtime.schedule(() => { tree = paint(); });
inputs(tree).filter((n) => n.props.type === "checkbox")[0].props.onChange({ target: { checked: true } });
await settle();
console.log("3 back to ai posted    :", JSON.stringify(posts.map((p) => p.activeRegion ?? p)));
console.log("  ticks after tick ai  :", JSON.stringify(ticks(tree)));
if (posts[1].activeRegion !== "ai") throw new Error("ticking the international box must post activeRegion=ai");

/* ------------------------------------------------------------------ case 4 */

const untick = inputs(tree).filter((n) => n.props.type === "checkbox")[1];
const before = posts.length;
untick.props.onChange({ target: { checked: false } });
await settle();
console.log("4 untick is a no-op    :", posts.length === before ? "yes" : "NO");
if (posts.length !== before) throw new Error("unticking the inactive box must not save anything");

console.log("\nsettings card OK");
