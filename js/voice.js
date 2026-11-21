/* Teshrij Desk — voice note recorder. Whatever the browser, the result is one OGG/Opus mono file
 * (what WhatsApp needs to show a voice note), checked page by page before anyone can send it.
 *
 * Engines, tried in this order (the first one that starts wins):
 *   wasm     opus-recorder (self-hosted in js/vendor/opus-recorder, WebAssembly encoder in an
 *            AudioWorklet or a Worker). Needs 'wasm-unsafe-eval' in the page CSP.
 *   mr-webm  the browser's own MediaRecorder (WebM/Opus), remuxed to Ogg by DeskOgg — no re-encoding.
 *   mr-ogg   MediaRecorder writing Ogg/Opus itself (Firefox).
 * wasm and the first MediaRecorder kind start together on the same microphone, and the recording
 * begins as soon as either one runs (the browser's own recorder is there at once; the WASM encoder
 * needs its files first, which used to hold "Starting the microphone…" on screen for seconds on a
 * slow line). On stop the WASM file is sent unless it is broken, starved or missed the beginning.
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
    let startedAt = 0, peak = 0, meterLive = false;
    let startP = null, stopP = null, cancelled = false, released = false, closed = false, wake = null;
    const live = [];                 // engines that are recording
    // what happened, for the desk's own log (times in ms; never any sound)
    const stats = { micMs: null, firstMs: null, engines: {}, errors: {}, picked: null };
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
          setTimeout(() => { if (ctx && ctx.state !== 'running' && live.length && live.every((e) => e.engine === 'wasm')) autoStop('audio interrupted'); }, 1500);
        };
      }
    }

    function release() {
      if (released) return;
      released = true; closed = true;
      clearInterval(meterTimer); clearTimeout(maxTimer);
      for (const e of live) e.cancel();
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
          const t0 = Date.now();
          stream = await mic;
          stats.micMs = Date.now() - t0;
          if (cancelled) throw fail('failed', 'cancelled');
          if (!stream.getAudioTracks().length) throw fail('no-mic');
          meter();
          const t1 = Date.now();
          let lastErr = null;
          // one engine: null when it did not start; an engine that arrives after the end is closed again
          const tryStart = (engine) => startEngine(engine, pre).then((e) => {
            if (closed) { e.cancel(); return null; }
            e.at = Date.now(); stats.engines[engine] = e.at - t1; live.push(e);
            return e;
          }, (e) => {
            lastErr = e; stats.errors[engine] = String((e && e.message) || e).slice(0, 120);
            log(engine, 'did not start:', e && e.message);
            return null;
          });
          const jobs = [];
          if (engines.includes('wasm')) jobs.push(tryStart('wasm'));
          const mrs = engines.filter((e) => e !== 'wasm');
          if (mrs.length) jobs.push((async () => { for (const m of mrs) { const e = await tryStart(m); if (e || closed) return e; } return null; })());
          // the first one that runs starts the recording; the other joins when it is ready
          const first = await new Promise((res) => {
            let left = jobs.length;
            wake = () => res(null);   // cancel() does not wait for an engine that is still starting
            if (!left) res(null);
            for (const j of jobs) j.then((e) => { if (e) res(e); else if (--left === 0) res(null); });
          });
          if (cancelled) throw fail('failed', 'cancelled');
          if (!first) throw fail(o.engine ? 'unsupported' : 'failed', lastErr && lastErr.message);
          startedAt = first.at;
          stats.firstMs = startedAt - t0;
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
        if (cancelled) throw fail('failed', 'cancelled');
        state('stopping');
        clearTimeout(maxTimer);
        const wallSec = (Date.now() - startedAt) / 1000;
        if (wallSec * 1000 < MIN_MS) { release(); throw fail('too-short'); }
        closed = true;               // an engine still starting is not waited for
        const list = live.slice();
        const attempt = (e) => e.stop().then(
          (bytes) => ({ engine: e.engine, bytes, info: inspect(bytes) }),
          (err) => ({ engine: e.engine, info: { ok: false, error: err && err.message } }));
        const dur = (t) => (t.info.durationSec == null ? wallSec : t.info.durationSec);
        const usable = (t) => t.info.ok && dur(t) >= 0.4;
        // All recorders stop at once. With the browser's own recording in hand, a WASM encoder
        // that does not hand over its file within 3 s is not waited for any longer.
        const others = list.length > 1;
        const tried = await Promise.all(list.map((e) => (e.engine === 'wasm' && others
          ? Promise.race([attempt(e), new Promise((res) => setTimeout(() => res({ engine: e.engine, info: { ok: false, error: 'slow to finish' } }), 3000))])
          : attempt(e))));
        release();
        for (const t of tried) if (!t.info.ok) { log(t.engine, 'output rejected:', t.info.error); stats.errors[t.engine] = String(t.info.error || '').slice(0, 120); }
        const good = tried.filter(usable);
        if (!good.length) throw fail('failed', tried.map((t) => `${t.engine}: ${t.info.error || 'too short'}`).join('; '));
        // WASM first (the file WhatsApp has always taken from us), unless another recording holds
        // clearly more of what was said: the encoder started late or was starved.
        let pick = good.find((t) => t.engine === 'wasm') || good[0];
        for (const t of good) if (dur(t) > dur(pick) + 0.25) pick = t;
        stats.picked = pick.engine;
        stats.durations = Object.fromEntries(tried.map((t) => [t.engine, t.info.ok ? Math.round(dur(t) * 10) / 10 : null]));
        stats.wallSec = Math.round(wallSec * 10) / 10;
        state('ready');
        return {
          blob: new Blob([pick.bytes], { type: 'audio/ogg' }), bytes: pick.bytes, mime: 'audio/ogg', engine: pick.engine,
          durationSec: dur(pick), peak: meterLive ? peak : null, silent: meterLive && peak < 0.01, stats,
        };
      })();
      stopP.catch(() => { if (phase !== 'ready') state('idle'); });
      return stopP;
    }

    function cancel() {
      cancelled = true;
      try { release(); } catch (e) { log(e); }
      if (wake) wake();
      if (phase !== 'idle') state('idle');
    }

    return { start, stop, cancel, get phase() { return phase; }, get stats() { return stats; } };
  }

  // Can this browser play our Ogg/Opus preview? (Safari before 17/18 cannot; sending still works.)
  function canPreview() {
    try { const a = document.createElement('audio'); return !!(a.canPlayType && a.canPlayType('audio/ogg; codecs=opus')); } catch (e) { return false; }
  }

  // ---- playback that works everywhere
  // Browsers that play Ogg/Opus get a plain <audio>. The others (older Safari / iOS) get a Play
  // button: the file is decoded with ogg-opus-decoder (self-hosted, WebAssembly) into a WAV, which
  // every browser plays, and the button turns into a normal player.
  const DEC_SRC = new URL('../ogg-opus-decoder/ogg-opus-decoder.min.js', BASE).href;
  let decLoading = null;
  function loadDecoder() {
    const lib = () => window['ogg-opus-decoder'] && window['ogg-opus-decoder'].OggOpusDecoder;
    if (lib()) return Promise.resolve(lib());
    if (!decLoading) {
      decLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = DEC_SRC; s.async = true;
        s.onload = () => (lib() ? res(lib()) : rej(new Error('decoder did not load')));
        s.onerror = () => { s.remove(); rej(new Error('decoder could not load')); };
        document.head.append(s);
      }).catch((e) => { decLoading = null; throw e; });
    }
    return decLoading;
  }
  // mono 16-bit WAV at 24 kHz (half of Opus' 48 kHz: plenty for speech, half the memory)
  function toWav(channels, rate) {
    const ch = channels[0] || new Float32Array(0), other = channels[1];
    const step = rate >= 44100 ? 2 : 1, outRate = rate / step;
    const n = Math.floor(ch.length / step);
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0, o = 44; i < n; i++, o += 2) {
      let x = 0;
      for (let k = 0; k < step; k++) { const j = i * step + k; x += other ? (ch[j] + other[j]) / 2 : ch[j]; }
      x /= step;
      v.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  async function decodeToWav(url) {
    const [Dec, data] = await Promise.all([loadDecoder(), fetch(url, { credentials: 'omit' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })]);
    const dec = new Dec();
    try {
      await dec.ready;
      const out = await dec.decodeFile(new Uint8Array(data));
      if (!out || !out.samplesDecoded) throw new Error('nothing decoded');
      return toWav(out.channelData, out.sampleRate);
    } finally { try { dec.free(); } catch (e) { /* gone */ } }
  }
  // player(url, { latest }) -> { el, audio }   audio = the <audio> element when there is one at once
  // (callers keep it across re-renders); latest() gives the freshest link when the button is pressed.
  function player(url, opts) {
    const o = opts || {};
    if (canPreview()) {
      const audio = document.createElement('audio');
      audio.controls = true; audio.preload = o.preload || 'none'; audio.src = url;
      return { el: audio, audio };
    }
    const wrap = document.createElement('div');
    wrap.className = 'vplayer';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn sm vplay'; btn.textContent = '▶ Play voice note';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const wav = URL.createObjectURL(await decodeToWav((o.latest && o.latest()) || url));
        const audio = document.createElement('audio');
        audio.controls = true; audio.src = wav;
        wrap.replaceChildren(audio);
        audio.play().catch(() => {});
      } catch (e) {
        log('play', e && e.message);
        btn.disabled = false; btn.textContent = '▶ Play voice note';
        const a = document.createElement('a');
        a.href = (o.latest && o.latest()) || url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = ' Download';
        if (!wrap.querySelector('a')) wrap.append(a);
      }
    });
    wrap.append(btn);
    return { el: wrap, audio: null };
  }

  window.DeskVoice = { support, create, preload, canPreview, player, VoiceError };
})();
