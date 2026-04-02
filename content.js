/**
 * content.js — Content Script
 *
 * Scans the page for <video> elements (and their <source> children),
 * then reports each discovered URL to the background service worker so
 * it can be shown in the popup.
 *
 * Also scans inline <script> blocks for embedded M3U8 / HLS URLs
 * (common in video.js and similar players).
 *
 * A debounced MutationObserver is attached so that late-loaded video
 * elements (e.g., in SPAs or infinite-scroll pages) are also captured
 * without triggering excessive work on every DOM mutation.
 */

(function () {
  'use strict';

  const reportedUrls = new Set();

  function getVideoType(url) {
    try {
      const pathname = new URL(url, location.href).pathname.toLowerCase();
      if (pathname.endsWith('.m3u8') || url.includes('m3u8')) return 'm3u8';
      if (pathname.endsWith('.mp4')) return 'mp4';
      if (pathname.endsWith('.webm')) return 'webm';
      if (pathname.endsWith('.ogg')) return 'ogg';
      return 'video';
    } catch {
      return 'video';
    }
  }

  function resolveUrl(src) {
    try {
      return new URL(src, location.href).href;
    } catch {
      return src;
    }
  }

  function reportVideo(src, typeHint) {
    if (!src) return;
    const url = resolveUrl(src);
    if (reportedUrls.has(url)) return;
    reportedUrls.add(url);

    const video = {
      url,
      type: typeHint || getVideoType(url),
      title: document.title,
      source: 'dom',
    };

    chrome.runtime.sendMessage({ action: 'addVideo', video });
  }

  function scanPage() {
    // <video src="...">
    document.querySelectorAll('video[src]').forEach((el) => {
      reportVideo(el.src);
    });

    // <video><source src="..."></video>
    document.querySelectorAll('video source[src]').forEach((el) => {
      reportVideo(el.src, el.type ? el.type.split(';')[0] : undefined);
    });

    // <video> with currentSrc set by the browser
    document.querySelectorAll('video').forEach((el) => {
      if (el.currentSrc) reportVideo(el.currentSrc);
    });

    // Scan inline <script> blocks for embedded M3U8 / HLS URLs
    // (video.js, hls.js, and similar players often embed the URL as a string)
    document.querySelectorAll('script:not([src])').forEach((el) => {
      const text = el.textContent || '';
      const m3u8Re = /https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi;
      let match;
      while ((match = m3u8Re.exec(text)) !== null) {
        reportVideo(match[0], 'm3u8');
      }
    });
  }

  /** Debounce delay (ms) for the MutationObserver — avoids calling scanPage on every DOM mutation. */
  const SCAN_DEBOUNCE_MS = 300;

  // ----- Debounced MutationObserver -----

  let _scanTimer = null;
  function scheduleScan() {
    clearTimeout(_scanTimer);
    _scanTimer = setTimeout(scanPage, SCAN_DEBOUNCE_MS);
  }

  // Initial scan
  scanPage();

  // Watch for dynamically added/modified video elements
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
})();
