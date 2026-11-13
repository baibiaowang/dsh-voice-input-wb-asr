/**
 * WorkBuddy cloud recognition for dsh: the composer microphone and the
 * recognizer behind it.
 *
 * The Client half records in the browser and streams raw 16 kHz / 16-bit /
 * mono PCM to this Host half while the button is held, so releasing the button
 * only waits for the last syllable. This half owns the WorkBuddy ASR
 * WebSocket used by the wb-asr skill, so the ~1 GB SenseVoice model download is
 * not needed.
 *
 * The shipped speech-to-text service is optional: where it is mounted the same
 * recognizer is also registered as a provider for it, so a profile that keeps
 * the shipped click-to-start microphone still works.
 *
 * No dependency outside Node built-ins: the WebSocket client and the WAV
 * reader are implemented here (ported from the wb-asr skill's pure-stdlib
 * client).
 */
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "voice-input-wb-asr";

/** Fields the settings page shows. Every one is volatile: an edit applies to the
 * running plugin instead of restarting it, which is what makes the microphone
 * usable straight after a change. */
const Config = z.object({
  enableCn: z.boolean().default(false)
    .description("启用国内版（www.workbuddy.cn）。关闭时只用国际版，本机的国内版账号一律不参与识别。").volatile(),
  activeRegion: z.string().default("ai")
    .description("当前线路：ai 国际版，cn 国内版。国内版要先在上面启用，否则即使选了 cn 也仍然走国际版。").volatile(),
  accountPool: z.boolean().default(true)
    .description("自动读取本机已登录的 WorkBuddy 账号，按线路挑账号，握手被拒自动换下一个。").volatile(),
  aiEndpoint: z.string().default("https://www.workbuddy.ai")
    .description("国际版识别服务地址。只有改用自建网关时才需要修改。").volatile(),
  cnEndpoint: z.string().default("https://www.workbuddy.cn")
    .description("国内版识别服务地址。只有改用自建网关时才需要修改。").volatile(),
  timeoutMs: z.number().step(1000).min(3000).max(300000).default(30000)
    .description("单次识别的超时时间（毫秒）。网络慢时可以调大。").volatile(),
  minHoldMs: z.number().step(10).min(0).max(2000).default(320)
    .description("最短录音时长（毫秒）。低于这个时长的按压视为误触，不上传。").volatile(),
  effect: z.boolean().default(true)
    .description("录音时显示扩散光圈特效。").volatile(),
  ringColor: z.string().default("#00ff9d")
    .description("光圈颜色，十六进制，例如 #00ff9d（数字生命绿）。").volatile(),
});

export { Config };
// The hold-to-talk routes are the primary surface, so this bundle must mount
// even when the shipped speech-to-text service is absent. The provider is
// registered only when that service exists.
export const inject = [];

/** 两个官方入口。token 与入口绑定：国内 token 在国际入口会被拒，反之亦然。 */
const AI_ENDPOINT = "https://www.workbuddy.ai";
const CN_ENDPOINT = "https://www.workbuddy.cn";
const DEFAULT_ENDPOINT = AI_ENDPOINT;
const STREAM_PATH = "/clientcap/v2/asr/stream";
const FRAME_BYTES = 3200; // 16 kHz * 2 bytes * 0.1 s

/* ------------------------------------------------------------------ token */

