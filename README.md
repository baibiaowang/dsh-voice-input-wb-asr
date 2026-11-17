# dsh-voice-input-wb-asr

**Free.** WorkBuddy does not bill speech input: recognition runs on the WorkBuddy accounts you already signed in with — no API key, no per-minute charge, no local model to download.

**免费**：WorkBuddy 对语音输入不计费——只走你本机已登录的账号，不用 API key、不按分钟收费、也不下载本地模型。

Hold-to-talk voice input for [DeepSeek Harness](https://github.com/deepseek-ai) — hold the composer microphone (or hold `Alt` while the caret is in the composer), speak, release, and the text is inserted at the caret.

It also turns recordings into documents: `wb_transcribe` takes audio or video paths in a conversation and returns one merged transcript — an hour of audio in about a minute. Recognition runs on the WorkBuddy cloud ASR service, so no local model is downloaded: the shipped SenseVoice recognizer needs ~1 GB of model files, this plugin needs none.

按住说话，松开出字。识别走 WorkBuddy 云端，不用下 1 GB 的本地模型。

## What it does

- **Hold-to-talk** in the composer, with optional diffusion-ring feedback while recording.
- **Streams while you hold**: raw 16 kHz / 16-bit / mono PCM is pushed to the host half as you speak, so releasing the button only waits for the last syllable instead of the whole clip.
- **Text appears in the input box while you speak**: the upload is cut at pauses on our side — 0.3 s of quiet closes a phrase — and each phrase is recognized right away, so the sentence is typed into the composer as it is spoken. On release the whole take is recognized once more, end to end, and one write replaces what you watched with the corrected transcript: the service revises its tail, so the final lines change as they land.
- **Registers as a provider** for the shipped speech-to-text service when that service is mounted, so a profile that keeps the click-to-start microphone still works. Where it does, the shipped microphone button is disabled so the composer carries one microphone, not two.
- **Uses the accounts already signed in on this machine.** Tokens are read from the local WorkBuddy account stores; when one is rejected the next account is tried, so a stale token does not break the button.
- **International and domestic builds, kept apart.** The region decides the endpoint: `www.workbuddy.ai` for the international build, `www.workbuddy.cn` for the domestic one. International is the default and is the only one that runs until the domestic build is switched on in settings. A token only works on its own region, and the account pool records which one each token belongs to.
- **Batch transcription, in the conversation or from the shell**: a whole recording, or a directory of them, becomes one timestamped Markdown document — 82 minutes in 47 seconds in the measured run. No upload dialog, no local model, no metered cost (WorkBuddy does not bill speech input).
- **No dependencies outside Node built-ins**: the WebSocket client and the RIFF/WAVE reader are part of the plugin.

## Requirements

- DeepSeek Harness 0.2.x (a profile that can load bundles).
- A WorkBuddy account and an `access_token` for its ASR endpoint. The token is **yours** — the plugin ships with none.

## Install

```sh
dsh plugin --profile <profile> add <this package>
```

or from a checkout:

```sh
dsh plugin --profile <profile> add github:<owner>/dsh-voice-input-wb-asr
```

Restart the host (or reload the profile) after installing.

## Accounts

The plugin reads the WorkBuddy accounts already signed in on this machine — nothing to configure:

| Source | What it holds |
|---|---|
| `~/.dsh/.xdpool/accounts.json` | Accounts pooled by the `dsh-xdpool` plugin, with their region. |
| `~/.wb-switch/accounts.json` | Accounts recorded by `workbuddy-switch`. |
| `~/.dsh/skills/wb-asr/tokens.json`, `~/.workbuddy/skills/wb-asr/tokens.json` | The `wb-asr` skill's own token list. |
| `~/.dsh/skills/wb-asr/token.txt`, `~/.workbuddy-asr/wb-asr-token.txt` | A single fallback token, first line. |

Expired and re-login-required entries are sorted last; the account currently signed into the desktop app goes first. If the recognizer rejects a token, the next account is tried automatically — up to every account the machine knows. Files are only read, never written. `WORKBUDDY_ASR_ACCOUNTS` points the pool at a different file.

To use a token that is not on this machine, set `WORKBUDDY_ASR_TOKEN` — it is tried first. Never commit a token.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `activeRegion` | `ai` | Which build to use: `ai` international, `cn` domestic. Shown as two checkboxes in settings — the ticked one is used. |
| `accountPool` | `true` | Read the accounts signed in on this machine and fail over between them. |
| `aiEndpoint` | `https://www.workbuddy.ai` | International recognizer base URL; only change it for a self-hosted gateway. |
| `cnEndpoint` | `https://www.workbuddy.cn` | Domestic recognizer base URL; only change it for a self-hosted gateway. |
| `timeoutMs` | `30000` | Per-request timeout. Raise it on a slow network. |
| `minHoldMs` | `320` | Presses shorter than this are treated as a mis-tap and are not uploaded. |
| `effect` | `true` | Show diffusion rings while recording. |
| `ringColor` | `#00ff9d` | Ring colour, hex. |

Every field is volatile: an edit applies to the running plugin without a restart.

## Privacy

- Audio leaves your machine: the recording is streamed to the WorkBuddy endpoint selected by `activeRegion`.
- Tokens are read from your own account files and stay in the host half: they are never sent to the browser, and the plugin writes nothing back.
- Nothing is stored on disk by the plugin; there is no transcript history.

## HTTP routes

The plugin serves four exact routes for its own client: `.../config`, `.../health`, `.../stream` and `.../transcribe`. Each one asks the host's request gate first (`ctx.connection.requestRejection` — the Host/Origin fence and browser login the host runs on its own API), so a page in another origin, or a host exposed beyond loopback, cannot reach them. On a host that publishes no such gate (older than 0.1.0-rc.8) the routes keep the loopback-origin check they always had.

## Batch transcription: an hour of audio, well under a minute

Measured on this machine: an **82-minute video** (1:22:10) went in, and one merged, timestamped Markdown document came out in **46.9 seconds** — 74 chunks across 8 accounts × 4 channels, 0 failed. That is roughly **105× realtime**, and the command line did the same job in about the same time.

Measured again on audio alone: eleven files in ten formats — wav, mp3, m4a/AAC, raw AAC, flac, ogg, opus, wma, amr, aiff and caf — 1:43:46 of audio (104 minutes) decoded and transcribed in **51 seconds** (≈**122× realtime**), 0 failed chunks, and every format came back with the identical transcript. A single 9:26 file takes about 13 s, most of that plugin start-up and account discovery.

**Free**: WorkBuddy does not bill for speech input, so a run spends nothing but your own signed-in accounts' rate limits. The plugin itself is MIT.

`wb_transcribe` (0.7.0) puts that pipeline in the conversation itself: pass file paths or a directory and the model gets the merged document back. Nothing to click, no upload dialog — just the paths.

> 82 分钟的录像，47 秒转成一份带时间戳的 Markdown 文稿；免费，WorkBuddy 对语音输入不计费。

The document goes to `语音转写-<date>.md` in the current working directory unless `out` names another path. Every file gets a `## N. name (duration)` heading, every chunk a `[mm:ss]` marker, files stay in the order you passed them, and an empty chunk is marked in place instead of vanishing.

The command line, `wb-batch.sh`, runs the same recognizer outside the composer for scripts and scheduled jobs. Every account works `--per-account` chunks at once (default 4), long media is cut at quiet points, and the chunks sit in one global queue: an account that finishes takes the next piece, so a slow file does not stall the rest.

```bash
bash wb-batch.sh talk.mp3 lecture.m4a recordings/ --out transcript.md
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--out` | `transcript.md` | Where the merged Markdown goes. |
| `--chunk` | `60` | Preferred chunk length in seconds. |
| `--per-account` | `4` | Concurrent recognitions per account. |
| `--region` | `ai` | Which endpoint and account pool to use: `ai` for the international build, `cn` for the domestic one. |
| `--no-timestamps` | off | Drop the `[mm:ss]` line before each chunk. |
| `--keep-temp` | off | Keep the decoded PCM instead of deleting it. |

Media is decoded to 16 kHz mono with ffmpeg: the script looks for `FFMPEG_PATH`, then the `wb-asr` skill's bundled binary (`~/.dsh/skills/wb-asr/bin`), then `ffmpeg` on `PATH`. Video files work the same way — the audio track is used and the picture is dropped.

Cut points come from the audio itself: 100 ms frames, and the boundary lands in the middle of a real pause (0.3 s or longer) nearest the target length, searching as far as 1.6x the target so a recording whose pauses come late still gets cut in silence. With no pause in reach, the quietest frame stands in. Every cut is printed when the file is queued (`cuts at 00:09 / 00:20`), so you can check the boundaries against the transcript. A chunk that comes back empty is marked in the document rather than dropped silently, and the header counts how many there were.

The Node half (`batch.mjs`) needs the account pool the plugin already uses; run it through the shell wrapper so ffmpeg and the temporary directory are handled for you.

## Notes and limitations

- The ASR protocol is unofficial — reverse engineered from the WorkBuddy web client, the same protocol the `wb-asr` skill speaks. It can break when the service changes.
- A token belongs to one region: a domestic account fails on the international endpoint and vice versa. That is why the two builds are separate choices rather than one automatic fallback — the plugin never contacts the domestic service unless you tick it.
- The account count shown next to the choices is the number of distinct accounts on that region, deduplicated by account id: the same account appears in several local pools and each re-login leaves a new token, so counting entries would overstate it.
- The pool has no rate-limit awareness: it fails over on rejection, but it does not rotate between takes.
- Chinese and English recognition quality depends on the service, not on this plugin.
- No wake word, no continuous dictation: it is push-to-talk only.

## License

MIT.
