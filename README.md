# dsh-voice-input-wb-asr

Hold-to-talk voice input for [DeepSeek Harness](https://github.com/deepseek-ai) — hold the composer microphone (or hold `Alt` while the caret is in the composer), speak, release, and the text is inserted at the caret.

Recognition runs on the WorkBuddy cloud ASR service, so no local model is downloaded: the shipped SenseVoice recognizer needs ~1 GB of model files, this plugin needs none.

按住说话，松开出字。识别走 WorkBuddy 云端，不用下 1 GB 的本地模型。

## What it does

- **Hold-to-talk** in the composer, with optional diffusion-ring feedback while recording.
- **Streams while you hold**: raw 16 kHz / 16-bit / mono PCM is pushed to the host half as you speak, so releasing the button only waits for the last syllable instead of the whole clip.
- **Registers as a provider** for the shipped speech-to-text service when that service is mounted, so a profile that keeps the click-to-start microphone still works. Where it does, the shipped microphone button is disabled so the composer carries one microphone, not two.
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

## Configure the token

The host half looks for a token in this order, first hit wins:

1. Environment variable `WORKBUDDY_ASR_TOKEN`.
2. The `token` field in the plugin configuration.
3. `~/.dsh/skills/wb-asr/token.txt` — first line.
4. `~/.workbuddy-asr/wb-asr-token.txt` — first line (`WORKBUDDY_ASR_KEY_DIR` overrides the directory).

Put the token on the first line of the file, one token per file. Never commit it.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `https://www.workbuddy.ai` | Recognizer base URL; only change it for a self-hosted gateway. |
| `timeoutMs` | `30000` | Per-request timeout. Raise it on a slow network. |
| `minHoldMs` | `320` | Presses shorter than this are treated as a mis-tap and are not uploaded. |
| `effect` | `true` | Show diffusion rings while recording. |
| `ringColor` | `#00ff9d` | Ring colour, hex. |

Every field is volatile: an edit applies to the running plugin without a restart.

## Privacy

- Audio leaves your machine: the recording is streamed to the WorkBuddy endpoint named in `endpoint`.
- The token stays on the host: it is never sent to the browser half.
- Nothing is stored on disk by the plugin; there is no transcript history.

## Notes and limitations

- The ASR protocol is unofficial — reverse engineered from the WorkBuddy web client, the same protocol the `wb-asr` skill speaks. It can break when the service changes.
- Chinese and English recognition quality depends on the service, not on this plugin.
- No wake word, no continuous dictation: it is push-to-talk only.

## License

MIT.