function readTokenFile(path) {
  try {
    const line = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)[0];
    return line?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function readWholeFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function readJsonFile(path) {
  const text = readWholeFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 这个入口属于哪条线路；判不出来按国际版算。 */
function regionOf(endpoint) {
  try {
    const host = new URL(String(endpoint)).hostname.toLowerCase();
    if (host === "workbuddy.cn" || host.endsWith(".workbuddy.cn")) return "cn";
    if (host === "codebuddy.cn" || host.endsWith(".codebuddy.cn")) return "cn";
    return "ai";
  } catch {
    return "ai";
  }
}

/**
 * 当前生效的线路。
 *
 * 国内版是可选功能：没打开 `enableCn` 时一律按国际版处理，即使 `activeRegion`
 * 写着 cn 也不松口——这样默认安装永远不会因为本机存着国内账号而偷偷走国内入口。
 */
function activeRegion(config) {
  const wanted = String(field(config, "activeRegion", "ai")).trim().toLowerCase();
  if (wanted !== "cn") return "ai";
  return field(config, "enableCn", false) === true ? "cn" : "ai";
}

/** 该线路的识别入口。 */
function resolveEndpoint(config) {
  if (activeRegion(config) === "cn") return String(field(config, "cnEndpoint", CN_ENDPOINT));
  return String(field(config, "aiEndpoint", AI_ENDPOINT));
}

/**
 * 本机已登录账号所在的文件。
 *
 * 桌面客户端同一时间只保留当前登录账号，所以本机装过 xdpool 的话，它把各账号的
 * access_token 攒在 `~/.dsh/.xdpool/accounts.json`；wb-switch 另有 `~/.wb-switch`。
 * 全部只读，不写回。
 */
function accountPoolPaths() {
  const home = homedir();
  const paths = [];
  const custom = process.env.WORKBUDDY_ASR_ACCOUNTS?.trim();
  if (custom) paths.push(custom);
  const keyDir = process.env.WORKBUDDY_ASR_KEY_DIR?.trim();
  if (keyDir) paths.push(join(keyDir, "wb-asr-tokens.json"));
  paths.push(join(home, ".dsh", ".xdpool", "accounts.json"));
  paths.push(join(home, ".wb-switch", "accounts.json"));
  paths.push(join(home, ".dsh", "skills", "wb-asr", "tokens.json"));
  paths.push(join(home, ".workbuddy", "skills", "wb-asr", "tokens.json"));
  return paths;
}

/** 客户端自报的当前登录账号，只用于排序，不参与鉴权。 */
function localSignedIn() {
  const home = homedir();
  const found = [];
  for (const dir of [".workbuddy", ".workbuddy-ai"]) {
    const snapshot = readJsonFile(join(home, dir, "storage", "skeleton", "account-snapshot.json"));
    const primary = snapshot?.primary;
    if (primary && typeof primary.uid === "string" && primary.uid) found.push(primary.uid);
  }
  return found;
}

/** 一个账号记录可能是 xdpool 的 {credential}、wb-switch 的扁平写法，或技能目录的写法。 */
function normalizeAccount(raw, source) {
  const box = raw && typeof raw === "object" && raw.credential && typeof raw.credential === "object" ? raw.credential : raw;
  const token = typeof box?.accessToken === "string" ? box.accessToken.trim()
    : typeof box?.access_token === "string" ? box.access_token.trim()
      : "";
  // A real WorkBuddy access token is a JWT of well over a thousand characters.
  // Short values in these files are placeholders left by an interrupted write;
  // they would only produce a 401 on the first take.
  if (token.length < 100) return undefined;
  const variant = String(raw?.variant ?? "").toLowerCase();
  const domain = typeof box?.domain === "string" && box.domain ? "https://" + box.domain : "";
  return {
    token,
    region: variant === "ai" || variant === "cn" ? variant : regionOf(domain || AI_ENDPOINT),
    uid: typeof box?.uid === "string" ? box.uid : "",
    expiresAt: Number(box?.expiresAtMs ?? box?.expiresAt) || 0,
    needsRelogin: raw?.needs_relogin === true,
    source,
  };
}

/**
 * 本机能拿到的全部账号（不含 token.txt 兜底）。
 *
 * 同一个账号会在多个池子里各留一份，而且每次重登都会换上新的 access_token ——
 * 按 token 去重会把一个账号数成好几个。身份按 `uid` 认，同一个 uid 只留一条，
 * 优先留没过期的、过期时间最远的那个 token。
 */
function discoverAccounts() {
  const byIdentity = new Map();
  const anonymous = [];
  const seenTokens = new Set();
  for (const path of accountPoolPaths()) {
    const parsed = readJsonFile(path);
    if (parsed === undefined) continue;
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    for (const raw of list) {
      const account = normalizeAccount(raw, path);
      if (!account) continue;
      // The same token often appears in two pools; without this the anonymous
      // token.txt entry would be counted as one account more than it is.
      if (seenTokens.has(account.token)) continue;
      seenTokens.add(account.token);
      if (!account.uid) {
        anonymous.push(account);
        continue;
      }
      const previous = byIdentity.get(account.uid);
      if (previous === undefined) {
        byIdentity.set(account.uid, account);
        continue;
      }
      const better = account.expiresAt > previous.expiresAt ? account : previous;
      byIdentity.set(account.uid, better);
    }
  }
  return [...byIdentity.values(), ...anonymous];
}

/**
 * 按尝试顺序给出 token。
 *
 * 只给当前线路的账号：跨线路的 token 一定被拒，排上它只是白花一次请求。国内版
 * 没启用时，本机的国内账号完全不列进来——默认安装就该只碰国际版。同线路里，
 * 桌面客户端当前登录的排前面，然后按过期时间从近到远。label 只写来源序号，不写
 * 昵称或 uid。
 */
function tokenCandidates(config) {
  const region = activeRegion(config);
  const candidates = [];
  const seen = new Set();
  const push = (token, label, identity) => {
    const value = typeof token === "string" ? token.trim() : "";
    if (!value) return;
    // Both the token and the account identity are checked: two pools can hold the
    // same account with different tokens, and one take must not burn two tries on it.
    const key = identity || value;
    if (seen.has(value) || seen.has(key)) return;
    seen.add(value);
    seen.add(key);
    candidates.push({ token: value, label: label ?? "pool-" + (candidates.length + 1) });
  };

  const fromEnv = process.env.WORKBUDDY_ASR_TOKEN?.trim();
  if (fromEnv) push(fromEnv, "env");
  if (typeof config?.token === "string") push(config.token, "config");

  if (field(config, "accountPool", true) !== false) {
    const signedIn = localSignedIn();
    const now = Date.now();
    const ranked = discoverAccounts()
      .filter((account) => !account.needsRelogin)
      .filter((account) => account.region === region)
      .map((account) => ({
        account,
        expired: account.expiresAt > 0 && account.expiresAt <= now,
        current: account.uid !== "" && signedIn.includes(account.uid),
      }))
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        if (a.expired !== b.expired) return a.expired ? 1 : -1;
        return b.account.expiresAt - a.account.expiresAt;
      });
    for (const entry of ranked) push(entry.account.token, undefined, entry.account.uid ? "uid:" + entry.account.uid : undefined);
  }

  const skillDir = config?.skillDir
    || process.env.WORKBUDDY_ASR_SKILL_DIR
    || join(homedir(), ".dsh", "skills", "wb-asr");
  const keyDir = process.env.WORKBUDDY_ASR_KEY_DIR
    || join(homedir(), ".workbuddy-asr");
  for (const file of [join(skillDir, "token.txt"), join(keyDir, "wb-asr-token.txt")]) {
    const token = readTokenFile(file);
    if (token) push(token, "file");
  }
  return candidates;
}

