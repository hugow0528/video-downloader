/**
 * m3u8-downloader.js
 *
 * Self-contained HLS / M3U8 downloader that runs entirely in the browser.
 *
 * Capabilities:
 *  - Parses master playlists (multi-quality) and selects the highest bandwidth stream
 *  - Parses media playlists and downloads every segment in order
 *  - Decrypts AES-128 encrypted segments using the Web Crypto API
 *  - Concatenates all segments into a single Uint8Array (raw MPEG-TS)
 *  - Returns a Blob that can be turned into a download URL
 *
 * Usage (from popup.js):
 *   const dl = new M3U8Downloader(url, { onProgress, headers });
 *   const blob = await dl.download();
 *   const objectUrl = URL.createObjectURL(blob);
 *
 * Options:
 *   onProgress(done, total)  — called after each segment is downloaded
 *   onStatus(msg)            — human-readable status messages
 *   headers                  — extra request headers (e.g. { Referer: '...' })
 */

class M3U8Downloader {
  /**
   * @param {string} url - The URL of the m3u8 playlist (master or media)
   * @param {{ onProgress?: (done: number, total: number) => void, onStatus?: (msg: string) => void }} [options]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.onProgress = options.onProgress || (() => {});
    this.onStatus = options.onStatus || (() => {});
    /** Optional extra request headers (e.g. { Referer: 'https://example.com' }) */
    this.headers = options.headers || {};
    this._aborted = false;
    /**
     * Set to true after download() if segments were detected as fragmented MP4
     * (CMAF/fMP4).  Callers should use '.mp4' as the output extension in that case.
     */
    this.isFmp4 = false;
  }

  abort() {
    this._aborted = true;
  }

  // ---- Public API ----

  async download() {
    this.onStatus('Fetching playlist…');
    const text = await this._fetchText(this.url);

    let mediaUrl = this.url;
    let mediaText = text;

    if (this._isMasterPlaylist(text)) {
      this.onStatus('Parsing master playlist…');
      const variant = this._parseMasterPlaylist(text, this.url);
      this.onStatus(`Selected stream: ${variant.resolution || ''} ${Math.round(variant.bandwidth / 1000)} kbps`);
      mediaUrl = variant.url;
      mediaText = await this._fetchText(mediaUrl);
    }

    this.onStatus('Parsing media playlist…');
    const segments = this._parseMediaPlaylist(mediaText, mediaUrl);

    if (segments.length === 0) {
      throw new Error('No segments found in playlist.');
    }

    this.onStatus(`Downloading ${segments.length} segments…`);
    const buffers = await this._downloadSegments(segments);

    this.onStatus('Merging segments…');
    const blob = this._concat(buffers);
    this.onStatus('Done.');
    return blob;
  }

  // ---- Playlist parsing ----

  _isMasterPlaylist(text) {
    return text.includes('#EXT-X-STREAM-INF');
  }

  /**
   * Returns the highest-bandwidth variant stream.
   * @returns {{ url: string, bandwidth: number, resolution: string }}
   */
  _parseMasterPlaylist(text, baseUrl) {
    const lines = text.split('\n').map((l) => l.trim());
    const variants = [];
    let pending = null;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pending = {
          bandwidth: parseInt(this._attr(line, 'BANDWIDTH') || '0', 10),
          resolution: this._attr(line, 'RESOLUTION') || '',
        };
      } else if (pending && line && !line.startsWith('#')) {
        variants.push({ ...pending, url: this._resolveUrl(line, baseUrl) });
        pending = null;
      }
    }

    if (variants.length === 0) {
      throw new Error('No variant streams found in master playlist.');
    }

    return variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
  }

  /**
   * Returns an array of segment descriptors.
   * @returns {Array<{ url: string, sequenceNumber: number, key: object|null }>}
   */
  _parseMediaPlaylist(text, baseUrl) {
    const lines = text.split('\n').map((l) => l.trim());
    const segments = [];
    let seq = 0;
    let currentKey = null;

    const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (seqMatch) seq = parseInt(seqMatch[1], 10);

    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY:')) {
        const method = this._attr(line, 'METHOD');
        if (method === 'AES-128') {
          currentKey = {
            method,
            uri: this._attr(line, 'URI'),
            iv: this._attr(line, 'IV'),
          };
        } else {
          // METHOD=NONE
          currentKey = null;
        }
      } else if (!line.startsWith('#') && line) {
        segments.push({
          url: this._resolveUrl(line, baseUrl),
          sequenceNumber: seq++,
          key: currentKey ? { ...currentKey } : null,
        });
      }
    }

    return segments;
  }

  // ---- Segment downloading ----

  async _downloadSegments(segments) {
    const buffers = [];
    // Cache imported AES keys to avoid re-importing the same key for every segment
    const keyCache = new Map();

    for (let i = 0; i < segments.length; i++) {
      if (this._aborted) throw new Error('Download aborted.');

      const seg = segments[i];
      let buf = await this._fetchArrayBuffer(seg.url);

      // Detect container format from the first segment.
      // MPEG-TS starts with 0x47; fMP4/CMAF boxes start with a 4-byte size
      // followed by a 4-byte type such as 'ftyp', 'styp', 'moof', or 'moov'.
      if (i === 0) {
        this.isFmp4 = this._isFmp4Buffer(buf);
      }

      if (seg.key) {
        const cryptoKey = await this._getDecryptionKey(seg.key.uri, keyCache);
        buf = await this._decrypt(buf, cryptoKey, seg.key, seg.sequenceNumber);
      }

      buffers.push(buf);
      this.onProgress(i + 1, segments.length);
    }

    return buffers;
  }

  /**
   * Returns true when the buffer looks like a fragmented MP4 (fMP4 / CMAF)
   * segment rather than a raw MPEG-TS segment.
   * @param {ArrayBuffer} buffer
   * @returns {boolean}
   */
  _isFmp4Buffer(buffer) {
    if (buffer.byteLength < 8) return false;
    const bytes = new Uint8Array(buffer, 0, 8);
    // MPEG-TS sync byte is 0x47 — if the first byte is that, it is TS.
    if (bytes[0] === 0x47) return false;
    // fMP4/CMAF boxes always start with a 4-byte box size followed by a 4-byte
    // box type.  The box types below are the only ones that can legally appear
    // as the first box of an fMP4 segment:
    //   'ftyp' — File Type Box (init segment)
    //   'styp' — Segment Type Box (media segment)
    //   'moof' — Movie Fragment Box (media segment without a styp)
    //   'moov' — Movie Box (init-only stream)
    //   'emsg' — Event Message Box (DASH inband events, rare but valid)
    const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    return ['ftyp', 'styp', 'moof', 'moov', 'emsg'].includes(boxType);
  }

  async _getDecryptionKey(keyUri, cache) {
    if (cache.has(keyUri)) return cache.get(keyUri);
    const keyBuf = await this._fetchArrayBuffer(keyUri);
    const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
    cache.set(keyUri, key);
    return key;
  }

  async _decrypt(buffer, cryptoKey, keyInfo, sequenceNumber) {
    let iv;
    if (keyInfo.iv) {
      const hex = keyInfo.iv.replace(/^0x/i, '').padStart(32, '0');
      iv = new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    } else {
      // Default IV = sequence number as 16-byte big-endian integer
      iv = new Uint8Array(16);
      new DataView(iv.buffer).setUint32(12, sequenceNumber >>> 0, false);
    }

    try {
      return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buffer);
    } catch (err) {
      // Some segments have PKCS7 padding stripped; retry with a zero-padded buffer
      if (buffer.byteLength % 16 !== 0) {
        const padded = new Uint8Array(Math.ceil(buffer.byteLength / 16) * 16);
        padded.set(new Uint8Array(buffer));
        return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, padded.buffer);
      }
      throw err;
    }
  }

  // ---- Buffer utilities ----

  _concat(buffers) {
    const total = buffers.reduce((s, b) => s + b.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const buf of buffers) {
      out.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    // Use the MIME type that matches the detected container format.
    // fMP4/CMAF segments are saved as video/mp4; raw MPEG-TS as video/mp2t.
    const mimeType = this.isFmp4 ? 'video/mp4' : 'video/mp2t';
    return new Blob([out], { type: mimeType });
  }

  // ---- Fetch helpers ----

  async _fetchText(url) {
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }

  async _fetchArrayBuffer(url) {
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.arrayBuffer();
  }

  // ---- URL / attribute utilities ----

  _resolveUrl(url, base) {
    if (/^https?:\/\//i.test(url)) return url;
    try {
      return new URL(url, base).href;
    } catch {
      return url;
    }
  }

  _attr(line, name) {
    const re = new RegExp(`(?:^|,)${name}=("[^"]*"|[^,]*)`, 'i');
    const m = line.match(re);
    if (!m) return null;
    return m[1].replace(/^"|"$/g, '');
  }
}
