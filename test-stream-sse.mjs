// SSE test: /stream pushes interim transcripts while the take is open, then one
// settled text. The preview is never what gets inserted - the final event is.
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

function makeCtx() {
  const routes = new Map();
  const live = {};
  const ctx = {
    effect(fn) { return fn(); },
    inject(names, fn) { return names.every((n) => ctx[n] !== undefined) ? fn(ctx) : undefined; },
    get(name) { return ctx[name]; },
    settings: { async update(id, patch) { Object.assign(live, patch); }, configure() { return () => {}; } },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    speechToText: { register() { return async () => {}; } },
  };
  return { ctx, live, routes };
}

const plugin = await import("./index.js");
const host = makeCtx();
plugin.apply(host.ctx, host.live);
const handler = host.routes.get("/plugins/dsh-voice-input-wb-asr/stream");

const pcm = readFileSync(process.argv[2]);
const req = new Readable({ read() {} });
req.method = "POST";
req.headers = { accept: "text/event-stream", "content-type": "application/octet-stream" };
const res = new EventEmitter();
res.writableEnded = false;
res.destroyed = false;
res.headersSent = false;
res.statusCode = 0;
const arrivals = [];
let body = "";
res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
res.flushHeaders = () => {};
res.write = (chunk) => {
  const piece = chunk.toString();
  body += piece;
  for (const block of piece.split("\n\n")) {
    if (block.trim() !== "") arrivals.push({ at: Date.now(), block });
  }
  return true;
};
res.end = (chunk) => {
  if (chunk !== undefined) body += chunk.toString();
  res.writableEnded = true;
  res.emit("finish");
};
const done = new Promise((r) => res.once("finish", r));

// Feed in half-second slices so the recognizer hears a take growing, the way
// the browser uploads while the button is held.
const SLICE = 16000;
(async () => {
  for (let offset = 0; offset < pcm.length; offset += SLICE) {
    req.push(pcm.subarray(offset, Math.min(pcm.length, offset + SLICE)));
    await new Promise((r) => setTimeout(r, 120));
  }
  req.push(null);
})();

const startedAt = Date.now();
await handler(req, res);
await done;
const elapsed = Date.now() - startedAt;

const events = body.split("\n\n").filter((block) => block.trim() !== "")
  .map((block) => JSON.parse(block.replace(/^data: /, "")));
const partials = events.filter((event) => event.final !== true && typeof event.text === "string");
const final = events.find((event) => event.final === true);
const seen = new Set(partials.map((event) => event.text));

console.log("status", res.statusCode, "| events", events.length, "| partials", partials.length, "| distinct", seen.size, "| took", elapsed + "ms");
for (const arrival of arrivals) {
  const parsed = JSON.parse(arrival.block.replace(/^data: /, ""));
  console.log("  +" + (arrival.at - startedAt) + "ms", parsed.final === true ? "final" : "partial", JSON.stringify(String(parsed.text ?? "").slice(-24)));
}
if (partials.length > 0) {
  console.log("first partial:", JSON.stringify(partials[0].text.slice(0, 30)));
  console.log("last  partial:", JSON.stringify(partials[partials.length - 1].text.slice(-30)));
}
if (final !== undefined) {
  console.log("final        :", JSON.stringify(final.text.slice(0, 50)), "| audio", final.audioSeconds.toFixed(1) + "s");
}
const ok = res.statusCode === 200
  && partials.length >= 1
  && seen.size >= 1
  && final !== undefined
  && final.text.includes("语音识别")
  && arrivals.length > 1
  && final.audioSeconds > 1;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
