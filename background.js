/**
 * background.js — Service Worker
 *
 * Intercepts all network requests and filters for video-related URLs
 * (MP4, WebM, M3U8/HLS playlists, DASH manifests, YouTube streams).
 * Stores detected URLs keyed by tab, updates the badge counter, and
 * responds to messages from the popup and content scripts.
 *
 * YouTube note:
 *   YouTube uses adaptive streaming (DASH / HLS) which separates video
 *   and audio into distinct streams identified by the "itag" URL
 *   parameter.  All detected googlevideo.com streams are stored so the
 *   popup can show the user which quality streams are available.
 *   Merging separate video-only and audio-only streams requires an
 *   external tool such as FFmpeg or yt-dlp.
 */

// Map<tabId, Map<url, videoInfo>>
const videosByTab = new Map();

// ----- Request interception -----

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return;
    if (!isVideoUrl(url)) return;

    if (!videosByTab.has(tabId)) videosByTab.set(tabId, new Map());
    const videos = videosByTab.get(tabId);

    if (!videos.has(url)) {
      videos.set(url, {
        url,
        type: getVideoType(url),
        title: '',
        timestamp: Date.now(),
      });
      updateBadge(tabId, videos.size);
    }
  },
  { urls: ['<all_urls>'] }
);

// Clear stored videos when a tab navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    videosByTab.delete(tabId);
    updateBadge(tabId, 0);
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  videosByTab.delete(tabId);
});

// ----- Message handling -----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id;

  switch (msg.action) {
    case 'getVideos': {
      const list = tabId
        ? [...(videosByTab.get(tabId)?.values() ?? [])]
        : [];
      sendResponse({ videos: list });
      return true;
    }

    case 'addVideo': {
      if (!tabId) return;
      const { video } = msg;
      if (!videosByTab.has(tabId)) videosByTab.set(tabId, new Map());
      const videos = videosByTab.get(tabId);
      if (!videos.has(video.url)) {
        videos.set(video.url, video);
        updateBadge(tabId, videos.size);
      }
      sendResponse({ success: true });
      return true;
    }

    case 'clearVideos': {
      if (!tabId) return;
      videosByTab.delete(tabId);
      updateBadge(tabId, 0);
      sendResponse({ success: true });
      return true;
    }
  }
});

// ----- Helpers -----

/**
 * Returns true when the URL looks like it carries a video payload.
 * Individual TS segments (.ts) are excluded — callers want the playlist.
 */
function isVideoUrl(url) {
  try {
    const parsed   = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();

    // Exclude individual TS segments; we want the m3u8 playlist instead
    if (pathname.endsWith('.ts')) return false;

    const videoExtensions = ['.mp4', '.webm', '.ogg', '.m3u8', '.m3u', '.mpd', '.flv', '.mkv', '.avi', '.mov'];
    if (videoExtensions.some((ext) => pathname.endsWith(ext))) return true;

    // Match common streaming URL patterns
    if (pathname.includes('m3u8') || pathname.includes('.m3u')) return true;

    // YouTube / googlevideo streams — match hostname exactly to avoid spoofing
    if (isGooglevideo(hostname) && parsed.searchParams.has('videoplayback')) return true;
    if (isGooglevideo(hostname) && pathname.includes('videoplayback')) return true;

    return false;
  } catch {
    return false;
  }
}

/** True only for legitimate *.googlevideo.com hostnames. */
function isGooglevideo(hostname) {
  return hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com');
}

// YouTube audio-only itag values — streams with these itags carry no video track.
const YOUTUBE_AUDIO_ITAGS = new Set(['139', '140', '141', '171', '172', '249', '250', '251']);

function getVideoType(url) {
  try {
    const parsed   = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();

    if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u') || pathname.includes('m3u8')) return 'm3u8';
    if (pathname.endsWith('.mpd')) return 'dash';
    if (pathname.endsWith('.mp4')) return 'mp4';
    if (pathname.endsWith('.webm')) return 'webm';
    if (pathname.endsWith('.flv')) return 'flv';
    if (pathname.endsWith('.mkv')) return 'mkv';
    if (isGooglevideo(hostname)) {
      // YouTube audio-only itags so the popup can warn accordingly
      const itag = parsed.searchParams.get('itag');
      if (itag && YOUTUBE_AUDIO_ITAGS.has(itag)) return 'audio';
      return 'youtube';
    }
    return 'video';
  } catch {
    return 'video';
  }
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text, tabId });
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
  }
}
