// Gate test: default is international; the domestic build is off unless enabled.
// The harness mirrors the Host: settings.update mutates the live config object the
// plugin reads through getConfig(), so a read after a write reflects it.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const wav = readFileSync(process.argv[2]);
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
const plugin = await import("./index.js");
plugin.apply(ctx, live);
const config = routes.get("/plugins/dsh-voice-input-wb-asr/config");

function exchange(method, body) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = {};
  const res = new EventEmitter();
  res.writableEnded = false;
  res.chunks = [];
  res.writeHead = (s) => { res.statusCode = s; };
  res.end = (p) => { if (p !== undefined) res.chunks.push(Buffer.from(p)); res.writableEnded = true; res.emit("finish"); };
  setImmediate(() => {
    if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
  });
  return { req, res, done: new Promise((r) => res.once("finish", r)) };
}
async function call(method, body) {
  const ex = exchange(method, body);
  await config(ex.req, ex.res);
  await ex.done;
  const parsed = JSON.parse(Buffer.concat(ex.res.chunks).toString());
  return { status: ex.res.statusCode, body: parsed.values ?? parsed };
}
const show = (label, r) => console.log(label, r.status, JSON.stringify(r.body));

show("1 default (ai)     :", await call("GET"));
show("2 tick cn          :", await call("POST", { activeRegion: "cn" }));
show("3 tick cn again    :", await call("POST", { activeRegion: "cn" }));
show("4 tick ai          :", await call("POST", { activeRegion: "ai" }));
show("5 bogus value      :", await call("POST", { activeRegion: "xx" }));