/**
 * 用第一个能握手的账号识别；401/403 换下一个账号再试。
 *
 * 认证失败以外的错误（网络、音频格式、服务端 5xx）直接抛出，不在账号间重试。
 */
async function transcribeWithPool(run, config) {
  const candidates = tokenCandidates(config);
  if (candidates.length === 0) {
    throw new Error(
      "wb-asr: 没有可用的 WorkBuddy 账号。请在桌面客户端登录任意账号，或设置环境变量 WORKBUDDY_ASR_TOKEN。",
    );
  }
  let lastError;
  for (const candidate of candidates) {
    try {
      return await run(candidate.token);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const authFailure = /401|403|Authorization Required|握手失败|invalid or expired JWT/i.test(message);
      if (!authFailure) throw error;
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------- WAV */

/**
 * Extract PCM from a canonical RIFF/WAVE file.
 * @param audio - bytes received from the speech API layer.
 * @returns 16 kHz / 16-bit / mono PCM samples.
 */
function wavToPcm(audio) {
  const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer ?? audio, audio.byteOffset ?? 0, audio.byteLength);
  if (buf.length < 44) throw new Error("wb-asr: 录音数据太短，不是有效 WAV");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("wb-asr: 录音不是 RIFF/WAVE 格式");
  }
  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new Error("wb-asr: 录音缺少 fmt 块");
  if (!data) throw new Error("wb-asr: 录音缺少 data 块");
  if (format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
    throw new Error(
      `wb-asr: 需要 16kHz/16bit/单声道 PCM 录音，收到 encoding=${format.encoding} channels=${format.channels} `
      + `rate=${format.sampleRate} bits=${format.bits}`,
    );
  }
  return data;
}

/* ------------------------------------------------------------- WebSocket */

/** Minimal RFC 6455 client: text/binary frames, ping reply, close handshake. */
class Socket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
  }

  static async open(url, headers, timeoutMs) {
    const target = new URL(url);
    const secure = target.protocol === "https:" || target.protocol === "wss:";
    const port = Number(target.port || (secure ? 443 : 80));
    const host = target.hostname;
    const key = randomBytes(16).toString("base64");
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Origin: ${secure ? "https" : "http"}://${host}`,
      "User-Agent: dsh-voice-input-wb-asr/0.3",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    const socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("wb-asr: 连接识别服务超时"));
      }, timeoutMs);
      socket.once(secure ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("wb-asr: 识别超时")));
    const client = new Socket(socket);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    const head = await client.readUntil("\r\n\r\n");
    const status = head.split("\r\n")[0];
    if (!status.includes(" 101 ")) {
      socket.destroy();
      throw new Error(`wb-asr: WebSocket 握手失败（${status}）`);
    }
    return client;
  }

  /** Resolve with the next chunk from the socket, or reject when it goes away. */
  #next() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("end", onEnd);
        this.socket.off("error", onError);
      };
      const onData = (data) => {
        cleanup();
        resolve(data);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("wb-asr: 连接被关闭"));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      this.socket.on("data", onData);
      this.socket.on("end", onEnd);
      this.socket.on("error", onError);
    });
  }

  async readExactly(count) {
    while (this.buffer.length < count) {
      this.buffer = Buffer.concat([this.buffer, await this.#next()]);
    }
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  async readUntil(separator) {
    const needle = Buffer.from(separator, "latin1");
    for (;;) {
      const index = this.buffer.indexOf(needle);
      if (index >= 0) {
        const head = this.buffer.subarray(0, index + needle.length);
        this.buffer = this.buffer.subarray(index + needle.length);
        return head.toString("latin1");
      }
      this.buffer = Buffer.concat([this.buffer, await this.#next()]);
    }
  }

  frame(opcode, payload) {
    const header = [];
    const mask = randomBytes(4);
    header.push(0x80 | opcode);
    const length = payload.length;
    if (length < 126) header.push(0x80 | length);
    else if (length < 65536) header.push(0x80 | 126, length >> 8, length & 0xff);
    else {
      header.push(0x80 | 127);
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(length));
      header.push(...size);
    }
    header.push(...mask);
    const masked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([Buffer.from(header), masked]));
  }

  sendBinary(payload) {
    this.frame(0x2, payload);
  }

  async receive() {
    for (;;) {
      const head = await this.readExactly(2);
      const opcode = head[0] & 0x0f;
      const masked = (head[1] & 0x80) !== 0;
      let length = head[1] & 0x7f;
      if (length === 126) length = (await this.readExactly(2)).readUInt16BE();
      else if (length === 127) length = Number((await this.readExactly(8)).readBigUInt64BE());
      const mask = masked ? await this.readExactly(4) : undefined;
      let payload = length ? await this.readExactly(length) : Buffer.alloc(0);
      if (mask) {
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }
      if (opcode === 0x8) return { opcode, payload };
      if (opcode === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      return { opcode, payload };
    }
  }

  close() {
    try {
      this.frame(0x8, Buffer.alloc(0));
    } catch {
      /* already closed */
    }
    this.socket.destroy();
  }
}

/* --------------------------------------------------------------- recognize */

/** Yield fixed-size frames so one pump serves both buffered and live audio. */
function* framed(pcm) {
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    yield pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length));
  }
}

