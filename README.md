# dsh-voice-input-wb-asr

**Free.** WorkBuddy does not bill speech input: recognition runs on the WorkBuddy accounts you already signed in with — no API key, no per-minute charge, no local model to download.

**免费**：WorkBuddy 对语音输入不计费——只走你本机已登录的账号，不用 API key、不按分钟收费、也不下载本地模型。

Hold-to-talk voice input for [DeepSeek Harness](https://github.com/deepseek-ai): hold the composer microphone (or hold `Alt` while the caret is in the composer), speak, and the sentence is typed into the input box while you talk. Release, and the whole take is recognized once more and corrected in place.

It also turns recordings into documents: `wb_transcribe` takes audio or video paths in a conversation and returns one merged, timestamped transcript — an hour of audio in about a minute. Recognition runs on the WorkBuddy cloud ASR service, so no local model is downloaded: the shipped SenseVoice recognizer needs about 1 GB of model files, this plugin needs none.

按住说话，字直接写进输入框；松手后整段重识别，把预览替换成纠正后的最终文本。识别走 WorkBuddy 云端，不用下 1 GB 的本地模型。

## What it does

- **Types into the composer while you speak.** The upload is cut at pauses on the host side — 0.2 s of quiet closes a phrase, and a phrase that never pauses is cut at 3 s — and each phrase is recognized as soon as it closes. The growing text is written into the input box at the caret, replacing its own previous version, so you read the sentence as it forms.
- **Corrects on release.** The recording also goes to one continuous recognizer session that hears the whole take end to end; the service revises its tail as it hears more, so when you let go that full transcript is written once and replaces the preview. You get the service's own correction, not our stitched approximation.
- **Streams while you hold.** Raw 16 kHz / 16-bit / mono PCM is pushed to the host half as you speak, so releasing the button only waits for the last syllable instead of the whole clip.
- **Registers as a provider** for the shipped speech-to-text service when that service is mounted, so a profile that keeps the click-to-start microphone still works. Where it does, the shipped microphone button is disabled so the composer carries one microphone, not two.
- **Uses the accounts already signed in on this machine.** Tokens are read from the local WorkBuddy account stores; when one is rejected the next account is tried, and the take is replayed from its first byte, so a stale token does not cost you the recording.
- **International and domestic builds, kept apart.** The region decides the endpoint: `www.workbuddy.ai` for the international build, `www.workbuddy.cn` for the domestic one. International is the default and is the only one that runs until the domestic build is switched on in settings.
- **Batch transcription, in the conversation or from the shell**: a whole recording, or a directory of them, becomes one timestamped Markdown document — 82 minutes in 47 seconds in the measured run.
- **No dependencies outside Node built-ins**: the WebSocket client and the RIFF/WAVE reader are part of the plugin. `@deepseek-ai/schemastery` is a peer from the host and is only used for the settings schema; without it the plugin still loads and runs.

## How the two passes fit together

`/stream` runs two recognitions over the same audio:

| Pass | What it hears | What it is for |
|---|---|---|
| Preview | one phrase at a time, cut at pauses | text in the composer while you speak |
| Final | the whole take, one session | the text you keep |

The preview is a side channel: a phrase that fails to recognize is dropped silently and the final pass still has it. Previews are published in phrase order even when they finish out of order, and when the preview cannot keep up (slow network, several phrases queued) the extra phrases are skipped rather than buffered, so memory stays flat during a long dictation. The final text is written once; the preview write is abandoned if you typed into the composer meanwhile, and the final text is inserted instead.

## Requirements

- DeepSeek Harness 0.2.x (a profile that can load bundles). Node 20 or newer.
- A WorkBuddy account signed in on this machine. The tokens are **yours** — the plugin ships with none.
- For batch transcription: ffmpeg on `PATH`, or `FFMPEG_PATH`, or the `wb-asr` skill's bundled binary.

## Install

From the dsh plugin market, or directly:

```sh
dsh plugin --profile <profile> add github:baibiaowang/dsh-voice-input-wb-asr
```

From a local checkout:

```sh
dsh plugin --profile <profile> add <path to this package>
```

Restart the host (or reload the profile) after installing. The microphone appears in the composer; `wb_transcribe` appears in the tool list.

## Accounts

The plugin reads the WorkBuddy accounts already signed in on this machine — nothing to configure:

| Source | What it holds |
|---|---|
| `~/.dsh/.xdpool/accounts.json` | Accounts pooled by the `dsh-xdpool` plugin, with their region. |
| `~/.wb-switch/accounts.json` | Accounts recorded by `workbuddy-switch`. |
| `~/.dsh/skills/wb-asr/tokens.json`, `~/.workbuddy/skills/wb-asr/tokens.json` | The `wb-asr` skill's own token list. |
| `~/.dsh/skills/wb-asr/token.txt`, `~/.workbuddy-asr/wb-asr-token.txt` | A single fallback token, first line. |

Expired and re-login-required entries are sorted last; the account currently signed into the desktop app goes first. If the recognizer rejects a token, the next account is tried automatically — up to every account the machine knows. Files are only read, never written. `WORKBUDDY_ASR_ACCOUNTS` points the pool at a different file, and `WORKBUDDY_ASR_TOKEN` prepends a token that is not on this machine. Never commit a token.

The token list is cached for five seconds, so one dictation does not re-read six account files per phrase.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `activeRegion` | `ai` | Which build to use: `ai` international, `cn` domestic. Shown as two checkboxes — the ticked one is used. |
| `accountPool` | `true` | Read the accounts signed in on this machine and fail over between them. |
| `aiEndpoint` | `https://www.workbuddy.ai` | International recognizer base URL; only change it for a self-hosted gateway. |
| `cnEndpoint` | `https://www.workbuddy.cn` | Domestic recognizer base URL; only change it for a self-hosted gateway. |
| `timeoutMs` | `30000` | Per-request timeout. Raise it on a slow network. |
| `minHoldMs` | `320` | Presses shorter than this are treated as a mis-tap and are not uploaded. |
| `effect` | `true` | Show diffusion rings while recording. |
| `ringColor` | `#00ff9d` | Ring colour, hex. |

Every field is volatile: an edit applies to the running plugin without a restart.

## HTTP routes

The plugin serves four exact routes for its own client: `.../config`, `.../health`, `.../stream` and `.../transcribe`. Each one asks the host's request gate first (`ctx.connection.requestRejection` — the Host/Origin fence and browser login the host runs on its own API), so a page in another origin, or a host exposed beyond loopback, cannot reach them. On a host that publishes no such gate (older than 0.1.0-rc.8) the routes keep the loopback-origin check they always had.

`/stream` answers JSON by default and server-sent events when the request carries `accept: text/event-stream` — that is how the composer shows phrases as they are recognized, and it keeps `curl` usable.

A fifth route, `.../trace`, is a diagnostics sink that is only consulted when the host runs with `WB_ASR_DEBUG=1`; it records one line per preview stage in `wb-asr-debug.log` under the OS temp directory. With the variable unset nothing is written.

## Batch transcription: an hour of audio, well under a minute

Measured on this machine: an **82-minute video** (1:22:10) went in, and one merged, timestamped Markdown document came out in **46.9 seconds** — 74 chunks across 8 accounts × 4 channels, 0 failed. That is roughly **105× realtime**, and the command line did the same job in about the same time.

Measured again on audio alone: eleven files in ten formats — wav, mp3, m4a/AAC, raw AAC, flac, ogg, opus, wma, amr, aiff and caf — 1:43:46 of audio (104 minutes) decoded and transcribed in **51 seconds** (≈**122× realtime**), 0 failed chunks, and every format came back with the identical transcript. A single 9:26 file takes about 13 s, most of that plugin start-up and account discovery.

**Free**: WorkBuddy does not bill for speech input, so a run spends nothing but your own signed-in accounts' rate limits. The plugin itself is MIT.

`wb_transcribe` puts that pipeline in the conversation: pass file paths or a directory and the model gets the merged document back. Nothing to click, no upload dialog — just the paths.

> 82 分钟的录像，47 秒转成一份带时间戳的 Markdown 文稿；免费，WorkBuddy 对语音输入不计费。

The document goes to `语音转写-<date>.md` in the current working directory unless `out` names another path; an `out` outside the working directory is refused rather than written. Every file gets a `## N. name (duration)` heading, every chunk a `[mm:ss]` marker, files stay in the order you passed them, and an empty chunk is marked in place instead of vanishing.

The command line, `wb-batch.sh`, runs the same recognizer outside the composer for scripts and scheduled jobs. Every account works `--per-account` chunks at once (default 4), long media is cut at quiet points, and the chunks sit in one global queue: an account that finishes takes the next piece, so a slow file does not stall the rest.

```bash
bash wb-batch.sh talk.mp3 lecture.m4a recordings/ --out transcript.md
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--out` | `transcript.md` | Where the merged Markdown goes. |
| `--chunk` | `60` | Preferred chunk length in seconds. |
| `--per-account` | `4` | Concurrent recognitions per account. |
| `--region` | `ai` | Which endpoint and account pool to use: `ai` international, `cn` domestic. |
| `--no-timestamps` | off | Drop the `[mm:ss]` line before each chunk. |
| `--keep-temp` | off | Keep the decoded PCM instead of deleting it. |

Media is decoded to 16 kHz mono with ffmpeg: the script looks for `FFMPEG_PATH`, then the `wb-asr` skill's bundled binary (`~/.dsh/skills/wb-asr/bin`), then `ffmpeg` on `PATH`. Video files work the same way — the audio track is used and the picture is dropped. If ffmpeg cannot be started the run stops with one clear error instead of skipping every file.

Cut points come from the audio itself: 100 ms frames, and the boundary lands in the middle of a real pause (0.3 s or longer) nearest the target length, searching as far as 1.6× the target so a recording whose pauses come late still gets cut in silence. With no pause in reach, the quietest frame stands in. Every cut is printed when the file is queued (`cuts at 00:09 / 00:20`), so you can check the boundaries against the transcript. A chunk that comes back empty is marked in the document rather than dropped silently, and the header counts how many there were.

Memory stays flat on long recordings: the decoded PCM lives in a temporary file and each worker reads just its own chunk, instead of every job holding the whole file. A rejected account re-queues its chunk with a short backoff; a wait that looks rate-limited does not immediately hit the same account again.

The Node half (`batch.mjs`) needs the account pool the plugin already uses; run it through the shell wrapper so ffmpeg and the temporary directory are handled for you.

## Privacy

- Audio leaves your machine: the recording is streamed to the WorkBuddy endpoint selected by `activeRegion`, and batch files go to the same service.
- Tokens are read from your own account files and stay in the host half: they are never sent to the browser, and the plugin writes nothing back.
- Nothing is stored on disk by the plugin; there is no transcript history. The only file it can write is the diagnostics log, and only with `WB_ASR_DEBUG=1`.

## Notes and limitations

- The ASR protocol is unofficial — reverse engineered from the WorkBuddy web client, the same protocol the `wb-asr` skill speaks. It can break when the service changes.
- The service answers at sentence boundaries, not word by word: a phrase still takes about a second to come back, so the preview lands in whole phrases. Cutting finer than 0.2 s starts to clip words.
- A token belongs to one region: a domestic account fails on the international endpoint and vice versa. That is why the two builds are separate choices rather than one automatic fallback — the plugin never contacts the domestic service unless you tick it.
- The account count shown next to the choices is the number of distinct accounts on that region, deduplicated by account id: the same account appears in several local pools and each re-login leaves a new token, so counting entries would overstate it.
- The pool has no rate-limit awareness: it fails over on rejection, but it does not rotate between takes.
- Chinese and English recognition quality depends on the service, not on this plugin.
- No wake word, no continuous dictation: it is push-to-talk only.

## Version history

| Version | What changed |
|---|---|
| 0.10.0 | Hardening after a full code review: account failover replays the take, PCM is read per chunk instead of held whole, ffmpeg decodes without freezing the host, recognitions are aborted on error, the silence threshold adapts to microphone gain, settings schema no longer requires the peer package. |
| 0.9.x | Text is typed into the composer while speaking, replacing its own preview; the floating fallback was removed on request. |
| 0.8.0 | Server-sent phrases: the take is cut at pauses and each phrase recognized as it closes. |
| 0.7.x | `wb_transcribe` and the batch pipeline: long audio and video, many formats, one Markdown document. |
| 0.6.x | Host request gate on every route, domestic/international account pools. |

## License

MIT.
