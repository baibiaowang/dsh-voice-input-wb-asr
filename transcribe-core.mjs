/**
 * Batch transcription core.
 *
 * One recognizer, two callers: the CLI (batch.mjs) and the in-chat tool
 * (transcribe-tool.mjs). Every input is decoded to 16 kHz / 16-bit / mono PCM
 * with ffmpeg, cut at pauses into chunks, fed to the WorkBuddy service over a
 * pool of channels (4 per account by default), and merged, in order, into one
 * Markdown document.
 *
 * Nothing here touches argv or console: the caller supplies inputs, options and
 * a log sink, and gets the document back.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename, extname, resolve } from "node:path";

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".amr", ".aiff", ".aif", ".caf"]);
const VIDEO = new Set([".mp4", ".mkv", ".mov", ".avi", ".flv", ".webm", ".ts", ".wmv", ".m4v", ".mpg", ".mpeg", ".3gp", ".rmvb"]);

export function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    join(homedir(), ".dsh", "skills", "wb-asr", "bin", "ffmpeg.exe"),
    join("E:", "deepseek工作区", "我的", "工具链", "ffmpeg", "bin", "ffmpeg.exe"),
    join("C:", "Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
  ].filter(Boolean);
  for (const path of candidates) if (existsSync(path)) return path;
  return "ffmpeg";
}

export function collect(inputs) {
  const out = [];
  for (const input of inputs) {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error("no such file: " + input);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        const child = join(path, entry);
        if (statSync(child).isFile()) out.push(child);
      }
    } else {
      out.push(path);
    }
  }
  const media = out.filter((path) => AUDIO.has(extname(path).toLowerCase()) || VIDEO.has(extname(path).toLowerCase()));
  const skipped = out.filter((path) => !media.includes(path));
  return { media, skipped };
}

export function decodeToPcm(ffmpeg, input, target) {
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-f", "s16le", "-acodec", "pcm_s16le", target,
  ], { maxBuffer: 1 << 26 });
  if (result.status !== 0) {
    const message = String(result.stderr ?? "").trim().split("\n").slice(-2).join(" ");
    throw new Error("ffmpeg failed" + (message ? ": " + message : ""));
  }
  return readFileSync(target);
}

/**
 * Cut points at 0.1 s frames: the middle of a real pause (three frames and
 * longer) nearest the target boundary, looking as far as 1.6x the target so a
 * recording with late pauses still gets cut in silence. Without any pause in
 * reach, the quietest frame in the window stands in.
 */
export function planChunks(pcm, chunkSeconds) {
  const FRAME_SAMPLES = SAMPLE_RATE / 10;
  const frames = Math.floor(pcm.length / 2 / FRAME_SAMPLES);
  if (frames === 0) return [{ start: 0, end: pcm.length }];
  const energy = new Float64Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f += 1) {
    const base = f * FRAME_SAMPLES * 2;
    let sum = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sample = pcm.readInt16LE(base + i * 2);
      sum += sample * sample;
    }
    energy[f] = Math.sqrt(sum / FRAME_SAMPLES);
    if (energy[f] > peak) peak = energy[f];
  }
  const quiet = Math.max(60, peak * 0.04);
  const target = Math.max(1, Math.round(chunkSeconds * 10));
  const reach = Math.round(target * 1.6);
  const cuts = [];
  let anchor = 0;
  while (frames - anchor > target + 10) {
    const targetFrame = anchor + target;
    const lo = anchor + Math.round(target * 0.7);
    const hi = Math.min(frames - 10, anchor + reach);
    // A real pause outranks a mere dip: among the quiet runs in reach, the one
    // nearest the target wins, and of two equally near, the longer one.
    let best = null;
    let runStart = -1;
    let quietest = { level: Infinity, frame: targetFrame };
    const consider = (start, end) => {
      const length = end - start + 1;
      const center = Math.round((start + end) / 2);
      const distance = Math.abs(center - targetFrame);
      const pause = length >= 3;
      const better = best === null
        || (pause && !best.pause)
        || (pause === best.pause && distance < best.distance)
        || (pause === best.pause && distance === best.distance && length > best.length);
      if (better) best = { center, distance, length, pause };
    };
    for (let f = lo; f <= hi; f += 1) {
      const isQuiet = energy[f] <= quiet;
      if (isQuiet && runStart < 0) runStart = f;
      if (!isQuiet) {
        if (runStart >= 0) { consider(runStart, f - 1); runStart = -1; }
        if (energy[f] < quietest.level) quietest = { level: energy[f], frame: f };
      }
    }
    if (runStart >= 0) consider(runStart, hi);
    const cut = best === null ? quietest.frame : best.center;
    cuts.push(cut);
    anchor = cut;
  }
  const points = [0, ...cuts, frames];
  const chunks = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] * FRAME_SAMPLES * 2;
    const end = i === points.length - 2 ? pcm.length : points[i + 1] * FRAME_SAMPLES * 2;
    if (end - start < BYTES_PER_SECOND) continue; // under half a second: fold forward
    chunks.push({ start, end });
  }
  return chunks;
}