/**
 * Relay PCM into one recognition session and return its final text.
 *
 * The press-to-talk client uploads samples while the button is held, so the
 * cloud recognizer has already seen the beginning of the sentence by the time
 * the button is released. Only the tail is still being decoded, which is what
 * makes the transcript appear almost immediately.
 *
 * @param chunks - sync or async iterable of 16 kHz / 16-bit / mono PCM buffers.
 */
async function recognizeStream(chunks, { token, endpoint, timeoutMs, signal }) {
  const url = new URL(STREAM_PATH, endpoint);
  url.searchParams.set("session_id", randomUUID().replace(/-/g, ""));
  url.searchParams.set("source", "dsh-voice-input-wb-asr");
  url.searchParams.set("interim_results", "1");
  const opening = Socket.open(url.toString(), { Authorization: `Bearer ${token}` }, timeoutMs);
  let client;
  // Armed before the handshake: a cancel that lands while the socket is still
  // connecting must not leave it open until the idle timeout.
  const onAbort = () => client?.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  let text = "";
  let bytes = 0;
  try {
    client = await opening;
    if (signal?.aborted) throw new Error("wb-asr: 已取消");
    let pending = Buffer.alloc(0);
    for await (const chunk of chunks) {
      if (signal?.aborted) throw new Error("wb-asr: 已取消");
      bytes += chunk.length;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_BYTES) {
        client.sendBinary(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
      }
    }
    if (pending.length > 0) client.sendBinary(pending);
    client.sendBinary(Buffer.alloc(0)); // empty frame = end of speech
    for (let index = 0; index < 400; index += 1) {
      const { opcode, payload } = await client.receive();
      if (opcode === 0x8) break;
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        continue;
      }
      const code = message?.code;
      if (code !== 0 && code !== null && code !== undefined) {
        throw new Error(`wb-asr: 识别服务返回错误 ${code}: ${message?.message ?? message?.msg ?? ""}`);
      }
      if (typeof message?.text === "string" && message.text) text = message.text;
      if (message?.final) break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    client?.close();
  }
  return { text: text.trim(), bytes };
}

