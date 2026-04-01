/**
 * content.js — Content Script
 *
 * Scans the page for <video> elements (and their <source> children),
 * then reports each discovered URL to the background service worker so
 * it can be shown in the popup.
 *
 * A MutationObserver is attached so that late-loaded video elements
 * (e.g., in SPAs or infinite-scroll pages) are also captured.
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
  }

  // Initial scan
  scanPage();

  // Watch for dynamically added/modified video elements
  const observer = new MutationObserver(() => scanPage());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
})();
