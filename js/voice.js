/* Teshrij Desk — voice note recorder. Whatever the browser, the result is one OGG/Opus mono file
 * (what WhatsApp needs to show a voice note), checked page by page before anyone can send it.
 *
 * Engines, tried in this order (the first one that starts wins):
 *   wasm     opus-recorder (self-hosted in js/vendor/opus-recorder, WebAssembly encoder in an
 *            AudioWorklet or a Worker). Needs 'wasm-unsafe-eval' in the page CSP.
 *   mr-webm  the browser's own MediaRecorder (WebM/Opus), remuxed to Ogg by DeskOgg — no re-encoding.
 *   mr-ogg   MediaRecorder writing Ogg/Opus itself (Firefox).
 * While wasm records, a MediaRecorder runs on the same microphone as a backup: if the WASM file
 * comes out broken or starved (audio engine suspended mid-way), the backup is used instead.
 *
 * DeskVoice.create(opts) -> { start(), stop(), cancel() }; see the bottom of the file. Needs js/ogg.js first.
 */
(function () {
  'use strict';

  const here = document.currentScript && document.currentScript.src;
  const BASE = here ? new URL('vendor/opus-recorder/', here).href : 'js/vendor/opus-recorder/';
  const MIN_MS = 800;
  const MR_TYPES = { 'mr-webm': 'audio/webm;codecs=opus', 'mr-ogg': 'audio/ogg;codecs=opus' };

  class VoiceError extends Error {
    constructor(code, message) { super(message); this.name = 'VoiceError'; this.code = code; }
  }
  const MESSAGES = {
    insecure: 'The microphone needs https',
    unsupported: 'This browser cannot record voice notes — update it, or use Chrome, Edge, Firefox or Safari',
    denied: 'Microphone permission was refused — allow it for this site in the browser settings',
    'no-mic': 'No microphone was found',
    'mic-busy': 'The microphone is busy or blocked (another app or tab may be using it)',
    'too-short': 'Too short — hold on a bit longer',
    failed: 'The voice note could not be recorded',
  };
  const fail = (code, detail) => new VoiceError(code, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);

  function toVoiceError(e) {
    if (e instanceof VoiceError) return e;
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return fail('denied');
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return fail('no-mic');
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return fail('mic-busy');
    return fail('failed', e && e.message ? String(e.message).slice(0, 120) : String(e));
  }

  const Ctx = () => window.AudioContext || window.webkitAudioContext;
  const log = (...a) => { try { console.warn('[voice]', ...a); } catch (e) { /* no console */ } };
  const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

  // Can this page compile WebAssembly? (a CSP without 'wasm-unsafe-eval' says no)
  let wasmOk = null;
  function wasmAllowed() {
    if (wasmOk === null) {
      try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); wasmOk = true; } catch (e) { wasmOk = false; }
    }
    return wasmOk;
  }
  function mrSupports(type) {
    try { return typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type); } catch (e) { return false; }
  }

  function support() {
    if (!window.isSecureContext) return { ok: false, engines: [], reason: 'insecure' };
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return { ok: false, engines: [], reason: 'unsupported' };
    const engines = [];
    const C = Ctx();
    const worklet = typeof window.AudioWorkletNode === 'function';
    if (C && typeof WebAssembly === 'object' && wasmAllowed() && (worklet || typeof Worker === 'function')) engines.push('wasm');
    if (window.DeskOgg && mrSupports(MR_TYPES['mr-webm'])) engines.push('mr-webm');
    if (mrSupports(MR_TYPES['mr-ogg'])) engines.push('mr-ogg');
    return engines.length ? { ok: true, engines } : { ok: false, engines, reason: 'unsupported' };
  }

  // ---- vendor scripts (loaded once; a failed load can be retried)
  let loading = null;
  function preload(base = BASE) {
    if (window.Recorder) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = base + 'recorder.min.js';
      s.async = true;
      s.onload = () => (window.Recorder ? res() : rej(new Error('recorder did not load')));
      s.onerror = () => { s.remove(); rej(new Error('recorder could not load')); };
      document.head.append(s);
      // warm the HTTP cache for the encoder (the AudioWorklet / Worker fetches it on start)
      try { fetch(base + 'encoderWorker.min.js', { credentials: 'same-origin' }).catch(() => {}); } catch (e) { /* old browser */ }
    }).catch((e) => { loading = null; throw e; });
    return loading;
  }

  // The microphone: mono with the usual voice processing; any browser that dislikes the
  // constraints gets a plain request instead.
  function getMic() {
    const md = navigator.mediaDevices;
    return md.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .catch((e) => {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'TypeError' || e.name === 'NotFoundError')) return md.getUserMedia({ audio: true });
        throw e;
      });
  }

  function inspect(bytes) {
    if (window.DeskOgg) return window.DeskOgg.inspect(bytes);
    // without ogg.js: at least the Ogg + OpusHead signature
    const head = String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 64)));
    return head.startsWith('OggS') && head.includes('OpusHead') ? { ok: true, durationSec: null } : { ok: false, error: 'not an Ogg/Opus file' };
  }

  function create(opts) {
    const o = Object.assign({ maxMs: 5 * 60 * 1000, base: BASE }, opts || {});
    let phase = 'idle';
    let stream = null, ctx = null, meterSrc = null, analyser = null, sink = null, meterTimer = null, maxTimer = null;
    let primary = null, backup = null, startedAt = 0, peak = 0, meterLive = false;
    let startP = null, stopP = null, cancelled = false, released = false;
    const state = (p) => { phase = p; try { if (o.onState) o.onState(p); } catch (e) { log(e); } };

    // ---- engines: each returns { engine, stop(): Promise<Uint8Array>, cancel() }
    async function wasmEngine(pre) {
      const preErr = await pre;
      if (preErr instanceof Error || !window.Recorder) await preload(o.base); // retry once
      if (!ctx) throw new Error('no audio engine');
      if (ctx.state !== 'running') await timeout(ctx.resume(), 1500, 'audio engine suspended').catch(() => {});
      if (ctx.state !== 'running') throw new Error('audio engine suspended');
      const rec = new window.Recorder({
        sourceNode: ctx.createMediaStreamSource(stream), encoderPath: o.base + 'encoderWorker.min.js',
        numberOfChannels: 1, encoderSampleRate: 48000, encoderBitRate: 32000, encoderApplication: 2048,
        encoderFrameSize: 20, maxFramesPerPage: 40, streamPages: false, monitorGain: 0,
      });
      let file = null;
      rec.ondataavailable = (arr) => { file = arr; };
      const cancel = () => { try { rec.ondataavailable = null; rec.close(); } catch (e) { /* gone */ } };
      try { await timeout(rec.start(), 8000, 'the encoder did not start'); } catch (e) { cancel(); throw e; }
      return {
        engine: 'wasm', cancel,
        async stop() {
          await timeout(rec.stop(), 10000, 'the encoder did not finish');
          if (!file || !file.length) throw new Error('the encoder returned nothing');
          return new Uint8Array(file);
        },
      };
    }
    async function mrEngine(engine) {
      const type = MR_TYPES[engine];
      if (!mrSupports(type) || (engine === 'mr-webm' && !window.DeskOgg)) throw new Error(`${engine} not supported`);
      const mr = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
      const chunks = [];
      let error = null;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onerror = (e) => { error = (e && e.error) || new Error('recorder error'); log(engine, error); };
      await timeout(new Promise((res, rej) => {
        mr.onstart = res;
        try { mr.start(1000); } catch (e) { rej(e); }
      }), 4000, 'the recorder did not start');
      let halted = null;
      // halt(): stop recording and collect the data (cheap); stop(): halt + build the Ogg file
      const halt = () => halted || (halted = mr.state === 'inactive' ? Promise.resolve()
        : timeout(new Promise((res) => { mr.onstop = res; mr.stop(); }), 8000, 'the recorder did not finish'));
      const cancel = () => { try { if (!halted) { mr.ondataavailable = null; mr.onstop = null; if (mr.state !== 'inactive') mr.stop(); } } catch (e) { /* gone */ } };
      return {
        engine, cancel, halt,
        async stop() {
          await halt();
          if (!chunks.length) throw error || new Error('the recorder returned nothing');
          const raw = new Uint8Array(await new Response(new Blob(chunks, { type })).arrayBuffer());
          return engine === 'mr-webm' ? window.DeskOgg.webmToOgg(raw) : raw;
        },
      };
    }
    function startEngine(engine, pre) {
      return engine === 'wasm' ? wasmEngine(pre) : mrEngine(engine);
    }

    // ---- live input level (also tells us whether any sound was picked up)
    function meter() {
      if (!ctx) return;
      try {
        meterSrc = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        sink = ctx.createGain();
        sink.gain.value = 0;
        meterSrc.connect(analyser); analyser.connect(sink); sink.connect(ctx.destination); // Safari only runs connected nodes
        const buf = new Uint8Array(analyser.fftSize);
        meterTimer = setInterval(() => {
          if (ctx.state !== 'running') return;
          analyser.getByteTimeDomainData(buf);
          let m = 0;
          for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - 128); if (d > m) m = d; }
          const v = Math.min(1, m / 128);
          meterLive = true;
          if (phase === 'recording') peak = Math.max(peak, v);
          try { if (o.onLevel) o.onLevel(v); } catch (e) { log(e); }
        }, 80);
      } catch (e) { log('meter', e); }
    }

    // ---- stop by itself: max length, microphone gone, audio engine interrupted (iOS call, etc.)
    function autoStop(reason) {
      if (phase !== 'recording' || stopP) return;
      log('auto stop:', reason);
      const p = stop();
      p.catch(() => {});
      try { if (o.onAutoStop) o.onAutoStop(reason); } catch (e) { log(e); }
    }
    function watch() {
      for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => autoStop('microphone disconnected'));
      if (ctx) {
        ctx.onstatechange = () => {
          if (phase !== 'recording' || !ctx || ctx.state === 'running' || ctx.state === 'closed') return;
          ctx.resume().catch(() => {});
          // a WASM-only recording gets no sound while the engine is stopped: keep what we have
          setTimeout(() => { if (ctx && ctx.state !== 'running' && primary && primary.engine === 'wasm' && !backup) autoStop('audio interrupted'); }, 1500);
        };
      }
    }

    function release() {
      if (released) return;
      released = true;
      clearInterval(meterTimer); clearTimeout(maxTimer);
      for (const e of [primary, backup]) if (e) e.cancel();
      try { if (meterSrc) meterSrc.disconnect(); if (analyser) analyser.disconnect(); if (sink) sink.disconnect(); } catch (e) { /* gone */ }
      if (stream) stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* gone */ } });
      if (ctx) { ctx.onstatechange = null; if (ctx.state !== 'closed') ctx.close().catch(() => {}); }
      stream = null; ctx = null;
    }

    function start() {
      if (startP) return startP;
      const sup = support();
      if (!sup.ok) return Promise.reject(fail(sup.reason));
      const engines = o.engine ? [o.engine] : sup.engines;
      state('starting');
      // Synchronous part, still inside the click: the audio engine and the microphone request.
      // iOS / Safari only let an AudioContext run when it is created or resumed in a user gesture.
      try {
        const C = Ctx();
        ctx = C ? new C() : null;
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
      } catch (e) { ctx = null; }
      const mic = getMic();
      const pre = engines.includes('wasm') ? preload(o.base).then(() => null, (e) => e) : null;
      startP = (async () => {
        try {
          stream = await mic;
          if (cancelled) throw fail('failed', 'cancelled');
          if (!stream.getAudioTracks().length) throw fail('no-mic');
          meter();
          let lastErr = null;
          for (const engine of engines) {
            try { primary = await startEngine(engine, pre); break; } catch (e) { lastErr = e; log(engine, 'did not start:', e && e.message); }
            if (cancelled) throw fail('failed', 'cancelled');
          }
          if (!primary) throw fail(o.engine ? 'unsupported' : 'failed', lastErr && lastErr.message);
          if (primary.engine === 'wasm' && !o.engine) {
            const b = engines.find((e) => e !== 'wasm');
            if (b) { try { backup = await startEngine(b); } catch (e) { log('backup', b, 'did not start:', e && e.message); } }
          }
          if (cancelled) throw fail('failed', 'cancelled');
          startedAt = Date.now();
          maxTimer = setTimeout(() => autoStop('maximum length'), o.maxMs);
          watch();
          state('recording');
        } catch (e) {
          release();
          state('idle');
          throw toVoiceError(e);
        }
      })();
      return startP;
    }

    function stop() {
      if (stopP) return stopP;
      stopP = (async () => {
        if (!startP) throw fail('failed', 'not recording');
        await startP;
        state('stopping');
        clearTimeout(maxTimer);
        const wallSec = (Date.now() - startedAt) / 1000;
        if (wallSec * 1000 < MIN_MS) { release(); throw fail('too-short'); }
        const attempt = (e) => e.stop().then(
          (bytes) => ({ engine: e.engine, bytes, info: inspect(bytes) }),
          (err) => ({ engine: e.engine, info: { ok: false, error: err && err.message } }));
        const dur = (t) => (t.info.durationSec == null ? wallSec : t.info.durationSec);
        const usable = (t) => t.info.ok && dur(t) >= 0.4;
        // Both recorders stop at once and the microphone is released right away; the backup's
        // file is only built when the primary one is broken or clearly short (encoder starved).
        const backHalt = backup && backup.halt ? backup.halt().catch(() => {}) : null;
        const tried = [await attempt(primary)];
        if (backHalt) await backHalt;
        release();
        if (backup && (!usable(tried[0]) || dur(tried[0]) < wallSec * 0.7)) tried.push(await attempt(backup));
        for (const t of tried) if (!t.info.ok) log(t.engine, 'output rejected:', t.info.error);
        const good = tried.filter(usable);
        if (!good.length) throw fail('failed', tried.map((t) => `${t.engine}: ${t.info.error || 'too short'}`).join('; '));
        let pick = good[0];
        if (good.length > 1 && dur(good[1]) > dur(pick)) pick = good[1];
        state('ready');
        return {
          blob: new Blob([pick.bytes], { type: 'audio/ogg' }), bytes: pick.bytes, mime: 'audio/ogg', engine: pick.engine,
          durationSec: dur(pick), peak: meterLive ? peak : null, silent: meterLive && peak < 0.01,
        };
      })();
      stopP.catch(() => { if (phase !== 'ready') state('idle'); });
      return stopP;
    }

    function cancel() {
      cancelled = true;
      try { release(); } catch (e) { log(e); }
      if (phase !== 'idle') state('idle');
    }

    return { start, stop, cancel, get phase() { return phase; } };
  }

  // Can this browser play our Ogg/Opus preview? (Safari before 17/18 cannot; sending still works.)
  function canPreview() {
    try { const a = document.createElement('audio'); return !!(a.canPlayType && a.canPlayType('audio/ogg; codecs=opus')); } catch (e) { return false; }
  }

  window.DeskVoice = { support, create, preload, canPreview, VoiceError };
})();