/**
 * One-shot recognition of a complete recording.
 * @param pcm - 16 kHz / 16-bit / mono PCM.
 */
async function recognize(pcm, options) {
  if (!pcm.length) return "";
  const { text } = await recognizeStream(framed(pcm), options);
  return text;
}

/* ------------------------------------------------------------- chunk queue */

/** Ordered hand-off between the HTTP upload and the recognizer's socket pump. */
class ChunkQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
    this.failure = undefined;
    /** Total bytes pushed so far, so the route can cap one take. */
    this.bytes = 0;
  }

  push(item) {
    if (this.ended) return;
    this.bytes += item.length;
    this.items.push(item);
    this.#wake();
  }

  finish() {
    this.ended = true;
    this.#wake();
  }

  fail(error) {
    this.failure = error;
    this.ended = true;
    this.#wake();
  }

  #wake() {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift();
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

/* ----------------------------------------------------------------- routes */

const ROUTE_BASE = "/plugins/dsh-voice-input-wb-asr";
/** Slack added to the socket idle timeout so a long take cannot be cut short. */
const SESSION_MAX_MS = 180000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}

/* ------------------------------------------------------------------ plugin */

/**
 * Read one config field, tolerating both shapes schemastery hands out: a plain
 * value, and a volatile accessor whose `.get()` reflects a live edit without
 * restarting the plugin.
 */
function field(config, key, fallback) {
  const value = config?.[key];
  const live = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  return live === undefined || live === null ? fallback : live;
}

/** The subset of the configuration the Client needs; the token never leaves. */
function clientSettings(config) {
  const endpoint = resolveEndpoint(config);
  const timeoutMs = Number(field(config, "timeoutMs", 30000));
  const minHoldMs = Number(field(config, "minHoldMs", 320));
  const effect = field(config, "effect", true);
  const ringColor = field(config, "ringColor", "#00ff9d");
  const accounts = tokenCandidates(config).length;
  return {
    endpoint: String(endpoint),
    region: activeRegion(config),
    enableCn: field(config, "enableCn", false) === true,
    accounts,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
    minHoldMs: Number.isFinite(minHoldMs) ? minHoldMs : 320,
    effect: effect !== false,
    ringColor: String(ringColor),
  };
}

/**
 * Persist one settings edit.
 *
 * The settings service resolves writers by the Loader entry id of the plugin,
 * not by the package name, so the id is asked of the fiber instead of guessed:
 * a wrong namespace makes every save throw `No configurable plugin entry`.
 */
