/**
 * The in-chat tool: batch transcription as one call from a conversation.
 *
 * The model passes file paths (or a directory) and gets the finished Markdown
 * document back, written under the workspace. Channels are the plugin's own
 * account pool: 4 per account, with a rejected account dropped for the run.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { transcribe } from "./transcribe-core.mjs";

// Nowhere machine-specific: a caller-supplied `out` wins, otherwise the document
// lands in the directory the host happens to be running in.
const DEFAULT_DIR = process.cwd();

function documentName(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return "语音转写-" + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes()) + ".md";
}

export const TRANSCRIBE_TOOL = {
  name: "wb_transcribe",
  description:
    "批量把语音/音频/视频文件转成文字，合并成一个 Markdown 文档。用 WorkBuddy 云端识别（识别率高于本地），"
    + "账号池并发：每个账号 4 路，长音频自动在静音处切段并发跑，按原顺序拼回去。"
    + "输入可以是文件列表，也可以是一个目录（目录里的音频/视频全部处理，非媒体文件跳过）。"
    + "支持 mp3/wav/m4a/aac/flac/ogg/opus/wma/amr/aiff/caf 与 mp4/mkv/mov/avi/flv/webm/ts 等；"
    + "视频自动取音轨，不需要先抽音频。结果里的 markdown 就是文档正文，可原样发给用户。",
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "要转写的音频/视频文件路径，或一个目录路径（Windows 路径直接写，如 E:/音频/会议.mp3）。",
      },
      out: {
        type: "string",
        description: "输出 Markdown 文件路径。不填则写到当前工作目录下的 语音转写-<日期-时间>.md。",
      },
      region: {
        type: "string",
        enum: ["ai", "cn"],
        description: "用哪个账号池：ai=国际版（www.workbuddy.ai，默认），cn=国内版（www.workbuddy.cn）。",
      },
      chunk: {
        type: "number",
        description: "每段目标秒数，默认 60。段与段之间会自动找静音停顿切，避免切在字中间。",
      },
      per_account: {
        type: "number",
        description: "每个账号的并发数，默认 4。账号少、文件多时可以调大，但太大容易被服务限流。",
      },
      timestamps: {
        type: "boolean",
        description: "是否在每段前标注时间戳，默认 true。",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: "object",
      properties: {
        markdown: { type: "string" },
        outPath: { type: "string" },
        files: { type: "array" },
        chunks: { type: "number" },
        failed: { type: "number" },
        empty: { type: "number" },
      },
    },
    render: (_args, value) => [{ type: "text", text: value.markdown }],
  },
  async execute(args, exec) {
    const paths = Array.isArray(args.paths) ? args.paths.filter((path) => typeof path === "string" && path.length > 0) : [];
    if (paths.length === 0) throw new Error("paths 不能为空：请给出要转写的文件或目录");
    for (const key of Object.keys(args)) {
      if (!["paths", "out", "region", "chunk", "per_account", "timestamps"].includes(key)) {
        throw new Error("未知参数: " + key);
      }
    }
    const out = typeof args.out === "string" && args.out.length > 0
      ? args.out
      : join(DEFAULT_DIR, documentName(new Date()));
    mkdirSync(dirname(out), { recursive: true });
    const log = exec?.log ?? (() => {});
    const result = await transcribe({
      inputs: paths,
      out,
      region: args.region,
      chunk: args.chunk,
      perAccount: args.per_account,
      timestamps: args.timestamps,
      log,
    });
    return {
      markdown: result.markdown,
      outPath: result.outPath,
      files: result.files,
      chunks: result.chunks,
      failed: result.failed,
      empty: result.empty,
    };
  },
};
