// Gate test: the host's request gate answers first, and a host without it
// keeps the loopback fence exactly as before.
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

function makeCtx({ connection }) {
  const routes = new Map();
  const live = {};
  const ctx = {
    effect(fn) { return fn(); },
    inject(names, fn) { return names.every((n) => ctx[n] !== undefined) ? fn(ctx) : undefined; },
    get(name) { return ctx[name]; },
    settings: {
      async update(entryId, patch) { Object.assign(live, patch); },
      configure() { return () => {}; },
    },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    speechToText: { register() { return async () => {}; } },
  };
  if (connection !== undefined) ctx.connection = connection;
  return { ctx, live, routes };
}

const plugin = await import("./index.js");

function exchange(method, headers = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = { ...headers };
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.chunks = [];
  res.writeHead = (s) => { res.statusCode = s; };
  res.end = (p) => { if (p !== undefined) res.chunks.push(Buffer.from(p)); res.writableEnded = true; res.emit("finish"); };
  setImmediate(() => req.push(null));
  return { req, res, done: new Promise((r) => res.once("finish", r)) };
}

async function call(handler, method, headers) {
  const ex = exchange(method, headers);
  await handler(ex.req, ex.res);
  await ex.done;
  return { status: ex.res.statusCode, body: JSON.parse(Buffer.concat(ex.res.chunks).toString()) };
}

const route = "/plugins/dsh-voice-input-wb-asr/config";

// 1. Host publishes the gate: its verdict wins over the loopback check, and an
//    admitted request still reaches the handler.
const gated = makeCtx({
  connection: {
    requestRejection(req) {
      const origin = req.headers.origin;
      if (origin === undefined) return undefined;
      return origin === "http://127.0.0.1:5173" ? undefined : 403;
    },
  },
});
plugin.apply(gated.ctx, gated.live);
const gatedConfig = gated.routes.get(route);
const a = await call(gatedConfig, "GET", {});
const b = await call(gatedConfig, "GET", { origin: "http://127.0.0.1:5173" });
const c = await call(gatedConfig, "GET", { origin: "http://localhost:3000" });
const d = await call(gatedConfig, "POST", { origin: "https://evil.example" });

// 2. Host without the service: the loopback fence decides, exactly as before.
const legacy = makeCtx({});
plugin.apply(legacy.ctx, legacy.live);
const legacyConfig = legacy.routes.get(route);
const e = await call(legacyConfig, "GET", {});
const f = await call(legacyConfig, "GET", { origin: "http://localhost:3000" });
const g = await call(legacyConfig, "GET", { origin: "https://evil.example" });

const show = (label, r) => console.log(label, r.status, JSON.stringify(r.body).slice(0, 70));
show("1 gated, no origin        :", a);
show("2 gated, loopback:5173    :", b);
show("3 gated, localhost:3000   :", c);
show("4 gated, https origin     :", d);
show("5 legacy, no origin       :", e);
show("6 legacy, localhost:3000  :", f);
show("7 legacy, https origin    :", g);

const ok = a.status === 200 && b.status === 200 && c.status === 403 && d.status === 403
  && e.status === 200 && f.status === 200 && g.status === 403
  && c.body.error === "not-admitted" && d.body.error === "not-admitted";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
