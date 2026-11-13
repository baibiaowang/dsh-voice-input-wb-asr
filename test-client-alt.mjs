// Drive the Client half in Node: fake the module loader, a tiny hook runtime and
// the browser APIs it touches, then press Alt and check what reaches the Host.
//
//   node test-client-alt.mjs
//
// No dsh runtime, no browser. It proves the Alt path opens the microphone, ends
// the take on keyup, inserts the transcript, and cancels on Alt+<other key>.
import { readFileSync } from "node:fs";

/* --------------------------------------------------------------- fake React */

let rendering = null;

function createElement(type, props, ...children) {
  const element = { type, props: props ?? {}, children };
  if (element.props.ref && typeof element.props.ref === "object") {
    element.props.ref.current = makeButtonStub();
  }
  return element;
}

const Fragment = Symbol("Fragment");

function makeHookRuntime() {
  const hooks = [];
  let index = 0;
  let pending = [];
  let rerender = null;

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
        rerender?.();
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
    rendering = Component;
    index = 0;
    pending = [];
    const tree = Component(props);
    for (const slot of pending) {
      const hook = hooks[slot];
      if (hook.ran && sameDeps(hook.deps, hook.deps) && hook.deps !== undefined) continue;
      if (hook.ran && hook.deps !== undefined) continue;
      hook.cleanup?.();
      hook.cleanup = hook.effect();
      hook.ran = true;
    }
    return tree;
  }

  function schedule(fn) {
    rerender = () => {
      rerender = null;
      fn();
    };
  }

  return { React, render, schedule, hooks };
}

/* ------------------------------------------------------------ fake browser */

const listeners = new Map();

/* ------------------------------------------------------- fake composer tree */

/**
 * button -> toolRow -> composerBox -> composerCard
 *
 * `composerBox` is the ancestor the bundle has to find by looking for an editor
 * inside it, which is what gates Alt on the caret being in the composer.
 */
const editor = { id: "editor" };
const composerBox = {
  id: "composer-box",
  contains: (node) => node === composerBox || node === editor || node === toolRow || node === buttonNode,
  querySelector: (selector) => (selector.includes("contenteditable") ? editor : null),
};
const toolRow = { id: "tool-row", parentElement: composerBox, querySelector: () => null };
const buttonNode = {
  id: "mic-button",
  parentElement: toolRow,
  offsetParent: {},
  getBoundingClientRect: () => ({ left: 500, top: 600, width: 28, height: 28 }),
  contains: (node) => node === buttonNode,
};
const elsewhere = { id: "sidebar" };

function makeButtonStub() {
  return buttonNode;
}

const windowStub = {
  innerWidth: 1200,
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  },
};

function dispatch(type, event) {
  for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
}

const documentStub = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: "" }),
  head: { appendChild() {} },
  body: { id: "body" },
  documentElement: { id: "html" },
  // The caret starts in the editor, which is the normal dictation position.
  activeElement: editor,
};

let audioHandler = null;
let contextClosed = 0;

class FakeContext {
  constructor() {
    this.sampleRate = 48000;
    this.state = "running";
    this.destination = {};
  }
  resume() { return Promise.resolve(); }
  close() { contextClosed += 1; return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() {
    return {
      connect() {},
      disconnect() {},
      set onaudioprocess(fn) { audioHandler = fn; },
      get onaudioprocess() { return audioHandler; },
    };
  }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
}

const media = {
  tracksStopped: 0,
  async getUserMedia() {
    return {
      getTracks: () => [{ stop: () => { media.tracksStopped += 1; } }],
    };
  },
};

let fetchCalls = [];
let fetchReply = "这是一段语音识别的测试";
let fetchStatus = 200;
let fetchAborted = 0;
/** When set, the next call returns this promise instead of resolving at once. */
let deferredCall = null;

globalThis.window = Object.assign(windowStub, { AudioContext: FakeContext, webkitAudioContext: FakeContext });
globalThis.document = documentStub;
// Node 24 exposes a getter-only `navigator`; the bundle receives this stub as an
// argument, so the global one does not have to change.
const navigatorStub = { mediaDevices: media };
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  const signal = init?.signal;
  if (signal !== undefined) {
    signal.addEventListener('abort', () => { fetchAborted += 1; }, { once: true });
  }
  if (deferredCall !== null) {
    const hold = deferredCall;
    deferredCall = null;
    return hold;
  }
  return { ok: fetchStatus === 200, status: fetchStatus, json: async () => ({ text: fetchReply }) };
};

const loaded = [];
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) { loaded.push({ id, factory }); },
};

/* ---------------------------------------------------------------- run it */

const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
new Function("window", "document", "navigator", "fetch", source)(
  globalThis.window, documentStub, navigatorStub, globalThis.fetch,
);

if (loaded.length !== 1) throw new Error("client bundle did not register exactly one module");
const runtime = makeHookRuntime();
const bundle = loaded[0].factory((name) => {
  if (name === "react") return runtime.React;
  if (name === "react-dom") throw new Error("react-dom is absent in this fake table");
  throw new Error("unexpected require: " + name);
});

