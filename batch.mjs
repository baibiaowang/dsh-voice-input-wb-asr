#!/usr/bin/env node
/**
 * Batch transcription from the command line.
 *
 * The pipeline itself lives in transcribe-core.mjs, shared with the in-chat
 * wb_transcribe tool. This file only parses argv and prints progress.
 */
import { transcribe } from "./transcribe-core.mjs";

const USAGE = [
  "usage: node batch.mjs [options] <audio|video|dir> ...",
  "",
  "  --out <file.md>      document path (default wb-transcripts-<date>.md)",
  "  --region ai|cn       account pool: ai = www.workbuddy.ai (default), cn = www.workbuddy.cn",
  "  --per-account <n>    concurrent recognitions per account (default 4)",
  "  --chunk <seconds>    target chunk length, cut at pauses (default 60)",
  "  --no-timestamps      omit the [mm:ss] marker before each chunk",
  "  --keep-temp          keep the decoded PCM directory",
  "  --pcm-dir <dir>      transcribe pre-decoded <NNNN>-<name>.pcm files",
  "  -h, --help           this text",
].join("\n");

function parse(argv) {
  const opts = { inputs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(arg + " needs a value");
      i += 1;
      return value;
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--out") opts.out = next();
    else if (arg === "--per-account") opts.perAccount = Number(next());
    else if (arg === "--chunk") opts.chunk = Number(next());
    else if (arg === "--region") opts.region = next();
    else if (arg === "--no-timestamps") opts.timestamps = false;
    else if (arg === "--keep-temp") opts.keepTemp = true;
    else if (arg === "--pcm-dir") opts.pcmDir = next();
    else if (arg.startsWith("-") && arg !== "-") throw new Error("unknown option: " + arg);
    else opts.inputs.push(arg);
  }
  return opts;
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  console.error(USAGE);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (opts.pcmDir === undefined && opts.inputs.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const result = await transcribe({
    inputs: opts.inputs,
    out: opts.out,
    region: opts.region,
    chunk: opts.chunk,
    perAccount: opts.perAccount,
    timestamps: opts.timestamps,
    keepTemp: opts.keepTemp,
    pcmDir: opts.pcmDir,
    log: (line) => console.log(line),
  });
  if (result.failed > 0) {
    console.error(result.failed + " chunk(s) failed");
    process.exitCode = 1;
  }
} catch (error) {
  console.error("error: " + (error instanceof Error ? error.message : error));
  process.exit(1);
}
