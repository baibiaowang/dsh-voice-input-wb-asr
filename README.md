# dsh-voice-input-wb-asr

Hold-to-talk voice input for [DeepSeek Harness](https://github.com/deepseek-ai) — hold the composer microphone (or hold `Alt` while the caret is in the composer), speak, release, and the text is inserted at the caret.

Recognition runs on the WorkBuddy cloud ASR service, so no local model is downloaded: the shipped SenseVoice recognizer needs ~1 GB of model files, this plugin needs none.

按住说话，松开出字。识别走 WorkBuddy 云端，不用下 1 GB 的本地模型。

## What it does

- **Hold-to-talk** in the composer, with optional diffusion-ring feedback while recording.
- **Streams while you hold**: raw 16 kHz / 16-bit / mono PCM is pushed to the host half as you speak, so releasing the button only waits for the last syllable instead of the whole clip.
- **Registers as a provider** for the shipped speech-to-text service when that service is mounted, so a profile that keeps the click-to-start microphone still works. Where it does, the shipped microphone button is disabled so the composer carries one microphone, not two.
- **Uses the accounts already signed in on this machine.** Tokens are read from the local WorkBuddy account stores; when one is rejected the next account is tried, so a stale token does not break the button.
- **International and domestic builds, kept apart.** The region decides the endpoint: `www.workbuddy.ai` for the international build, `www.workbuddy.cn` for the domestic one. International is the default and is the only one that runs until the domestic build is switched on in settings. A token only works on its own region, and the account pool records which one each token belongs to.
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
| `enableCn` | `false` | Switch the domestic build on. While it is off nothing contacts `workbuddy.cn` and domestic accounts are left out of the pool. |
| `activeRegion` | `ai` | `ai` international, `cn` domestic. Selecting `cn` while `enableCn` is off is refused. |
| `accountPool` | `true` | Read the accounts signed in on this machine and fail over between them. |
| `aiEndpoint` | `https://www.workbuddy.ai` | International recognizer base URL; only change it for a self-hosted gateway. |
| `cnEndpoint` | `https://www.workbuddy.cn` | Domestic recognizer base URL; only change it for a self-hosted gateway. |
| `timeoutMs` | `30000` | Per-request timeout. Raise it on a slow network. |
| `minHoldMs` | `320` | Presses shorter than this are treated as a mis-tap and are not uploaded. |
| `effect` | `true` | Show diffusion rings while recording. |
| `ringColor` | `#00ff9d` | Ring colour, hex. |

Every field is volatile: an edit applies to the running plugin without a restart.

## Privacy

- Audio leaves your machine: the recording is streamed to the WorkBuddy endpoint selected by `region`.
- Tokens are read from your own account files and stay in the host half: they are never sent to the browser, and the plugin writes nothing back.
- The token stays on the host: it is never sent to the browser half.
- Nothing is stored on disk by the plugin; there is no transcript history.

## Notes and limitations

- The ASR protocol is unofficial — reverse engineered from the WorkBuddy web client, the same protocol the `wb-asr` skill speaks. It can break when the service changes.
- A token belongs to one region: a domestic account fails on the international endpoint and vice versa. That is why the two builds are separate settings rather than one automatic choice — the plugin never contacts the domestic service unless you switch it on.
- Switching the domestic build off also moves the active region back to international, so the plugin cannot be left pointing at a disabled endpoint.
- The pool has no rate-limit awareness: it fails over on rejection, but it does not rotate between takes.
- Chinese and English recognition quality depends on the service, not on this plugin.
- No wake word, no continuous dictation: it is push-to-talk only.

## License

MIT.