export function stamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

export function isAuthError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /401|403|Authorization Required|握手失败|invalid or expired JWT/i.test(message);
}

// index.js builds its settings schema at import time, and the host patches
// schemastery with .volatile(); the npm package does not have it.
const schemaProto = Object.getPrototypeOf((await import("@deepseek-ai/schemastery")).default.string());
if (typeof schemaProto.volatile !== "function") {
  schemaProto.volatile = function volatile() { return this; };
}
const core = await import("./index.js");

/**
 * Transcribe every audio/video file in the inputs and merge the result.
 *
 * options.inputs - files and directories (ignored when options.pcmDir is set)
 * options.out - document path; defaults to wb-transcripts-<date>.md in cwd
 * options.region - "ai" (default) or "cn"
 * options.chunk - target chunk seconds, default 60
 * options.perAccount - concurrent recognitions per account, default 4
 * options.timestamps - default true
 * options.keepTemp - default false
 * options.pcmDir - pre-decoded <NNNN>-<name>.pcm directory (used by wb-batch.sh)
 * options.log - progress sink
 */
export async function transcribe(options) {
  const log = options.log ?? (() => {});
  const opts = {
    out: options.out ?? "",
    perAccount: Math.max(1, Number(options.perAccount) || 4),
    chunk: Math.max(10, Number(options.chunk) || 60),
    region: options.region === "cn" || options.region === "ai" ? options.region : "ai",
    timestamps: options.timestamps !== false,
    keepTemp: options.keepTemp === true,
  };
  if (options.pcmDir !== undefined) opts.pcmDir = options.pcmDir;
  const { tokenCandidates, resolveEndpoint, recognizeStream, framed } = core;

  const ffmpeg = opts.pcmDir ? undefined : findFfmpeg();
  let media;
  let skipped = [];
  if (opts.pcmDir) {
    const dir = resolve(opts.pcmDir);
    media = readdirSync(dir)
      .filter((entry) => entry.toLowerCase().endsWith(".pcm"))
      .sort()
      .map((entry) => ({ name: entry.replace(/^\d+-/, "").replace(/\.pcm$/i, ""), path: join(dir, entry) }));
    if (media.length === 0) throw new Error("no .pcm files in " + dir);
  } else {
    const collected = collect(options.inputs ?? []);
    media = collected.media.map((path) => ({ path }));
    skipped = collected.skipped;
    if (media.length === 0) throw new Error("no audio or video files in the given paths");
    if (skipped.length > 0) log("skipped " + skipped.length + " non-media file(s)");
  }

  const config = { activeRegion: opts.region, accountPool: true, timeoutMs: 90000 };
  const tokens = tokenCandidates(config);
  if (tokens.length === 0) {
    const build = opts.region === "cn" ? "国内版 (www.workbuddy.cn)" : "国际版 (www.workbuddy.ai)";
    throw new Error("no account for the " + build + " pool: sign in to that build first, or use the other region");
  }
  const endpoint = resolveEndpoint(config);
  const channels = tokens.length * opts.perAccount;
  log("region " + opts.region + ": accounts " + tokens.length + " x " + opts.perAccount + " = " + channels + " channels, endpoint " + new URL(endpoint).host);

  let temp = "";
  const filesPlan = [];
  const jobs = [];
  let chunkIndex = 0;
  try {
    if (!opts.pcmDir) temp = mkdtempSync(join(tmpdir(), "wb-batch-"));
    for (const [fileIndex, item] of media.entries()) {
      const name = item.name ?? basename(item.path);
      const target = join(temp, "f" + fileIndex + ".pcm");
      let pcm;
      try {
        pcm = opts.pcmDir ? readFileSync(item.path) : decodeToPcm(ffmpeg, item.path, target);
      } catch (error) {
        log("skip " + name + ": " + (error instanceof Error ? error.message : error));
        continue;
      }
      if (pcm.length === 0) { log("skip " + name + ": no audio track"); continue; }
      const seconds = pcm.length / BYTES_PER_SECOND;
      const pieces = planChunks(pcm, opts.chunk);
      const entry = { name, seconds, pieces: [], fileIndex: filesPlan.length };
      for (const piece of pieces) {
        const job = { index: chunkIndex, fileIndex: entry.fileIndex, offset: piece.start / BYTES_PER_SECOND, pcm: pcm.subarray(piece.start, piece.end), attempts: 0, text: undefined, empty: undefined, error: undefined };
        entry.pieces.push({ offset: job.offset, length: (piece.end - piece.start) / BYTES_PER_SECOND });
        jobs.push(job);
        chunkIndex += 1;
      }
      filesPlan.push(entry);
      const cuts = entry.pieces.slice(0, -1).map((piece) => stamp(piece.offset + piece.length));
      log("queued " + name + " (" + stamp(seconds) + ", " + pieces.length + " chunk(s)" + (cuts.length > 0 ? ", cuts at " + cuts.join(" / ") : "") + ")");
      if (!opts.keepTemp) rmSync(target, { force: true });
    }
    if (jobs.length === 0) throw new Error("nothing to transcribe");

    const pending = jobs.map((job) => job.index);
    let done = 0;
    let failed = 0;
    const slots = [];
    for (const [tokenIndex, record] of tokens.entries()) {
      for (let i = 0; i < opts.perAccount; i += 1) slots.push({ record, dead: false, label: "acct" + (tokenIndex + 1) });
    }
    const take = () => (pending.length > 0 ? jobs[pending.shift()] : undefined);

    const pump = async (slot) => {
      for (;;) {
        const job = take();
        if (job === undefined) return;
        if (slot.dead) { pending.unshift(job.index); return; }
        try {
          const result = await recognizeStream(framed(job.pcm), { token: slot.record.token, endpoint, timeoutMs: 120000 });
          job.text = result.text;
          job.empty = result.text.length === 0;
          done += 1;
          log("[" + done + "/" + jobs.length + "] " + filesPlan[job.fileIndex].name + " @" + stamp(job.offset) + " -> " + (job.empty ? "no speech recognized" : result.text.length + " chars") + " (" + slot.label + ")");
        } catch (error) {
          if (isAuthError(error)) {
            slot.dead = true;
            log("account " + slot.label + " rejected: " + (error instanceof Error ? error.message : error));
            pending.unshift(job.index);
            return;
          }
          job.attempts += 1;
          if (job.attempts >= 3) {
            job.error = error instanceof Error ? error.message : String(error);
            failed += 1;
            done += 1;
            log("[" + done + "/" + jobs.length + "] FAILED " + filesPlan[job.fileIndex].name + " @" + stamp(job.offset) + ": " + job.error);
          } else {
            pending.unshift(job.index);
            await new Promise((r) => setTimeout(r, 1500 * job.attempts));
          }
        }
      }
    };

    await Promise.all(slots.map((slot) => pump(slot)));
    for (const index of pending) {
      const job = jobs[index];
      job.error = job.error ?? "no channel left";
      failed += 1;
    }

    const lines = [];
    const date = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    lines.push("# 语音转写 " + date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()));
    lines.push("");
    const totalSeconds = filesPlan.reduce((sum, file) => sum + file.seconds, 0);
    const empty = jobs.filter((job) => job.empty === true).length;
    lines.push("文件 " + filesPlan.length + " 个 · 音频 " + stamp(totalSeconds) + " · 分段 " + jobs.length + " · 账号 " + tokens.length + " × " + opts.perAccount + " 并发 · 空段 " + empty + " · 失败 " + failed + " 段");
    lines.push("");
    for (const file of filesPlan) {
      lines.push("## " + String(file.fileIndex + 1) + ". " + file.name + "  (" + stamp(file.seconds) + ")");
      lines.push("");
      for (const job of jobs.filter((item) => item.fileIndex === file.fileIndex)) {
        if (opts.timestamps) lines.push("[" + stamp(job.offset) + "]");
        if (job.text) lines.push(job.text);
        else if (job.empty) lines.push("_（这一段没有识别出文字，可能是静音、纯音乐或环境噪声）_");
        else lines.push("_(第 " + stamp(job.offset) + " 段未转写成功: " + (job.error ?? "unknown") + ")_");
        lines.push("");
      }
    }
    if (skipped.length > 0) {
      lines.push("## 未处理");
      lines.push("");
      for (const path of skipped) lines.push("- " + basename(path) + " (不是音频/视频)");
      lines.push("");
    }

    const outPath = opts.out
      ? resolve(opts.out)
      : resolve("wb-transcripts-" + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes()) + ".md");
    const markdown = lines.join("\n");
    writeFileSync(outPath, markdown, "utf8");
    log("wrote " + outPath + " (" + failed + " failed chunk(s))");

    return {
      markdown,
      outPath,
      failed,
      empty,
      chunks: jobs.length,
      files: filesPlan.map((file) => ({
        name: file.name,
        seconds: file.seconds,
        chunks: file.pieces.length,
        empty: jobs.filter((job) => job.fileIndex === file.fileIndex && job.empty === true).length,
        failed: jobs.filter((job) => job.fileIndex === file.fileIndex && job.error !== undefined).length,
      })),
      skipped,
    };
  } finally {
    if (temp !== "" && opts.keepTemp) log("temp kept: " + temp);
    else if (temp !== "") rmSync(temp, { recursive: true, force: true });
  }
}

