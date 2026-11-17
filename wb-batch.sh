#!/usr/bin/env bash
# Batch transcription for audio and video files.
#
#   bash wb-batch.sh <file|dir>... [--out file.md] [--per-account 4] [--chunk 60]
#                     [--region ai|cn] [--no-timestamps] [--keep-temp]
#
# ffmpeg decodes each input to 16 kHz / 16-bit / mono PCM into a temp directory;
# batch.mjs then runs the plugin's own WorkBuddy recognizer over a channel pool
# (4 per account by default) and writes one Markdown document.
#
# Why a wrapper: batch.mjs can decode by itself, but some sandboxes refuse
# CreateProcess from Node while allowing it from the shell, so the shell owns
# ffmpeg and Node only speaks the recognizer protocol.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

FF="${FFMPEG_PATH:-}"
if [ -z "$FF" ]; then
  for candidate in "$HOME/.dsh/skills/wb-asr/bin/ffmpeg.exe" \
                   "$HOME/.dsh/skills/wb-asr/bin/ffmpeg"; do
    if [ -x "$candidate" ]; then FF="$candidate"; break; fi
  done
fi
if [ -z "$FF" ]; then FF=$(command -v ffmpeg || true); fi
if [ -z "$FF" ]; then echo "ffmpeg not found; set FFMPEG_PATH" >&2; exit 1; fi

files=()
opts=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out|--per-account|--chunk|--region)
      if [ $# -lt 2 ]; then echo "$1 needs a value" >&2; exit 1; fi
      opts+=("$1" "$2"); shift 2 ;;
    --no-timestamps|--keep-temp) opts+=("$1"); shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) files+=("$1"); shift ;;
  esac
done
if [ ${#files[@]} -eq 0 ]; then echo "usage: bash wb-batch.sh <file|dir>... [options]" >&2; exit 1; fi

is_media() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *.mp3|*.wav|*.m4a|*.aac|*.flac|*.ogg|*.opus|*.wma|*.amr|*.aiff|*.aif|*.caf) return 0 ;;
    *.mp4|*.mkv|*.mov|*.avi|*.flv|*.webm|*.ts|*.wmv|*.m4v|*.mpg|*.mpeg|*.3gp|*.rmvb) return 0 ;;
    *) return 1 ;;
  esac
}

pick_tmp() {
  for base in "${WB_BATCH_TMP:-}" "${TMPDIR:-}" "${LOCALAPPDATA:-$HOME}/Temp" "$HOME/AppData/Local/Temp" "/tmp"; do
    [ -n "$base" ] || continue
    candidate="$base/wb-batch-$$-$RANDOM"
    if mkdir -p "$candidate" 2>/dev/null; then printf '%s' "$candidate"; return 0; fi
  done
  candidate="$(pwd)/.wb-batch-$$-$RANDOM"
  mkdir -p "$candidate" && printf '%s' "$candidate"
}
tmp=$(pick_tmp)
if [ -z "$tmp" ]; then echo "no writable temp directory" >&2; exit 1; fi
trap 'rm -rf "$tmp"' EXIT

count=0
for input in "${files[@]}"; do
  if [ -d "$input" ]; then
    # A list file rather than process substitution: `< <(find ...)` has been seen
    # to come back empty on MSYS, and an empty list silently loses every file.
    find "$input" -maxdepth 1 -type f | sort > "$tmp/list.txt"
    while IFS= read -r path; do
      if is_media "$path"; then
        count=$((count + 1))
        name=$(basename "$path")
        target="$tmp/$(printf '%04d' "$count")-$name.pcm"
        if "$FF" -hide_banner -loglevel error -y -i "$path" -vn -ac 1 -ar 16000 -f s16le -acodec pcm_s16le "$target" 2>"$tmp/ff.err"; then
          echo "decoded $name" >&2
        else
          rm -f "$target"
          echo "skip $name: $(tail -1 "$tmp/ff.err")" >&2
        fi
      fi
    done < "$tmp/list.txt"
  elif [ -f "$input" ]; then
    if is_media "$input"; then
      count=$((count + 1))
      name=$(basename "$input")
      target="$tmp/$(printf '%04d' "$count")-$name.pcm"
      if "$FF" -hide_banner -loglevel error -y -i "$input" -vn -ac 1 -ar 16000 -f s16le -acodec pcm_s16le "$target" 2>"$tmp/ff.err"; then
        echo "decoded $name" >&2
      else
        rm -f "$target"
        echo "skip $name: $(tail -1 "$tmp/ff.err")" >&2
      fi
    else
      echo "skip $input: not audio/video" >&2
    fi
  else
    echo "skip $input: no such file" >&2
  fi
done

if ! ls "$tmp"/*.pcm >/dev/null 2>&1; then echo "nothing to transcribe" >&2; exit 1; fi
pcm_dir=$(cygpath -w "$tmp" 2>/dev/null || printf '%s' "$tmp")
node "$HERE/batch.mjs" --pcm-dir "$pcm_dir" "${opts[@]}"
