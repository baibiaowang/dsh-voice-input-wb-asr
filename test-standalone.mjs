// Confirm the plugin mounts and serves its routes with NO speechToText service,
// which is the profile state once the shipped voice-input bundle is off.
//
// Run with:  node --import ./test-resolve.mjs test-standalone.mjs
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const wav = readFileSync(process.argv[2] || "tts-test-16k.wav");
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
const saved = [];
// Only the services this profile really has: webServer, and a settings service
// that records writes instead of persisting them.
const services = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  settings: {
    configure() {
      return () => {};
    },
    async update(ns, patch) {
      saved.push({ ns, patch });
    },
  },
};
const ctx = {
  fiber: { entry: { options: { id: "voice-input-wb-asr" } } },
  effect(fn) { return fn(); },
  // A missing dependency must NOT run the callback, which is what the real
  // loader does for an optional injection.
  inject(names, fn) {
    const missing = names.filter((name) => services[name] === undefined);
    if (missing.length > 0) {
      console.log("absent -> callback skipped:", JSON.stringify(missing));
      return undefined;
    }
    return fn({ ...ctx, ...services, get: (name) => services[name] });
  },
  get(name) { return services[name]; },
  // Deliberately no speechToText.
};

const plugin = await import("./index.js");
console.log("name =", plugin.name, "inject =", JSON.stringify(plugin.inject));
console.log("config fields =", Object.keys(plugin.Config ?? {}).join(",") || "(none)");
plugin.apply(ctx, {});
console.log("routes =", [...routes.keys()].join(", "));

function makeExchange(method) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = {};
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.writableEnded = false;
  res.destroyed = false;
  res.chunks = [];
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers ?? {}; };
  res.write = (chunk) => { res.chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    res.emit("finish");
  };
  return { req, res };
}

async function call(path, method, body) {
  const { req, res } = makeExchange(method);
  const done = new Promise((resolve) => res.on("finish", resolve));
  const running = routes.get(path)(req, res);
  if (body !== undefined) req.push(body);
  req.push(null);
  await running;
  await done;
  return { status: res.statusCode, body: Buffer.concat(res.chunks).toString() };
}

// health
{
  const out = await call("/plugins/dsh-voice-input-wb-asr/health", "GET");
  console.log("health status", out.status, out.body);
}

// config read
{
  const out = await call("/plugins/dsh-voice-input-wb-asr/config", "GET");
  console.log("config get status", out.status, out.body);
}

// config write
{
  const out = await call(
    "/plugins/dsh-voice-input-wb-asr/config",
    "POST",
    Buffer.from(JSON.stringify({ ringColor: "#33ff66", effect: false, minHoldMs: 250 })),
  );
  console.log("config post status", out.status, out.body);
  console.log("saved =", JSON.stringify(saved));
}

// config write with nothing usable
{
  const out = await call("/plugins/dsh-voice-input-wb-asr/config", "POST", Buffer.from(JSON.stringify({ nope: 1 })));
  console.log("config post empty status", out.status, out.body);
}

// stream
{
  const { req, res } = makeExchange("POST");
  const done = new Promise((resolve) => res.on("finish", resolve));
  const running = routes.get("/plugins/dsh-voice-input-wb-asr/stream")(req, res);
  const CHUNK = 8192;
  for (let offset = 0; offset < pcm.length; offset += CHUNK) {
    req.push(pcm.subarray(offset, offset + CHUNK));
    await new Promise((r) => setTimeout(r, 20));
  }
  req.push(null);
  await running;
  await done;
  console.log("stream status", res.statusCode);
  console.log("stream body", Buffer.concat(res.chunks).toString());
}
