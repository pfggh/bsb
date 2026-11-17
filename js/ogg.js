/* Teshrij Desk — Ogg Opus tools for voice notes. No dependencies; runs in browsers, workers, Node and Deno.
 *   DeskOgg.inspect(u8)   -> { ok, error?, channels, inputRate, preSkip, durationSec, pages, packets, eos }
 *                            Strict Ogg Opus validator (every page, CRC, sequence, headers, granules, EOS). Never throws.
 *                            `packets` counts audio packets (the two header packets are not included).
 *   DeskOgg.webmToOgg(u8) -> Uint8Array. Remuxes the Opus track of a WebM/Matroska file (Chrome/Edge/Safari
 *                            MediaRecorder output) into Ogg Opus without re-encoding. Throws Error on bad input. */
(function (root) {
  'use strict';

  const SAMPLE_RATE = 48000;          // Ogg Opus granules always count 48 kHz samples
  const PAGE_MAX_SAMPLES = 48000;     // pack at most ~1 s of audio per page
  const MAX_SAFE_HI = 0x200000;       // 64-bit granule high word must stay below 2^53 overall

  // ---------- small helpers ----------

  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return null;
  }
  const u16 = (b, p) => b[p] | (b[p + 1] << 8);
  const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  function ascii(b, p, n) { let s = ''; for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]); return s; }
  function asciiBytes(s) { const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---------- Ogg CRC32 (poly 0x04C11DB7, no reflection, init 0) ----------

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
      t[i] = r >>> 0;
    }
    return t;
  })();
  function crcUpdate(c, b, start, end) {
    for (let i = start; i < end; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
    return c;
  }
  // CRC of the page at [start, end) with its CRC field (bytes 22..25) taken as zero.
  function pageCrc(b, start, end) {
    let c = crcUpdate(0, b, start, start + 22);
    c = crcUpdate(c, [0, 0, 0, 0], 0, 4);
    return crcUpdate(c, b, start + 26, end);
  }

  // ---------- Opus packet duration (RFC 6716 §3.1) ----------

  // 48 kHz samples per frame for each TOC config (0-11 SILK, 12-15 Hybrid, 16-31 CELT).
  function frameSamples(config) {
    if (config < 12) return [480, 960, 1920, 2880][config & 3];
    if (config < 16) return [480, 960][config & 1];
    return [120, 240, 480, 960][config & 3];
  }
  // Returns the packet's sample count, or 0 if the packet is malformed.
  function packetSamples(p) {
    if (!p.length) return 0;
    const code = p[0] & 3;
    let frames = 1;
    if (code === 1 || code === 2) frames = 2;
    else if (code === 3) { if (p.length < 2) return 0; frames = p[1] & 0x3f; }
    const n = frames * frameSamples(p[0] >> 3);
    return n > 5760 ? 0 : n; // an Opus packet carries at most 120 ms
  }

  // ---------- inspect: strict Ogg Opus validator ----------

  function inspect(input) {
    try { return inspectImpl(input); } catch (e) { return { ok: false, error: 'invalid file (' + (e && e.message) + ')' }; }
  }

  function inspectImpl(input) {
    const b = toU8(input);
    if (!b) return { ok: false, error: 'input is not binary data' };
    if (!b.length) return { ok: false, error: 'empty file' };
    if (b.length < 4 || ascii(b, 0, 4) !== 'OggS') return { ok: false, error: 'not an Ogg file' };

    const res = { ok: false, pages: 0, packets: 0, eos: false };
    const fail = (msg) => { res.error = msg; return res; };
    let pos = 0, serial = -1, lastGranule = 0, sawEos = false;
    let packetIndex = 0;       // packets completed so far (0 = OpusHead, 1 = OpusTags, then audio)
    let pending = false;       // the last packet of the previous page continues on this page
    let headerParts = [];      // collected pieces of the current header packet

    while (pos < b.length) {
      const n = res.pages; // page index
      if (sawEos) return fail('trailing data after end-of-stream page');
      if (b.length - pos < 27) return fail('truncated page ' + n);
      if (ascii(b, pos, 4) !== 'OggS') return fail(n ? 'garbage after page ' + (n - 1) : 'not an Ogg file');
      if (b[pos + 4] !== 0) return fail('unsupported Ogg version on page ' + n);
      const flags = b[pos + 5];
      const lo = u32(b, pos + 6), hi = u32(b, pos + 10);
      const noGranule = lo === 0xffffffff && hi === 0xffffffff;
      if (!noGranule && hi >= MAX_SAFE_HI) return fail('granule position too large on page ' + n);
      const granule = noGranule ? -1 : hi * 0x100000000 + lo;
      const pageSerial = u32(b, pos + 14), seq = u32(b, pos + 18), crc = u32(b, pos + 22);
      const nseg = b[pos + 26];
      if (b.length - pos < 27 + nseg) return fail('truncated page ' + n);
      let bodyLen = 0;
      for (let i = 0; i < nseg; i++) bodyLen += b[pos + 27 + i];
      const bodyStart = pos + 27 + nseg, end = bodyStart + bodyLen;
      if (end > b.length) return fail('truncated page ' + n);
      if (pageCrc(b, pos, end) !== crc) return fail('bad CRC on page ' + n);

      if (n === 0) serial = pageSerial;
      else if (pageSerial !== serial) return fail('more than one logical stream (page ' + n + ')');
      if (seq !== n) return fail('page sequence gap at page ' + n);
      if (n === 0 && !(flags & 2)) return fail('first page lacks the beginning-of-stream flag');
      if (n > 0 && (flags & 2)) return fail('unexpected beginning-of-stream flag on page ' + n);
      if ((flags & 1) && !pending) return fail('page ' + n + ' continues a packet that does not exist');
      if (!(flags & 1) && pending) return fail('packet not continued on page ' + n);

      // Walk the lacing values; a value < 255 ends a packet.
      let ended = 0, pStart = bodyStart, off = bodyStart;
      for (let i = 0; i < nseg; i++) {
        const lv = b[pos + 27 + i];
        off += lv;
        if (lv === 255) continue;
        // packet (or its last piece) is b[pStart, off)
        if (packetIndex < 2) {
          headerParts.push(b.subarray(pStart, off));
          const pkt = concat(headerParts);
          headerParts = [];
          const err = packetIndex === 0 ? checkHead(pkt, res) : checkTags(pkt);
          if (err) return fail(err);
          if (packetIndex === 0 && (n !== 0 || i !== nseg - 1)) return fail('OpusHead must be alone on the first page');
          if (packetIndex === 1 && i !== nseg - 1) return fail('audio must start on a new page after OpusTags');
        } else {
          res.packets++;
        }
        packetIndex++; ended++; pending = false; pStart = off;
      }
      if (n === 0 && ended !== 1) return fail('no OpusHead');
      if (nseg && b[pos + 27 + nseg - 1] === 255) { // last packet continues on the next page
        if (n === 0) return fail('OpusHead must be alone on the first page');
        if (packetIndex < 2) headerParts.push(b.subarray(pStart, end));
        pending = true;
      }

      if (noGranule) {
        if (ended) return fail('missing granule position on page ' + n);
      } else {
        if (packetIndex <= 2 && granule !== 0) return fail('header page ' + n + ' has a nonzero granule position');
        if (granule < lastGranule) return fail('granule position goes backwards on page ' + n);
        lastGranule = granule;
      }
      if (flags & 4) sawEos = true;
      res.pages++;
      pos = end;
    }

    res.eos = sawEos;
    if (packetIndex === 0) return fail('no OpusHead');
    if (packetIndex === 1) return fail('no OpusTags');
    if (pending) return fail('last packet is incomplete');
    if (!res.packets) return fail('no audio packets');
    if (!sawEos) return fail('missing end-of-stream page');
    res.durationSec = (lastGranule - res.preSkip) / SAMPLE_RATE;
    if (!(res.durationSec > 0)) return fail('zero or negative duration');
    res.ok = true;
    return res;
  }

  function checkHead(p, res) {
    if (p.length < 19 || ascii(p, 0, 8) !== 'OpusHead') return 'no OpusHead';
    if (p[8] !== 1) return 'unsupported OpusHead version ' + p[8];
    if (p[9] < 1 || p[9] > 2) return 'unsupported channel count ' + p[9];
    if (p[18] !== 0) return 'unsupported channel mapping family ' + p[18];
    res.channels = p[9];
    res.preSkip = u16(p, 10);
    res.inputRate = u32(p, 12);
    return null;
  }

  function checkTags(p) {
    if (p.length < 16 || ascii(p, 0, 8) !== 'OpusTags') return 'no OpusTags';
    let o = 12 + u32(p, 8); // after the vendor string
    if (o + 4 > p.length) return 'malformed OpusTags';
    const count = u32(p, o); o += 4;
    for (let i = 0; i < count; i++) {
      if (o + 4 > p.length) return 'malformed OpusTags';
      o += 4 + u32(p, o);
      if (o > p.length) return 'malformed OpusTags';
    }
    return null;
  }

  // ---------- EBML / WebM parsing ----------

  const ID = {
    EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067,
    SeekHead: 0x114d9b74, Info: 0x1549a966, Tracks: 0x1654ae6b, Cues: 0x1c53bb6b, Chapters: 0x1043a770,
    Tags: 0x1254c367, Attachments: 0x1941a469, Cluster: 0x1f43b675, Void: 0xec, CRC32: 0xbf,
    TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
    CodecDelay: 0x56aa, ContentEncodings: 0x6d80, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
    Timecode: 0xe7, SilentTracks: 0x5854, Position: 0xa7, PrevSize: 0xab, SimpleBlock: 0xa3,
    BlockGroup: 0xa0, Block: 0xa1, EncryptedBlock: 0xaf, BlockAdditions: 0x75a1, BlockDuration: 0x9b,
    ReferencePriority: 0xfa, ReferenceBlock: 0xfb, CodecState: 0xa4, DiscardPadding: 0x75a2,
  };
  // Master elements we descend into.
  const MASTER = new Set([ID.Segment, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);
  // Valid children of masters that may have an unknown size: such an element ends at the first ID not listed.
  const CHILDREN = {
    [ID.Segment]: new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Chapters, ID.Tags, ID.Attachments,
      ID.Cluster, ID.Void, ID.CRC32]),
    [ID.Cluster]: new Set([ID.Timecode, ID.SilentTracks, ID.Position, ID.PrevSize, ID.SimpleBlock,
      ID.BlockGroup, ID.EncryptedBlock, ID.Void, ID.CRC32]),
    [ID.Tracks]: new Set([ID.TrackEntry, ID.Void, ID.CRC32]),
    [ID.BlockGroup]: new Set([ID.Block, ID.BlockAdditions, ID.BlockDuration, ID.ReferencePriority,
      ID.ReferenceBlock, ID.CodecState, ID.DiscardPadding, ID.Void, ID.CRC32]),
  };

  const ONLY_SEGMENT = new Set([ID.Segment]);

  function corrupt(msg, pos) { return new Error('corrupt WebM: ' + msg + ' at byte ' + pos); }

  // Variable-length integer. ID: keeps the marker bits. Size: strips them; all-ones = unknown (-1).
  function readVint(b, pos, end, isId) {
    if (pos >= end) throw corrupt('unexpected end of data', pos);
    const first = b[pos];
    if (!first) throw corrupt('invalid ' + (isId ? 'element ID' : 'size'), pos);
    let len = 1;
    while (!(first & (0x80 >> (len - 1)))) len++;
    if (isId && len > 4) throw corrupt('invalid element ID', pos);
    if (pos + len > end) throw corrupt('unexpected end of data', pos);
    let v = isId ? first : first & (0xff >> len), allOnes = v === (0xff >> len);
    for (let i = 1; i < len; i++) {
      v = v * 256 + b[pos + i];
      if (b[pos + i] !== 0xff) allOnes = false;
    }
    return { v: !isId && allOnes ? -1 : v, n: len };
  }

  function readUint(b, s, e) { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; }
  function readSint(b, s, e) { const v = readUint(b, s, e); return e > s && b[s] & 0x80 ? v - Math.pow(2, 8 * (e - s)) : v; }
  function readFloat(b, s, e) {
    const dv = new DataView(b.buffer, b.byteOffset + s, e - s);
    return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : 0;
  }

  // Walk elements in [pos, end). `kids` set = we are inside an unknown-size parent: stop at the first ID
  // that is not one of its children. Returns where parsing stopped (= end of the unknown-size parent).
  function walk(b, pos, end, kids, h, depth) {
    if (depth > 8) throw corrupt('elements nested too deep', pos);
    while (pos < end) {
      const id = readVint(b, pos, end, true);
      if (kids && !kids.has(id.v)) return pos;
      const size = readVint(b, pos + id.n, end, false);
      const start = pos + id.n + size.n;
      if (MASTER.has(id.v)) {
        h.enter(id.v);
        if (size.v < 0) {
          if (!CHILDREN[id.v]) throw corrupt('unsupported unknown-size element 0x' + id.v.toString(16), pos);
          pos = walk(b, start, end, CHILDREN[id.v], h, depth + 1);
        } else {
          pos = start + size.v;
          if (pos > end) throw new Error('WebM is truncated (element at byte ' + start + ' runs past the end)');
          walk(b, start, pos, null, h, depth + 1);
        }
        h.exit(id.v);
      } else {
        if (size.v < 0) throw corrupt('unknown size on element 0x' + id.v.toString(16), pos);
        if (start + size.v > end) throw new Error('WebM is truncated (element at byte ' + start + ' runs past the end)');
        h.leaf(id.v, start, start + size.v);
        pos = start + size.v;
      }
    }
    return pos;
  }

  // SimpleBlock / Block payload -> { track, frames: [Uint8Array...] } (one frame per lace).
  function parseBlock(b, s, e) {
    const tn = readVint(b, s, e, false);
    let p = s + tn.n + 3; // track number, int16 timecode, flags
    if (p > e) throw corrupt('short block', s);
    const lacing = (b[p - 1] >> 1) & 3;
    if (!lacing) return { track: tn.v, frames: [b.subarray(p, e)] };
    if (p >= e) throw corrupt('short laced block', s);
    const count = b[p++] + 1, sizes = [];
    if (lacing === 1) { // Xiph: each size is a run of 255s plus a final byte
      for (let i = 0; i < count - 1; i++) {
        let sz = 0, v;
        do { if (p >= e) throw corrupt('bad Xiph lacing', s); v = b[p++]; sz += v; } while (v === 255);
        sizes.push(sz);
      }
    } else if (lacing === 3 && count > 1) { // EBML: first size, then signed differences
      let r = readVint(b, p, e, false); p += r.n;
      if (r.v < 0) throw corrupt('bad EBML lacing', s);
      sizes.push(r.v);
      for (let i = 1; i < count - 1; i++) {
        r = readVint(b, p, e, false); p += r.n;
        const sz = sizes[i - 1] + r.v - (Math.pow(2, 7 * r.n - 1) - 1);
        if (r.v < 0 || sz < 0) throw corrupt('bad EBML lacing', s);
        sizes.push(sz);
      }
    } else if (lacing === 2) { // fixed size
      if ((e - p) % count) throw corrupt('bad fixed-size lacing', s);
      for (let i = 0; i < count - 1; i++) sizes.push((e - p) / count);
    }
    const frames = [];
    for (const sz of sizes) {
      if (p + sz > e) throw corrupt('lace sizes exceed block', s);
      frames.push(b.subarray(p, p + sz)); p += sz;
    }
    frames.push(b.subarray(p, e));
    return { track: tn.v, frames };
  }

  function parseWebm(b) {
    if (b.length < 4 || readUint(b, 0, 4) !== ID.EBML) throw new Error('not a WebM file');
    // EBML header: check the DocType.
    const hid = readVint(b, 0, b.length, true), hsz = readVint(b, hid.n, b.length, false);
    const hEnd = hid.n + hsz.n + hsz.v;
    if (hsz.v < 0 || hEnd > b.length) throw corrupt('bad EBML header', 0);
    let docType = '';
    walk(b, hid.n + hsz.n, hEnd, null, { enter() {}, exit() {}, leaf(id, s, e) { if (id === ID.DocType) docType = ascii(b, s, e - s).replace(/\0+$/, ''); } }, 0);
    if (docType !== 'webm' && docType !== 'matroska') throw new Error('not a WebM file (DocType "' + docType + '")');

    const tracks = [], blocks = [];
    let track = null, group = null, sawSegment = false;
    const h = {
      enter(id) {
        if (id === ID.Segment) sawSegment = true;
        if (id === ID.TrackEntry) track = { number: 0, type: 0, codec: '', priv: null, delay: -1, channels: 1, rate: SAMPLE_RATE, encoded: false };
        if (id === ID.BlockGroup) group = { block: null, discard: 0 };
      },
      exit(id) {
        if (id === ID.TrackEntry) { tracks.push(track); track = null; }
        if (id === ID.BlockGroup) { if (group.block) { group.block.discard = group.discard; blocks.push(group.block); } group = null; }
      },
      leaf(id, s, e) {
        if (track) {
          if (id === ID.TrackNumber) track.number = readUint(b, s, e);
          else if (id === ID.TrackType) track.type = readUint(b, s, e);
          else if (id === ID.CodecID) track.codec = ascii(b, s, e - s).replace(/\0+$/, '');
          else if (id === ID.CodecPrivate) track.priv = b.subarray(s, e);
          else if (id === ID.CodecDelay) track.delay = readUint(b, s, e);
          else if (id === ID.Channels) track.channels = readUint(b, s, e);
          else if (id === ID.SamplingFrequency) track.rate = Math.round(readFloat(b, s, e));
          else if (id === ID.ContentEncodings) track.encoded = true;
        } else if (id === ID.SimpleBlock) {
          blocks.push(parseBlock(b, s, e));
        } else if (group && id === ID.Block) {
          group.block = parseBlock(b, s, e);
        } else if (group && id === ID.DiscardPadding) {
          group.discard = readSint(b, s, e);
        }
      },
    };
    // Top level: skip to the Segment; anything after it (other than another Segment) is ignored.
    let pos = hEnd;
    while (pos < b.length && !sawSegment) {
      const id = readVint(b, pos, b.length, true);
      if (id.v === ID.Segment) { walk(b, pos, b.length, ONLY_SEGMENT, h, 0); break; }
      const sz = readVint(b, pos + id.n, b.length, false);
      if (sz.v < 0) throw corrupt('unknown-size top-level element', pos);
      pos += id.n + sz.n + sz.v;
    }
    if (!sawSegment) throw new Error('WebM has no Segment');
    return { tracks, blocks };
  }

  // ---------- Ogg writer ----------

  function oggPage(flags, granule, serial, seq, segs, parts) {
    const body = concat(parts);
    const p = new Uint8Array(27 + segs.length + body.length);
    p.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0);
    if (granule < 0) p.fill(0xff, 6, 14);
    else {
      const lo = granule % 0x100000000, hi = Math.floor(granule / 0x100000000);
      for (let i = 0; i < 4; i++) { p[6 + i] = (lo >>> (8 * i)) & 0xff; p[10 + i] = (hi >>> (8 * i)) & 0xff; }
    }
    for (let i = 0; i < 4; i++) { p[14 + i] = (serial >>> (8 * i)) & 0xff; p[18 + i] = (seq >>> (8 * i)) & 0xff; }
    p[26] = segs.length;
    p.set(segs, 27);
    p.set(body, 27 + segs.length);
    const crc = pageCrc(p, 0, p.length);
    for (let i = 0; i < 4; i++) p[22 + i] = (crc >>> (8 * i)) & 0xff;
    return p;
  }

  function opusHead(channels, preSkip, rate) {
    const h = new Uint8Array(19);
    h.set(asciiBytes('OpusHead'), 0);
    h[8] = 1; h[9] = channels;
    h[10] = preSkip & 0xff; h[11] = (preSkip >> 8) & 0xff;
    for (let i = 0; i < 4; i++) h[12 + i] = (rate >>> (8 * i)) & 0xff;
    return h; // output gain 0, mapping family 0
  }

  function opusTags() {
    const vendor = asciiBytes('teshrij-desk');
    const t = new Uint8Array(8 + 4 + vendor.length + 4);
    t.set(asciiBytes('OpusTags'), 0);
    t[8] = vendor.length; // little-endian u32, vendor is short
    t.set(vendor, 12);
    return t; // comment count 0
  }

  // ---------- webmToOgg ----------

  function webmToOgg(input) {
    const b = toU8(input);
    if (!b) throw new Error('webmToOgg: input must be a Uint8Array');
    if (!b.length) throw new Error('webmToOgg: empty input');
    const { tracks, blocks } = parseWebm(b);

    const t = tracks.find((x) => x.codec === 'A_OPUS' && (!x.type || x.type === 2));
    if (!t) {
      const found = tracks.map((x) => x.codec || '?').join(', ');
      throw new Error(found ? 'WebM has no Opus audio track (found: ' + found + ')' : 'WebM has no tracks');
    }
    if (t.encoded) throw new Error('WebM Opus track is compressed or encrypted (unsupported)');

    // OpusHead: CodecPrivate when present, else synthesized from the track settings.
    let head;
    if (t.priv && t.priv.length >= 19 && ascii(t.priv, 0, 8) === 'OpusHead') head = t.priv.slice();
    else {
      const preSkip = t.delay >= 0 ? Math.round(t.delay * SAMPLE_RATE / 1e9) : 312;
      if (preSkip > 0xffff) throw new Error('WebM CodecDelay is too large');
      head = opusHead(t.channels || 1, preSkip, t.rate > 0 ? t.rate : SAMPLE_RATE);
    }
    const headErr = checkHead(head, {});
    if (headErr) throw new Error('WebM Opus header: ' + headErr);
    const preSkip = u16(head, 10);

    // Audio packets of the selected track, in file order; empty ones are dropped.
    const packets = [];
    let lastDiscard = 0;
    for (const blk of blocks) {
      if (blk.track !== t.number) continue;
      for (const f of blk.frames) {
        if (!f.length) continue;
        const n = packetSamples(f);
        if (!n) throw new Error('corrupt Opus packet in WebM (packet ' + packets.length + ')');
        packets.push({ data: f, samples: n });
      }
      lastDiscard = blk.discard || 0;
    }
    if (!packets.length) throw new Error('WebM has no Opus audio packets');

    const serial = (Math.random() * 0x100000000) >>> 0;
    const pages = [
      oggPage(2, 0, serial, 0, [head.length], [head]),
      oggPage(0, 0, serial, 1, [opusTags().length], [opusTags()]),
    ];

    // Audio pages: ≤255 lacing values and ~≤1 s each; a packet that doesn't fit continues on the next page.
    let segs = [], parts = [], pageSamples = 0, endedHere = false, cont = false, total = 0, prevGranule = 0;
    const flush = (eos, granule) => {
      pages.push(oggPage((cont ? 1 : 0) | (eos ? 4 : 0), endedHere ? granule : -1, serial, pages.length, segs, parts));
      if (endedHere) prevGranule = granule;
      segs = []; parts = []; pageSamples = 0; endedHere = false;
    };
    for (const pk of packets) {
      if (segs.length && pageSamples + pk.samples > PAGE_MAX_SAMPLES) { flush(false, total); cont = false; }
      const len = pk.data.length, laces = Math.floor(len / 255) + 1;
      for (let i = 0, off = 0; i < laces; i++) {
        if (segs.length === 255) { flush(false, total); cont = i > 0; } // full page; mid-packet => continued
        const lv = i < laces - 1 ? 255 : len % 255;
        segs.push(lv); parts.push(pk.data.subarray(off, off + lv)); off += lv;
      }
      total += pk.samples; pageSamples += pk.samples; endedHere = true;
    }
    // End trimming: DiscardPadding (ns) on the final block lowers the last granule.
    let finalGranule = total;
    if (lastDiscard > 0) finalGranule = Math.max(prevGranule, total - Math.round(lastDiscard * SAMPLE_RATE / 1e9));
    if (finalGranule <= preSkip) throw new Error('recording is too short');
    flush(true, finalGranule);
    return concat(pages);
  }

  const api = { inspect, webmToOgg };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DeskOgg = api;
})(typeof self !== 'undefined' ? self : this);