async function saveSettings(ctx, patch) {
  const settings = ctx.get("settings");
  if (settings === undefined || typeof settings.update !== "function") {
    throw new Error("这个 Host 没有 settings 服务，设置无法保存");
  }
  const entryId = ctx.fiber?.entry?.options?.id || "voice-input-wb-asr";
  await settings.update(entryId, patch);
}

/** Loopback browser origins only; other devices are refused. */
function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Mount the press-to-talk routes.
 *
 * `POST .../stream` takes raw 16 kHz / 16-bit / mono PCM as a chunked request
 * body and forwards each chunk to the recognizer while the button is still
 * held, so releasing the button only waits for the last syllable. `POST
 * .../transcribe` is the one-shot JSON fallback for clients that record first.
 *
 * Mounted through `ctx.inject(['webServer'], ...)` so Desktop startup order
 * cannot make the registration disappear.
 */
function registerRoutes(ctx, { getConfig }) {
  ctx.effect(() => {
    const disposeConfig = ctx.webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/config`,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "POST") {
          return sendJson(res, 405, { error: "method not allowed" });
        }
        if (!loopbackOrigin(req)) return sendJson(res, 403, { error: "origin-not-trusted" });
        // Read on every request: a settings edit must reach the next take
        // without the Client reloading the page.
        if (req.method === "GET") return sendJson(res, 200, clientSettings(getConfig()));
        try {
          const body = await readJson(req);
          const patch = {};
          if (body && typeof body.minHoldMs === "number") patch.minHoldMs = body.minHoldMs;
          if (body && typeof body.effect === "boolean") patch.effect = body.effect;
          if (body && typeof body.ringColor === "string") patch.ringColor = body.ringColor;
          if (body && typeof body.enableCn === "boolean") {
            patch.enableCn = body.enableCn;
            // Turning the domestic build off must not leave the switch pointing at
            // an endpoint that is no longer allowed; fall back to the default build.
            if (body.enableCn === false) patch.activeRegion = "ai";
          }
          if (body && (body.activeRegion === "ai" || body.activeRegion === "cn")) {
            const live = getConfig();
            if (body.activeRegion === "cn" && field(live, "enableCn", false) !== true) {
              return sendJson(res, 400, { error: "cn-not-enabled" });
            }
            patch.activeRegion = body.activeRegion;
          }
          if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: "no known field" });
          await saveSettings(ctx, patch);
          sendJson(res, 200, { values: clientSettings(getConfig()) });
        } catch (error) {
          if (!res.writableEnded && !res.destroyed) sendJson(res, 500, { error: fail(error) });
        }
      },
    });

    const disposeHealth = ctx.webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/health`,
      handler: async (req, res) => {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        if (!loopbackOrigin(req)) return sendJson(res, 403, { error: "origin-not-trusted" });
        const live = getConfig();
        const endpoint = resolveEndpoint(live);
        sendJson(res, 200, {
          ok: true,
          provider: "wb-asr-cloud",
          endpoint,
          region: activeRegion(live),
          enableCn: field(live, "enableCn", false) === true,
          streaming: true,
          accounts: tokenCandidates(live).length,
        });
      },
    });

    const disposeStream = ctx.webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/stream`,
      handler: async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        if (!loopbackOrigin(req)) return sendJson(res, 403, { error: "origin-not-trusted" });
        const startedAt = Date.now();
        const abort = new AbortController();
        const queue = new ChunkQueue();
        const limit = 4 * 1024 * 1024;
        res.on("close", () => {
          if (!res.writableEnded) abort.abort(new Error("client disconnected"));
        });
        req.on("data", (chunk) => {
          if (queue.bytes + chunk.length > limit) {
            queue.fail(new Error("wb-asr: 录音超过上限"));
            req.destroy();
            return;
          }
          queue.push(chunk);
        });
        req.on("end", () => queue.finish());
        req.on("error", (error) => queue.fail(error));
        try {
          const live = getConfig();
          const endpoint = resolveEndpoint(live);
          const result = await transcribeWithPool(
            (token) => recognizeStream(queue, {
              token,
              endpoint,
              timeoutMs: Number(field(live, "timeoutMs", 30000)) + SESSION_MAX_MS,
              signal: abort.signal,
            }),
            live,
          );
          sendJson(res, 200, {
            text: result.text,
            audioSeconds: result.bytes / 32000,
            inferenceSeconds: (Date.now() - startedAt) / 1000,
          });
        } catch (error) {
          // A cancelled upload has no socket left to answer on.
          if (!res.writableEnded && !res.destroyed) sendJson(res, 500, { error: fail(error) });
        }
      },
    });

    const disposeTranscribe = ctx.webServer.register({
      kind: "exact",
      path: `${ROUTE_BASE}/transcribe`,
      handler: async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        if (!loopbackOrigin(req)) return sendJson(res, 403, { error: "origin-not-trusted" });
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) abort.abort(new Error("client disconnected"));
        });
        try {
          const body = await readJson(req);
          const encoded = typeof body?.audioBase64 === "string" ? body.audioBase64 : "";
          if (!encoded) return sendJson(res, 400, { error: "audioBase64 is required" });
          const audio = Buffer.from(encoded, "base64");
          const pcm = wavToPcm(audio);
          const startedAt = Date.now();
          const live = getConfig();
          const endpoint = resolveEndpoint(live);
          const text = await transcribeWithPool(
            (token) => recognize(pcm, {
              token,
              endpoint,
              timeoutMs: Number(field(live, "timeoutMs", 30000)),
              signal: abort.signal,
            }),
            live,
          );
          sendJson(res, 200, {
            text,
            audioSeconds: pcm.length / 32000,
            inferenceSeconds: (Date.now() - startedAt) / 1000,
          });
        } catch (error) {
          if (!res.writableEnded && !res.destroyed) sendJson(res, 500, { error: fail(error) });
        }
      },
    });

    return () => {
      disposeConfig();
      disposeHealth();
      disposeStream();
      disposeTranscribe();
    };
  }, "voice-input-wb-asr: routes");
}

/** Read a small JSON request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("wb-asr: 请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Register the WorkBuddy recognizer next to the shipped providers.
 * @param ctx - Host context providing `webServer`, `settings` and optionally `speechToText`.
 * @param config - live Config (volatile accessors, so reads reflect settings edits).
 */
export function apply(ctx, config = {}) {
  const providerId = "wb-asr-cloud";
  const languages = ["auto", "zh", "en"];

  // The routes read this on every request instead of capturing values at mount
  // time: a settings edit has to reach the next take without a reload.
  const getConfig = () => config;

  // The press-to-talk routes need webServer; inject it so Desktop startup order
  // cannot drop the registration. A profile without it keeps the provider only.
  ctx.inject(["webServer"], (webCtx) => registerRoutes(webCtx, { getConfig }));

  // Let the settings page own this entry's form. Without the call the schema is
  // validated but never offered for editing.
  ctx.inject(["settings"], (settingsCtx) => settingsCtx.effect(() => {
    const settings = settingsCtx.settings;
    if (settings === undefined || typeof settings.configure !== "function") return () => {};
    return settings.configure({ auto: true }, settingsCtx.fiber) ?? (() => {});
  }, "voice-input-wb-asr: settings"));

  // The registry is optional: hold-to-talk works without it, and a profile that
  // keeps the shipped click-to-start microphone still gets this provider.
  ctx.inject(["speechToText"], (speechCtx) => speechCtx.effect(() => {
    const dispose = speechCtx.speechToText.register({
      info: {
        id: providerId,
        name: "WorkBuddy 云端识别",
        location: "cloud",
        languages,
      },
      transcribe: async (input, signal) => {
        const startedAt = Date.now();
        const pcm = wavToPcm(input.audio);
        const live = getConfig();
        const endpoint = resolveEndpoint(live);
        const text = await transcribeWithPool(
          (token) => recognize(pcm, {
            token,
            endpoint,
            timeoutMs: Number(field(live, "timeoutMs", 30000)),
            signal,
          }),
          live,
        );
        return {
          text,
          audioSeconds: pcm.length / 32000,
          inferenceSeconds: (Date.now() - startedAt) / 1000,
        };
      },
    });
    return dispose;
  }, "voice-input-wb-asr: provider"));
}

export { discoverAccounts, tokenCandidates, activeRegion };
