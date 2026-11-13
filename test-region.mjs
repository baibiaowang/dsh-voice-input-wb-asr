// Drive the Host half's press-to-talk routes without a dsh runtime.
//
//   node test-stream.mjs <wav16k>
//
// Mocks ctx.effect / ctx.inject / ctx.webServer / ctx.speechToText, feeds the
// WAV's PCM into the /stream route as chunked request bodies, and prints the
// transcript plus how long the recognizer needed after the last chunk.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const wav = readFileSync(process.argv[2] ?? "tts-test-16k.wav");

/** PCM body of a canonical 16 kHz / 16-bit / mono WAV. */
function wavPcm(buf) {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const pcm = wavPcm(wav);
const routes = new Map();
const provider = {};

const ctx = {
  effect(fn) {
    return fn();
  },
  inject(names, fn) {
    // Only run the callback for services this fake context really has.
    const missing = names.filter((name) => ctx[name] === undefined);
    if (missing.length > 0) return undefined;
    return fn(ctx);
  },
  get(name) {
    return ctx[name];
  },
  settings: {
    configure() {
      return () => {};
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  speechToText: {
    register(registration) {
      Object.assign(provider, registration);
      return async () => {};
    },
  },
};

const plugin = await import("./index.js");
console.log("module name =", plugin.name);
console.log("inject =", JSON.stringify(plugin.inject));
plugin.apply(ctx, process.env.TEST_REGION === "cn" ? { region: "cn" } : {});

console.log("provider.info =", JSON.stringify(provider.info));
console.log("routes =", [...routes.keys()].join(", "));

/** Minimal IncomingMessage/ServerResponse pair. */
function makeExchange(method) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = {};
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.writableEnded = false;
  res.chunks = [];
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers ?? {};
  };
  res.end = (payload) => {
    if (payload !== undefined) res.chunks.push(Buffer.from(payload));
    res.writableEnded = true;
    res.emit("finish");
  };
  const done = new Promise((resolve) => res.once("finish", resolve));
  return { req, res, done };
}

/** Push the PCM in `frame` byte slices, `gapMs` apart, then end the body. */
async function feed(req, frame, gapMs) {
  for (let offset = 0; offset < pcm.length; offset += frame) {
    req.push(pcm.subarray(offset, Math.min(offset + frame, pcm.length)));
    if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  req.push(null);
}

function parse(res) {
  const body = Buffer.concat(res.chunks).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

const health = makeExchange("GET");
await routes.get("/plugins/dsh-voice-input-wb-asr/health")(health.req, health.res);
await health.done;
console.log("health =", JSON.stringify(parse(health.res)));

// The real client pushes 4096-sample (8192-byte) buffers about every 85 ms.
const live = makeExchange("POST");
const handler = routes.get("/plugins/dsh-voice-input-wb-asr/stream")(live.req, live.res);
const startedAt = Date.now();
const feeding = feed(live.req, 8192, 85);
const lastChunkAt = (await feeding, Date.now());
const result = await handler;
await live.done;
const finishedAt = Date.now();
console.log("pcm bytes =", pcm.length, "audio seconds =", (pcm.length / 32000).toFixed(2));
console.log("upload took =", lastChunkAt - startedAt, "ms");
console.log("tail decode =", finishedAt - lastChunkAt, "ms");
console.log("stream result =", JSON.stringify(parse(live.res)));

// The one-shot fallback the client uses when a streaming body is refused.
const oneShot = makeExchange("POST");
oneShot.req.headers = { "content-type": "application/json" };
const oneShotHandler = routes.get("/plugins/dsh-voice-input-wb-asr/transcribe")(oneShot.req, oneShot.res);
oneShot.req.push(Buffer.from(JSON.stringify({ audioBase64: wav.toString("base64") })));
oneShot.req.push(null);
await oneShotHandler;
await oneShot.done;
console.log("one-shot result =", JSON.stringify(parse(oneShot.res)));