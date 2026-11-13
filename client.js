// dsh-voice-input-wb-asr - hold the microphone to dictate into the composer.
//
// Hand-written in the Client module-loader format. No Harness Client package is
// imported; styling uses --dsw-alias-* theme tokens only, with literal fallbacks.
//
// Audio streams to this package's own Host half while the button is held, so the
// cloud recognizer has already consumed the sentence by the time the button comes
// up: only the last syllable still has to be decoded.
window.__ModuleLoader__.load({
  id: 'dsh-voice-input-wb-asr',
  factory(require) {
    var React = require('react');
    var reactDom = undefined;
    try {
      reactDom = require('react-dom');
    } catch (ignored) {
      // The overlay hint falls back to inline rendering when this table lacks it.
    }
    var h = React.createElement;

    var NS = 'dsh-voice-input-wb-asr';
    var ROUTE = '/plugins/dsh-voice-input-wb-asr/stream';
    var CONFIG_ROUTE = '/plugins/dsh-voice-input-wb-asr/config';
    var SLOT = 'conversation.input.right';
    var TARGET_RATE = 16000;
    // Below this the user tapped instead of speaking; nothing is uploaded.
    // The Host's settings page can lower it, so it is only the default here.
    var MIN_HOLD_MS = 320;
    // Alt is also a shortcut prefix, so it only counts as dictation once held.
    // That arming delay already filters stray taps, so the key path can accept a
    // shorter take than the pointer path without swallowing one-word answers.
    var ALT_ARM_MS = 180;
    var ALT_MIN_HOLD_MS = 150;
    // The Host refuses longer uploads; stop on our own so the tail is not lost.
    var MAX_HOLD_MS = 120000;
    var DEFAULT_RING = '#00ff9d';

    /**
     * Copy shown to the user. The locale service owns the live table; these are
     * the fallbacks used before it is bound and if the service is absent.
     */
    var ZH = {
      'hold': '按住说话（或按住 Alt）',
      'release': '松开结束',
      'busy': '正在识别',
      'empty': '没有识别到内容',
      'insertFailed': '插入失败：{message}',
      'insertConflict': '草稿刚被改动，请再说一次',
      'noMedia': '这个环境不允许使用麦克风',
      'denied': '麦克风权限被拒绝',
      'noDevice': '没有找到可用的麦克风',
      'unreachable': '连不上识别服务：{message}',
      'badResponse': '识别服务返回了无法解析的结果',
      'badStatus': '识别服务返回 {status}',
      'settingsLoading': '正在读取设置…',
      'settingsSaving': '正在保存…',
      'settingsSaved': '已保存',
      'settingsFailed': '保存失败（{status}）',
      'fieldMinHold': '最短录音',
      'fieldEffect': '扩散光圈',
      'fieldColor': '光圈颜色',
      'unitMs': '毫秒',
      'fieldRegion': '识别线路（勾选一个）',
      'regionAi': '国际版（www.workbuddy.ai）',
      'regionCn': '国内版（www.workbuddy.cn）',
      'regionHint': '勾选哪个就用哪条线路：它的入口和它的账号。默认国际版，国内版只有手动勾选后才会使用。',
      'accounts': '当前线路可用账号 {count} 个',
    };
    var EN = {
      'hold': 'Hold to talk (or hold Alt)',
      'release': 'Release to stop',
      'busy': 'Recognizing',
      'empty': 'Nothing was recognized',
      'insertFailed': 'Could not insert: {message}',
      'insertConflict': 'The draft changed, please say it again',
      'noMedia': 'This environment does not allow microphone access',
      'denied': 'Microphone permission was denied',
      'noDevice': 'No microphone was found',
      'unreachable': 'Cannot reach the recognizer: {message}',
      'badResponse': 'The recognizer returned an unreadable response',
      'badStatus': 'The recognizer returned {status}',
      'settingsLoading': 'Reading settings…',
      'settingsSaving': 'Saving…',
      'settingsSaved': 'Saved',
      'settingsFailed': 'Could not save ({status})',
      'fieldMinHold': 'Minimum take',
      'fieldEffect': 'Diffusion rings',
      'fieldColor': 'Ring colour',
      'unitMs': 'ms',
      'fieldRegion': 'Recognizer region (tick one)',
      'regionAi': 'International (www.workbuddy.ai)',
      'regionCn': 'Domestic (www.workbuddy.cn)',
      'regionHint': 'The ticked row is the one used: its endpoint and its accounts. International is the default; the domestic build is only used after you tick it.',
      'accounts': '{count} accounts on this region',
    };

    /** Filled in by the locale service; the fallbacks above stay in place. */
    var translate = function fallback(key, vars) {
      return fill(ZH[key] !== undefined ? ZH[key] : key, vars);
    };

    function fill(template, vars) {
      if (vars === undefined) return template;
      return template.replace(/\{(\w+)\}/g, function replace(match, name) {
        return vars[name] === undefined ? match : String(vars[name]);
      });
    }

    /** The settings the Host applies to the next take. */
    var DEFAULTS = {
      minHoldMs: MIN_HOLD_MS, effect: true, ringColor: DEFAULT_RING, language: 'auto',
      region: 'ai', accounts: 0,
    };

    /**
     * Read the live settings. Called on mount and again before each take, so an
     * edit in the settings page reaches the microphone without a reload. A
     * failure keeps the previous values: dictation must not stop over cosmetics.
     */
    function fetchSettings() {
      return fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        .then(function toJson(response) { return response.ok ? response.json() : null; })
        .then(function pick(payload) {
          if (payload === null || payload === undefined) return null;
          return {
            minHoldMs: typeof payload.minHoldMs === 'number' ? payload.minHoldMs : DEFAULTS.minHoldMs,
            effect: payload.effect !== false,
            ringColor: typeof payload.ringColor === 'string' && payload.ringColor ? payload.ringColor : DEFAULT_RING,
            language: typeof payload.language === 'string' ? payload.language : DEFAULTS.language,
            region: payload.region === 'cn' ? 'cn' : 'ai',
            accounts: typeof payload.accounts === 'number' ? payload.accounts : 0,
          };
        })
        .catch(function ignore() { return null; });
    }

    var CSS = [
      '.dsh-wbvi{display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#8b8b8b);cursor:pointer;position:relative;',
      'touch-action:none;user-select:none;-webkit-user-select:none;',
      'transition:background .12s ease,color .12s ease}',
      '.dsh-wbvi:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.dsh-wbvi:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}',
      '.dsh-wbvi:disabled{cursor:default;opacity:.55}',
      // The microphone grows while the take is open and keeps its ring colour,
      // so the recording state reads without a second label.
      '.dsh-wbvi svg{position:relative;z-index:1;transition:transform .16s ease}',
      '.dsh-wbvi[data-phase="recording"]{color:var(--dsh-wbvi-ring,#00ff9d);background:transparent}',
      '.dsh-wbvi[data-phase="recording"] svg{transform:scale(1.25)}',
      '.dsh-wbvi[data-phase="busy"]{color:var(--dsw-alias-brand-primary,#1f6feb)}',
      // Two rings half a period apart read as one continuous pulse moving out.
      '.dsh-wbvi[data-effect="on"][data-phase="recording"]::before,',
      '.dsh-wbvi[data-effect="on"][data-phase="recording"]::after{',
      'content:"";position:absolute;left:50%;top:50%;width:100%;height:100%;',
      'border-radius:50%;border:1.5px solid var(--dsh-wbvi-ring,#00ff9d);',
      'box-shadow:0 0 6px var(--dsh-wbvi-ring,#00ff9d),inset 0 0 4px var(--dsh-wbvi-ring,#00ff9d);',
      'pointer-events:none;animation:dsh-wbvi-ring 1.7s cubic-bezier(.22,.61,.36,1) infinite}',
      '.dsh-wbvi[data-effect="on"][data-phase="recording"]::after{animation-delay:.85s}',
      '@keyframes dsh-wbvi-ring{',
      '0%{transform:translate(-50%,-50%) scale(.7);opacity:.9}',
      '70%{opacity:.2}',
      '100%{transform:translate(-50%,-50%) scale(2.7);opacity:0}}',
      '.dsh-wbvi-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;',
      'background:currentColor;animation:dsh-wbvi-pulse 1s ease-in-out infinite}',
      '@keyframes dsh-wbvi-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}',
      '.dsh-wbvi-spin{position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;',
      'border:1.5px solid currentColor;border-top-color:transparent;animation:dsh-wbvi-rotate .8s linear infinite}',
      '@keyframes dsh-wbvi-rotate{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){',
      '.dsh-wbvi-dot,.dsh-wbvi-spin{animation:none}',
      '.dsh-wbvi svg{transition:none}',
      '.dsh-wbvi[data-effect="on"][data-phase="recording"]::before,',
      '.dsh-wbvi[data-effect="on"][data-phase="recording"]::after{',
      'animation:none;opacity:.45;transform:translate(-50%,-50%) scale(1.7)}}',
      '.dsh-wbvi-tip{position:fixed;z-index:2147483000;padding:6px 10px;border-radius:8px;',
      'font-size:12px;line-height:1.4;max-width:300px;pointer-events:none;',
      'background:var(--dsw-alias-bg-overlay,#1f1f1f);color:var(--dsw-alias-label-primary,#f5f5f5);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));',
      'box-shadow:0 6px 24px rgba(0,0,0,.28)}',
      '.dsh-wbvi-tip[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#ff6369)}',
      '.dsh-wbvi-form{display:flex;flex-direction:column;gap:10px;font-size:13px}',
      '.dsh-wbvi-row{display:flex;align-items:center;gap:10px}',
      '.dsh-wbvi-name{flex:0 0 96px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.dsh-wbvi-unit{color:var(--dsw-alias-label-secondary,#8b8b8b);font-variant-numeric:tabular-nums}',
      '.dsh-wbvi-form input[type="number"]{width:88px;padding:3px 6px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));',
      'background:var(--dsw-alias-bg-layer-1,#161616);color:var(--dsw-alias-label-primary,#f5f5f5)}',
      '.dsh-wbvi-form input[type="color"]{width:44px;height:26px;padding:0;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent}',
      '.dsh-wbvi-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.dsh-wbvi-choice{cursor:pointer}',
      '.dsh-wbvi-choice input{cursor:pointer;width:14px;height:14px;margin:0}',
    ].join('');

    /* ---------------------------------------------------------- resampling */

    function concatFloat(left, right) {
      var merged = new Float32Array(left.length + right.length);
      merged.set(left, 0);
      merged.set(right, left.length);
      return merged;
    }

    /**
     * Linear resampler carrying its fractional phase between callbacks, so a
     * microphone that ignores the requested rate still produces clean 16 kHz
     * audio instead of a per-chunk click.
     */
    function createResampler(inputRate) {
      if (inputRate === TARGET_RATE) {
        return function passthrough(samples) {
          return samples;
        };
      }
      var ratio = inputRate / TARGET_RATE;
      var remainder = new Float32Array(0);
      return function resample(samples) {
        var source = remainder.length === 0 ? samples : concatFloat(remainder, samples);
        if (source.length < 2) {
          remainder = source;
          return new Float32Array(0);
        }
        var frames = Math.floor((source.length - 1) / ratio);
        if (frames <= 0) {
          remainder = source;
          return new Float32Array(0);
        }
        var out = new Float32Array(frames);
        for (var index = 0; index < frames; index += 1) {
          var position = index * ratio;
          var left = Math.floor(position);
          var weight = position - left;
          out[index] = source[left] * (1 - weight) + source[left + 1] * weight;
        }
        remainder = source.subarray(Math.floor(frames * ratio));
        return out;
      };
    }

    /** Float samples in [-1, 1] to little-endian 16-bit PCM. */
    function toPcm16(samples) {
      var bytes = new Uint8Array(samples.length * 2);
      var view = new DataView(bytes.buffer);
      for (var index = 0; index < samples.length; index += 1) {
        var sample = samples[index];
        if (sample > 1) sample = 1;
        else if (sample < -1) sample = -1;
        // Round to nearest: setInt16 truncates toward zero, which biases every
        // sample down by half a step and adds audible noise on quiet input.
        view.setInt16(index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      }
      return bytes;
    }

    function messageOf(cause) {
      if (cause instanceof Error) return cause.message;
      return String(cause);
    }

    /** Mark a failure that a retry can plausibly fix (transport, not verdict). */
    function retryable(error) {
      error.retryable = true;
      return error;
    }

    async function readTranscript(request) {
      var response;
      try {
        response = await request;
      } catch (cause) {
        throw retryable(new Error(translate('unreachable', { message: messageOf(cause) })));
      }
      var payload;
      try {
        payload = await response.json();
      } catch (cause) {
        throw retryable(new Error(translate('badResponse')));
      }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : translate('badStatus', { status: response.status }));
      return typeof payload.text === 'string' ? payload.text : '';
    }

    /* ------------------------------------------------------------ recording */

    /**
     * One press: acquire the microphone, stream PCM to the Host, and resolve
     * with the transcript once the button is released.
     *
     * `finish()` resolves to `null` for an accidental tap, `''` when nothing was
     * recognized, and the text otherwise.
     */
    function createSession() {
      var session = {
        // Every chunk is kept even while streaming succeeds: if the upload dies
        // at the instant the button is released, this is the only copy of the
        // take. One capped hold (MAX_HOLD_MS) costs at most ~3.8 MB.
        chunks: [],
        bytes: 0,
        controller: undefined,
        request: undefined,
        streamBroken: false,
        aborted: false,
        stopped: false,
        startedAt: 0,
        release: undefined,
        context: undefined,
        /** Set by the component: ends the take the same way releasing would. */
        onLimit: undefined,
        /** Shortest take worth uploading; the key path lowers it. */
        minHoldMs: MIN_HOLD_MS,
        // Aborting the fetch closes the upload, so the Host stops recognizing
        // instead of finishing a take the user already dropped.
        cancel: typeof AbortController === 'function' ? new AbortController() : undefined,
      };

      session.start = async function start() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          throw new Error(translate('noMedia'));
        }
        var stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          });
        } catch (cause) {
          if (cause && cause.name === 'NotAllowedError') throw new Error(translate('denied'));
          if (cause && (cause.name === 'NotFoundError' || cause.name === 'OverconstrainedError')) {
            throw new Error(translate('noDevice'));
          }
          throw cause;
        }
        if (session.aborted) {
          stream.getTracks().forEach(function stopTrack(track) { track.stop(); });
          return;
        }
        session.startedAt = Date.now();
        var AudioCtor = window.AudioContext || window.webkitAudioContext;
        var context = new AudioCtor({ sampleRate: TARGET_RATE });
        session.context = context;
        if (context.state === 'suspended') await context.resume();
        var resample = createResampler(context.sampleRate);

        var source = context.createMediaStreamSource(stream);
        var processor = context.createScriptProcessor(4096, 1, 1);
        // The processor only has to run; muting it keeps the microphone out of
        // the speakers while the button is held.
        var mute = context.createGain();
        mute.gain.value = 0;
        session.release = function release() {
          try { source.disconnect(); } catch (ignored) { /* already gone */ }
          try { processor.disconnect(); } catch (ignored) { /* already gone */ }
          try { mute.disconnect(); } catch (ignored) { /* already gone */ }
          try {
            stream.getTracks().forEach(function stopTrack(track) { track.stop(); });
          } catch (ignored) { /* already gone */ }
          var closing = context.close();
          if (closing && typeof closing.catch === 'function') closing.catch(function ignore() {});
        };

        processor.onaudioprocess = function onAudio(event) {
          if (session.stopped || session.aborted) return;
          var pcm = toPcm16(resample(event.inputBuffer.getChannelData(0)));
          if (pcm.length === 0) return;
          session.chunks.push(pcm);
          session.bytes += pcm.length;
          if (session.controller !== undefined) {
            try {
              session.controller.enqueue(pcm);
            } catch (ignored) {
              // The Host closed the request; the recorded tail is still usable.
              session.streamBroken = true;
              session.controller = undefined;
            }
          }
          if (Date.now() - session.startedAt > MAX_HOLD_MS) {
            // Cap the take by ending it the same way a release would, instead of
            // going silent while the button still claims to be recording.
            session.stop();
            if (session.onLimit !== undefined) session.onLimit();
          }
        };
        source.connect(processor);
        processor.connect(mute);
        mute.connect(context.destination);

        // Stream while the button is held. If the browser refuses a streaming
        // request body, the whole recording is posted on release instead.
        try {
          var body = new ReadableStream({
            start: function start(controller) { session.controller = controller; },
            cancel: function cancel() { session.controller = undefined; },
          });
          var request = fetch(ROUTE, {
            method: 'POST',
            body: body,
            duplex: 'half',
            headers: { 'content-type': 'application/octet-stream' },
            credentials: 'same-origin',
            ...(session.cancel === undefined ? {} : { signal: session.cancel.signal }),
          });
          session.request = request;
          request.catch(function markBroken() { session.streamBroken = true; });
        } catch (ignored) {
          session.streamBroken = true;
        }
      };

      session.stop = function stop() {
        if (session.stopped) return;
        session.stopped = true;
        if (session.release !== undefined) session.release();
        session.release = undefined;
      };

      session.abort = function abort() {
        session.aborted = true;
        session.stop();
        if (session.controller !== undefined) {
          try { session.controller.close(); } catch (ignored) { /* already closed */ }
          session.controller = undefined;
        }
        if (session.cancel !== undefined) {
          try { session.cancel.abort(); } catch (ignored) { /* already aborted */ }
        }
      };

      /** Post the whole recording at once; used when streaming did not deliver. */
      function postRecording() {
        var merged = new Uint8Array(session.bytes);
        var offset = 0;
        for (var index = 0; index < session.chunks.length; index += 1) {
          merged.set(session.chunks[index], offset);
          offset += session.chunks[index].length;
        }
        return readTranscript(fetch(ROUTE, {
          method: 'POST',
          body: merged,
          headers: { 'content-type': 'application/octet-stream' },
          credentials: 'same-origin',
          ...(session.cancel === undefined ? {} : { signal: session.cancel.signal }),
        }));
      }

      session.finish = async function finish() {
        var heldMs = session.startedAt === 0 ? 0 : Date.now() - session.startedAt;
        session.stop();
        if (session.aborted || heldMs < session.minHoldMs || session.bytes === 0) {
          session.abort();
          return null;
        }
        if (session.controller !== undefined) {
          try {
            session.controller.close();
          } catch (ignored) {
            session.streamBroken = true;
          }
          session.controller = undefined;
        }
        if (!session.streamBroken && session.request !== undefined) {
          try {
            return await readTranscript(session.request);
          } catch (cause) {
            // The stream can fail at the very moment the button is released —
            // `streamBroken` is set from a promise callback that has not run yet.
            // The samples are all still in memory, so send them instead of
            // losing the take.
            if (cause === null || cause === undefined || cause.retryable !== true) throw cause;
            session.streamBroken = true;
          }
        }
        return postRecording();
      };

      return session;
    }

    /* ------------------------------------------------------------- component */

    function MicIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 9, y: 2, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5 10a7 7 0 0 0 14 0' }),
        h('line', { x1: 12, y1: 17, x2: 12, y2: 21 }),
        h('line', { x1: 8, y1: 21, x2: 16, y2: 21 }),
      );
    }

    function Notice(props) {
      var tip = h('div', {
        className: 'dsh-wbvi-tip',
        'data-tone': props.tone,
        role: 'status',
        style: { left: props.left, top: props.top },
      }, props.text);
      if (reactDom && typeof reactDom.createPortal === 'function') {
        return reactDom.createPortal(tip, document.body);
      }
      return tip;
    }

    function HoldToTalk(props) {
      var inputActions = props.inputActions;
      var phaseState = React.useState('idle');
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var settingsState = React.useState(DEFAULTS);
      var settings = settingsState[0];
      var setSettings = settingsState[1];
      var sessionRef = React.useRef(null);
      var phaseRef = React.useRef('idle');
      var buttonRef = React.useRef(null);
      // The settings a take starts with; a take in flight keeps its own copy.
      var settingsRef = React.useRef(DEFAULTS);
      settingsRef.current = settings;

      React.useEffect(function loadSettings() {
        var alive = true;
        fetchSettings().then(function apply(next) {
          if (alive && next !== null) setSettings(next);
        });
        return function stop() { alive = false; };
      }, []);

      function moveTo(next) {
        phaseRef.current = next;
        setPhase(next);
      }

      function showNotice(tone, text) {
        var rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : null;
        setNotice({
          tone: tone,
          text: text,
          left: rect === null ? 24 : Math.max(8, Math.min(rect.left - 8, window.innerWidth - 308)),
          top: rect === null ? 24 : Math.max(8, rect.top - 40),
        });
      }

      React.useEffect(function watchNotice() {
        if (notice === null) return undefined;
        var timer = setTimeout(function clear() { setNotice(null); }, notice.tone === 'error' ? 4200 : 2000);
        return function cancel() { clearTimeout(timer); };
      }, [notice]);

      React.useEffect(function cleanup() {
        return function unmount() {
          var session = sessionRef.current;
          sessionRef.current = null;
          if (session !== null) session.abort();
        };
      }, []);

      var insert = React.useCallback(function insert(text) {
        if (!text) {
          showNotice('info', translate('empty'));
          return;
        }
        var span = inputActions.captureInsertion();
        var written = false;
        try {
          written = inputActions.insertText(text, span);
        } catch (cause) {
          showNotice('error', translate('insertFailed', { message: messageOf(cause) }));
          return;
        }
        if (!written) showNotice('error', translate('insertConflict'));
      }, [inputActions]);

      async function finishSession(session) {
        var text;
        try {
          text = await session.finish();
        } catch (cause) {
          moveTo('idle');
          showNotice('error', messageOf(cause));
          return;
        }
        moveTo('idle');
        if (text === null) return; // accidental tap
        insert(text);
      }

      /** The hold cap fired: end the take now so the result is not lost. */
      function releaseFromLimit(session) {
        if (sessionRef.current !== session) return;
        sessionRef.current = null;
        if (phaseRef.current !== 'recording') return;
        moveTo('busy');
        finishSession(session);
      }

      async function begin(event, fromKey) {
        if (event !== null && event !== undefined && event.button !== undefined && event.button !== 0) return;
        if (phaseRef.current !== 'idle') return;
        if (fromKey !== true) {
          // A pointer press belongs to this button; a key press must leave the
          // browser's own Alt and Enter handling alone.
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch (ignored) { /* synthetic pointers have no capture */ }
        }
        moveTo('starting');
        // Refresh in the background: the threshold is only read when the take
        // ends, so waiting here would delay the microphone for no reason.
        fetchSettings().then(function apply(next) {
          if (next === null) return;
          settingsRef.current = next;
          setSettings(next);
        });
        var session = createSession();
        session.minHoldMs = fromKey === true
          ? Math.min(ALT_MIN_HOLD_MS, settingsRef.current.minHoldMs)
          : settingsRef.current.minHoldMs;
        session.onLimit = function onLimit() { releaseFromLimit(session); };
        sessionRef.current = session;
        try {
          await session.start();
        } catch (cause) {
          sessionRef.current = null;
          session.abort();
          moveTo('idle');
          showNotice('error', messageOf(cause));
          return;
        }
        if (session.aborted) {
          sessionRef.current = null;
          moveTo('idle');
          return;
        }
        moveTo('recording');
      }

      function release() {
        var session = sessionRef.current;
        sessionRef.current = null;
        if (session === null) {
          if (phaseRef.current === 'starting') moveTo('idle');
          return;
        }
        if (phaseRef.current === 'starting') {
          // Let go before the microphone opened: that is a tap, not a take.
          session.abort();
          moveTo('idle');
          return;
        }
        moveTo('busy');
        finishSession(session);
      }

      /** Drop the take without transcribing: another key joined, or focus left. */
      function cancel() {
        var session = sessionRef.current;
        sessionRef.current = null;
        if (session === null) return;
        session.abort();
        moveTo('idle');
      }

      // Holding Alt behaves exactly like holding the button, so the composer can
      // be dictated without reaching for the pointer.
      var holdRef = React.useRef(null);
      holdRef.current = { begin: begin, release: release, cancel: cancel };
      var altTimerRef = React.useRef(null);

      React.useEffect(function listenAlt() {
        /** The composer container: the nearest ancestor of this button that also holds an editor. */
        function composerBox() {
          var button = buttonRef.current;
          if (button === null) return null;
          var node = button.parentElement;
          for (var depth = 0; depth < 12 && node !== null && node !== undefined; depth += 1) {
            if (node === document.body || node === document.documentElement) return null;
            if (typeof node.querySelector === 'function'
              && node.querySelector('[contenteditable="true"], textarea') !== null) return node;
            node = node.parentElement;
          }
          return null;
        }
        /**
         * Alt only dictates while the caret sits in a text-entry surface: the
         * composer editor, or this button. Anywhere else on the page the key keeps
         * its usual meaning, which is what stops stray Alt presses from recording.
         *
         * The check deliberately does not depend on the composer's DOM shape: the
         * editor is the only text-entry surface on screen in practice, so matching
         * the focused element is both simpler and far less brittle than walking up
         * from this button looking for an ancestor.
         */
        function caretHere() {
          var active = document.activeElement;
          if (active === null || active === undefined) return false;
          var button = buttonRef.current;
          if (button !== null && active === button) return true;
          if (active.isContentEditable === true) return true;
          if (typeof active.matches === 'function'
            && active.matches('textarea, input, [contenteditable="true"], [contenteditable=""]')) return true;
          var box = composerBox();
          return box !== null && box.contains(active);
        }
        /** True when Alt went down and came back up before the microphone opened. */
        function disarm() {
          if (altTimerRef.current === null) return false;
          clearTimeout(altTimerRef.current);
          altTimerRef.current = null;
          return true;
        }
        function onDown(event) {
          if (event.key !== 'Alt' || event.repeat) return;
          if (event.isComposing) return;
          if (!caretHere()) return;
          if (altTimerRef.current !== null) return;
          if (phaseRef.current !== 'idle') return;
          // Consume the press so the window does not treat it as a menu key.
          // Only after the guard above: an Alt tap that was never going to
          // dictate must still reach the browser's own Alt shortcuts.
          event.preventDefault();
          // Alt is the prefix of Alt+Tab and friends, so nothing opens until the
          // key is held long enough to mean dictation.
          altTimerRef.current = setTimeout(function arm() {
            altTimerRef.current = null;
            // The keydown event is long gone; the microphone only needs a flag.
            holdRef.current.begin(null, true);
          }, ALT_ARM_MS);
        }
        function onOtherKey(event) {
          // Another key joined: this is a shortcut, not dictation.
          if (event.key === 'Alt') return;
          if (disarm()) return;
          if (sessionRef.current === null) return;
          holdRef.current.cancel();
        }
        function onUp(event) {
          if (event.key !== 'Alt') return;
          if (disarm()) return;
          holdRef.current.release();
        }
        function onBlur() {
          // The keyup of an Alt+Tab lands in another window; end the take here.
          if (disarm()) return;
          holdRef.current.cancel();
        }
        window.addEventListener('keydown', onDown, true);
        window.addEventListener('keydown', onOtherKey, true);
        window.addEventListener('keyup', onUp, true);
        window.addEventListener('blur', onBlur);
        return function stopListening() {
          disarm();
          window.removeEventListener('keydown', onDown, true);
          window.removeEventListener('keydown', onOtherKey, true);
          window.removeEventListener('keyup', onUp, true);
          window.removeEventListener('blur', onBlur);
        };
      }, []);

      function onKeyDown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (phaseRef.current !== 'idle') return;
        event.preventDefault();
        begin(event);
      }

      function onKeyUp(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        release();
      }

      var label = phase === 'recording' ? translate('release')
        : phase === 'busy' ? translate('busy') : translate('hold');
      var button = h('button', {
        ref: buttonRef,
        type: 'button',
        className: 'dsh-wbvi',
        'data-phase': phase,
        'data-effect': settings.effect ? 'on' : 'off',
        style: { '--dsh-wbvi-ring': settings.ringColor },
        title: label,
        'aria-label': label,
        disabled: phase === 'busy' || phase === 'starting',
        onPointerDown: begin,
        onPointerUp: release,
        onPointerCancel: release,
        onLostPointerCapture: release,
        onContextMenu: function blockMenu(event) { event.preventDefault(); },
        onKeyDown: onKeyDown,
        onKeyUp: onKeyUp,
      },
        h(MicIcon),
        phase === 'recording' ? h('span', { className: 'dsh-wbvi-dot' }) : null,
        phase === 'busy' ? h('span', { className: 'dsh-wbvi-spin' }) : null,
      );

      if (notice === null) return button;
      return h(React.Fragment, null, button, h(Notice, notice));
    }

    /* ------------------------------------------------------------------ apply */

    /**
     * The bundle's own settings page.
     *
     * `plugins.bundle.config` is keyed by the npm package name, which is what
     * the plugin page looks up. The form reads the live values from the Host
     * and writes each edit back through it, so the page never has to be
     * reloaded for a change to reach the microphone.
     */
    function SettingsCard(props) {
      var state = React.useState(null);
      var values = state[0];
      var setValues = state[1];
      var statusState = React.useState('idle');
      var status = statusState[0];
      var setStatus = statusState[1];

      React.useEffect(function load() {
        var alive = true;
        fetchSettings().then(function apply(next) {
          if (alive && next !== null) setValues(next);
        });
        return function stop() { alive = false; };
      }, []);

      function save(field, value) {
        setStatus('saving');
        fetch(CONFIG_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ [field]: value }),
        })
          .then(function check(response) {
            if (!response.ok) throw new Error(translate('settingsFailed', { status: response.status }));
            return response.json();
          })
          .then(function applied(payload) {
            if (payload && payload.values) setValues(payload.values);
            else setValues(function merge(previous) {
              var next = {
                minHoldMs: previous.minHoldMs, effect: previous.effect, ringColor: previous.ringColor,
                language: previous.language, region: previous.region, accounts: previous.accounts,
              };
              next[field] = value;
              return next;
            });
            setStatus('saved');
          })
          .catch(function failed(cause) { setStatus('error:' + messageOf(cause)); });
      }

      if (values === null) return h('p', { className: 'dsh-wbvi-note' }, translate('settingsLoading'));

      var note = status === 'saving' ? translate('settingsSaving')
        : status === 'saved' ? translate('settingsSaved')
          : status.indexOf('error:') === 0 ? status.slice(6) : '';

      // Two checkboxes, one choice: whichever is ticked is the build in use.
      // International is ticked by default and stays ticked until the user picks
      // the domestic one, so an untouched install never contacts workbuddy.cn.
      function regionOption(value, label) {
        return h('label', { className: 'dsh-wbvi-row dsh-wbvi-choice' },
          h('input', {
            type: 'checkbox',
            checked: values.region === value,
            onChange: function picked(event) {
              if (!event.target.checked) return; // unticking the active one is a no-op
              save('activeRegion', value);
            },
          }),
          h('span', { className: 'dsh-wbvi-name' }, label),
        );
      }

      return h('div', { className: 'dsh-wbvi-form' },
        h('span', { className: 'dsh-wbvi-name' }, translate('fieldRegion')),
        regionOption('ai', translate('regionAi')),
        regionOption('cn', translate('regionCn')),
        h('p', { className: 'dsh-wbvi-note' }, translate('accounts', { count: values.accounts })),
        h('p', { className: 'dsh-wbvi-note' }, translate('regionHint')),
        h('label', { className: 'dsh-wbvi-row' },
          h('span', { className: 'dsh-wbvi-name' }, translate('fieldMinHold')),
          h('input', {
            type: 'number', min: 0, max: 2000, step: 10,
            value: values.minHoldMs,
            onChange: function changed(event) { save('minHoldMs', Number(event.target.value)); },
          }),
          h('span', { className: 'dsh-wbvi-unit' }, translate('unitMs')),
        ),
        h('label', { className: 'dsh-wbvi-row' },
          h('span', { className: 'dsh-wbvi-name' }, translate('fieldEffect')),
          h('input', {
            type: 'checkbox',
            checked: values.effect,
            onChange: function toggled(event) { save('effect', event.target.checked); },
          }),
        ),
        h('label', { className: 'dsh-wbvi-row' },
          h('span', { className: 'dsh-wbvi-name' }, translate('fieldColor')),
          h('input', {
            type: 'color',
            value: values.ringColor,
            onChange: function picked(event) { save('ringColor', event.target.value); },
          }),
          h('span', { className: 'dsh-wbvi-unit' }, values.ringColor),
        ),
        note === '' ? null : h('p', {
          className: 'dsh-wbvi-note',
          role: status.indexOf('error:') === 0 ? 'alert' : 'status',
        }, note),
      );
    }

    function apply(ctx) {
      ctx.effect(function installStyles() {
        var tag = document.createElement('style');
        tag.setAttribute('data-dsh-wbvi', '');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return function remove() { tag.remove(); };
      }, NS + ': styles');

      ctx.slots.inject(SLOT, function contribute() {
        return ctx.slots.register({ name: SLOT, id: 'wb-asr-mic', order: 10 }, HoldToTalk);
      });

      // The settings page lives on the bundle's own card, keyed by package name.
      ctx.slots.inject('plugins.bundle.config', function contributeSettings() {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-voice-input-wb-asr',
        }, function render(ownerProps) {
          if (ownerProps && ownerProps.view === 'summary') return null;
          return h(SettingsCard, null);
        });
      });

      // The dictionary is registered under this package's namespace; `translate`
      // keeps the built-in table until the service answers, so a profile without
      // a locale service still shows readable text.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['locale'], function bindLocale(scoped) {
          scoped.effect(function register() {
            return scoped.locale.register(NS, { zh: ZH, en: EN });
          }, NS + ': dictionaries');
          translate = scoped.locale.bind(NS);
        });
      }
    }

    return { name: NS, inject: ['slots'], apply: apply };
  },
});