const inserted = [];
const inputActions = {
  captureInsertion: () => ({ span: "fake" }),
  insertText: (text, span) => { inserted.push({ text, span }); return true; },
};

const registrations = [];
const ctx = {
  effect(fn) { return fn(); },
  slots: {
    inject(name, contribute) { registrations.push(name); contribute(); },
    register(registration, Component) { registrations.push({ ...registration, Component }); return () => {}; },
  },
};

bundle.apply(ctx);
const registration = registrations.find((entry) => typeof entry === "object");
console.log("module name =", bundle.name, "| slot =", registration.name, "| id =", registration.id);

const HoldToTalk = registration.Component;
let tree = runtime.render(HoldToTalk, { inputActions });
console.log("initial label =", tree.props["aria-label"]);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Hold long enough for ALT_ARM_MS (180 ms) to elapse and the microphone to open. */
const arm = () => new Promise((resolve) => setTimeout(resolve, 260));
/** Past MIN_HOLD_MS (320 ms) so the take counts as speech rather than a tap. */
const speak = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
/** One audio callback of fake speech. */
function say() {
  const frame = new Float32Array(4096).map((_, j) => Math.sin(j / 8) * 0.2);
  if (audioHandler !== null) audioHandler({ inputBuffer: { getChannelData: () => frame } });
}

function reset() {
  inserted.length = 0;
  fetchCalls = [];
  audioHandler = null;
}
/* --- case 1: hold Alt, speak, release --------------------------------- */
runtime.schedule(() => { tree = runtime.render(HoldToTalk, { inputActions }); });
reset();
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
if (audioHandler === null) throw new Error("Alt did not open the microphone");
say();
say();
await speak();
dispatch("keyup", { key: "Alt" });
await settle();
await settle();
console.log("case1 hold+speak -> fetch", fetchCalls.length, "| inserted", JSON.stringify(inserted.map((e) => e.text)));
console.log("case1 url =", fetchCalls[0]?.url, "| tracks stopped =", media.tracksStopped, "| contexts closed =", contextClosed);

/* --- case 2: a quick Alt tap is a shortcut, not dictation ------------- */
reset();
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await settle();
dispatch("keyup", { key: "Alt" });
await settle();
await settle();
console.log("case2 quick tap -> microphone opened =", audioHandler !== null, "| fetch", fetchCalls.length, "| inserted", inserted.length);

/* --- case 3: Alt + another key is a shortcut, not dictation ----------- */
reset();
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
const opened3 = audioHandler !== null;
say();
dispatch("keydown", { key: "Tab", repeat: false, isComposing: false, preventDefault() {} });
dispatch("keyup", { key: "Alt" });
await settle();
await settle();
console.log("case3 Alt+Tab -> microphone opened =", opened3, "| fetch", fetchCalls.length, "| inserted", inserted.length, "| aborted", fetchAborted);

/* --- case 4: window blur cancels the take ---------------------------- */
reset();
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
say();
dispatch("blur", {});
await settle();
await settle();
console.log("case4 blur -> fetch", fetchCalls.length, "| inserted", inserted.length, "| aborted", fetchAborted);

/* --- case 5: auto-repeat must not start a second take ---------------- */
reset();
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
const opened5 = audioHandler !== null;
say();
dispatch("keydown", { key: "Alt", repeat: true, isComposing: false, preventDefault() {} });
dispatch("keydown", { key: "Alt", repeat: true, isComposing: false, preventDefault() {} });
await speak();
dispatch("keyup", { key: "Alt" });
await settle();
await settle();
console.log("case5 repeat -> microphone opened =", opened5, "| fetch", fetchCalls.length, "| inserted", inserted.length);

/* --- case 6: the caret is outside the composer, so Alt must stay inert -- */
reset();
documentStub.activeElement = elsewhere;
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
console.log("case6 caret outside -> microphone opened =", audioHandler !== null, "| fetch", fetchCalls.length);
dispatch("keyup", { key: "Alt" });
await settle();
await settle();

/* --- case 7: the caret is on the microphone button itself -------------- */
reset();
documentStub.activeElement = buttonNode;
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
const opened7 = audioHandler !== null;
say();
await speak();
dispatch("keyup", { key: "Alt" });
await settle();
await settle();
console.log("case7 caret on button -> microphone opened =", opened7, "| fetch", fetchCalls.length, "| inserted", inserted.length);

/* --- case 8: the upload dies on release, so the take is re-posted ----- */
reset();
documentStub.activeElement = buttonNode;
// The streaming request fails right as the button comes up: this is the window
// where `streamBroken` has not been set yet, so the fallback must rescue it.
deferredCall = Promise.reject(new Error("network dropped"));
deferredCall.catch(() => {});
dispatch("keydown", { key: "Alt", repeat: false, isComposing: false, preventDefault() {} });
await arm();
say();
say();
await speak();
dispatch("keyup", { key: "Alt" });
await settle();
await settle();
await settle();
console.log("case8 stream died on release -> fetch", fetchCalls.length, "| inserted", JSON.stringify(inserted.map((e) => e.text)));

console.log("done");
