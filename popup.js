/**
 * popup.js — Video Downloader Pro
 *
 * Drives the popup UI:
 *  - Queries the background service worker for videos detected on the active tab
 *  - Renders a card for each video with a Download button
 *  - Handles M3U8/HLS download via M3U8Downloader (with live progress)
 *  - Handles direct file downloads (MP4, WebM, FLV, MKV, …) via chrome.downloads
 *  - Shows YouTube itag-based stream quality labels and warns about audio/video split
 *  - Refresh button re-injects content.js to rescan the page
 *  - Clear button removes all detected videos for the tab
 */

(function () {
  'use strict';

  // YouTube itag → human-readable quality label
  // Combined streams (video+audio) are preferred for direct download.
  const YT_ITAGS = {
    '17':  '144p 3GP (video+audio)',
    '18':  '360p MP4 (video+audio)',
    '22':  '720p MP4 (video+audio)',
    '36':  '240p 3GP (video+audio)',
    '43':  '360p WebM (video+audio)',
    '59':  '480p MP4 (video+audio)',
    '78':  '480p MP4 (video+audio)',
    '133': '240p MP4 (video only)',
    '134': '360p MP4 (video only)',
    '135': '480p MP4 (video only)',
    '136': '720p MP4 (video only)',
    '137': '1080p MP4 (video only)',
    '160': '144p MP4 (video only)',
    '242': '240p WebM (video only)',
    '243': '360p WebM (video only)',
    '244': '480p WebM (video only)',
    '247': '720p WebM (video only)',
    '248': '1080p WebM (video only)',
    '271': '1440p WebM (video only)',
    '278': '144p WebM (video only)',
    '313': '2160p WebM (video only)',
    '394': '144p MP4 (video only)',
    '395': '240p MP4 (video only)',
    '396': '360p MP4 (video only)',
    '397': '480p MP4 (video only)',
    '398': '720p MP4 (video only)',
    '399': '1080p MP4 (video only)',
    '139': '48 kbps M4A (audio only)',
    '140': '128 kbps M4A (audio only)',
    '141': '256 kbps M4A (audio only)',
    '171': '128 kbps WebM (audio only)',
    '172': '256 kbps WebM (audio only)',
    '249': '50 kbps WebM (audio only)',
    '250': '70 kbps WebM (audio only)',
    '251': '160 kbps WebM (audio only)',
  };

  // ---- State ----

  let currentTabId = null;
  /** @type {Map<string, M3U8Downloader>} url → active downloader */
  const activeDownloaders = new Map();

  // ---- Constants ----

  /** How long (ms) to keep an object URL alive after triggering a blob download. */
  const BLOB_URL_REVOKE_DELAY_MS = 30_000;
  /** How long (ms) to wait after re-injecting content.js before reloading the video list. */
  const RESCAN_DELAY_MS = 600;

  // ---- DOM references ----

  const videoList   = document.getElementById('video-list');
  const emptyState  = document.getElementById('empty-state');
  const statusBar   = document.getElementById('status-bar');
  const btnRefresh  = document.getElementById('btn-refresh');
  const btnClear    = document.getElementById('btn-clear');

  // ---- Initialisation ----

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;
    await loadVideos();
  }

  async function loadVideos() {
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'getVideos',
        tabId: currentTabId,
      });
      renderVideos(resp.videos || []);
    } catch (err) {
      showStatus('Could not load videos: ' + err.message, 'error');
    }
  }

  // ---- Rendering ----

  function renderVideos(videos) {
    videoList.querySelectorAll('.video-item').forEach((el) => el.remove());

    if (videos.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    for (const video of videos) {
      videoList.appendChild(createVideoItem(video));
    }
  }

  function createVideoItem(video) {
    const item = document.createElement('div');
    item.className = 'video-item';

    const displayTitle = (video.title || 'Untitled').slice(0, 60);
    const shortUrl     = shortenUrl(video.url);
    const { label: typeLabel, note, badgeClass } = describeVideo(video);

    item.innerHTML = `
      <div class="video-info">
        <span class="video-title" title="${esc(video.title || '')}">${esc(displayTitle)}</span>
        <span class="badge ${badgeClass}">${esc(typeLabel)}</span>
        <span class="video-url" title="${esc(video.url)}">${esc(shortUrl)}</span>
        ${note ? `<span class="video-note">⚠ ${esc(note)}</span>` : ''}
      </div>
      <div class="video-actions">
        <div class="progress-bar hidden">
          <div class="progress-fill"></div>
          <span class="progress-text">0%</span>
        </div>
        <button class="btn-download">⬇ Download</button>
        <button class="btn-abort hidden">✕ Cancel</button>
      </div>
    `;

    item.querySelector('.btn-download').addEventListener('click', () => handleDownload(video, item));
    item.querySelector('.btn-abort').addEventListener('click', () => handleAbort(video.url, item));

    return item;
  }

  /**
   * Returns display metadata for a video entry.
   * @returns {{ label: string, note: string|null, badgeClass: string }}
   */
  function describeVideo(video) {
    const { type, url } = video;

    if (type === 'youtube') {
      const itag    = getYouTubeItag(url);
      const quality = itag ? (YT_ITAGS[itag] || `itag ${itag}`) : 'YouTube Stream';
      const isAudioOnly   = quality.includes('audio only');
      const isVideoOnly   = quality.includes('video only');
      const isCombined    = !isAudioOnly && !isVideoOnly;
      const note = (isVideoOnly || isAudioOnly)
        ? 'Separate audio/video stream. Use yt-dlp for a merged file.'
        : null;
      return {
        label: quality,
        note,
        badgeClass: isAudioOnly ? 'badge-audio' : 'badge-youtube',
      };
    }

    if (type === 'm3u8') {
      return { label: 'HLS / M3U8', note: null, badgeClass: 'badge-m3u8' };
    }

    if (type === 'dash') {
      return {
        label: 'DASH',
        note: 'DASH manifests contain separate streams. Direct download only fetches the manifest.',
        badgeClass: 'badge-dash',
      };
    }

    return { label: type.toUpperCase(), note: null, badgeClass: `badge-${type}` };
  }

  // ---- Download handling ----

  async function handleDownload(video, item) {
    const btnDownload   = item.querySelector('.btn-download');
    const btnAbort      = item.querySelector('.btn-abort');
    const progressBar   = item.querySelector('.progress-bar');
    const progressFill  = item.querySelector('.progress-fill');
    const progressText  = item.querySelector('.progress-text');

    btnDownload.disabled = true;

    const { type, url } = video;
    const baseName = sanitiseFilename(video.title || 'video');

    if (type === 'm3u8') {
      progressBar.classList.remove('hidden');
      btnAbort.classList.remove('hidden');

      const dl = new M3U8Downloader(url, {
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          progressFill.style.width  = pct + '%';
          progressText.textContent  = `${pct}% (${done}/${total})`;
        },
        onStatus: (msg) => showStatus(msg, 'info'),
      });

      activeDownloaders.set(url, dl);

      try {
        const blob = await dl.download();
        triggerBlobDownload(blob, baseName + '.ts');
        showStatus('Download complete! (saved as .ts — convert with FFmpeg for .mp4)', 'success');
      } catch (err) {
        if (err.message === 'Download aborted.') {
          showStatus('Download cancelled.', 'info');
        } else {
          showStatus('Error: ' + err.message, 'error');
        }
      } finally {
        activeDownloaders.delete(url);
        btnDownload.disabled       = false;
        btnAbort.classList.add('hidden');
        progressBar.classList.add('hidden');
        progressFill.style.width   = '0%';
        progressText.textContent   = '0%';
      }

    } else {
      // Direct download via chrome.downloads API
      const ext      = inferExtension(url, type);
      const filename = baseName + ext;

      try {
        await chromeDownload(url, filename);
        showStatus('Download started!', 'success');
      } catch (err) {
        showStatus('Download error: ' + err.message, 'error');
      } finally {
        btnDownload.disabled = false;
      }
    }
  }

  function handleAbort(url, item) {
    const dl = activeDownloaders.get(url);
    if (dl) dl.abort();
  }

  // ---- Utilities ----

  function triggerBlobDownload(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href     = objUrl;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), BLOB_URL_REVOKE_DELAY_MS);
  }

  function chromeDownload(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename, conflictAction: 'uniquify', saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        }
      );
    });
  }

  function inferExtension(url, type) {
    try {
      const pathname = new URL(url).pathname;
      const m = pathname.match(/(\.[a-zA-Z0-9]{2,5})(?:\?|$)/);
      if (m) return m[1].toLowerCase();
    } catch { /* ignore */ }

    const map = {
      mp4: '.mp4', webm: '.webm', ogg: '.ogg',
      flv: '.flv', mkv: '.mkv',  mov: '.mov',
      avi: '.avi', dash: '.mpd', youtube: '.mp4',
    };
    return map[type] || '.mp4';
  }

  function getYouTubeItag(url) {
    try {
      return new URL(url).searchParams.get('itag');
    } catch {
      return null;
    }
  }

  function shortenUrl(url) {
    if (url.length <= 65) return url;
    return url.slice(0, 35) + '…' + url.slice(-20);
  }

  function sanitiseFilename(name) {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'video';
  }

  function esc(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  let _statusTimer = null;
  function showStatus(msg, type = 'info') {
    statusBar.textContent = msg;
    statusBar.className   = `status-bar status-${type}`;
    clearTimeout(_statusTimer);
    if (type !== 'error') {
      _statusTimer = setTimeout(() => {
        statusBar.className = 'status-bar hidden';
      }, 5000);
    }
  }

  // ---- Button listeners ----

  btnRefresh.addEventListener('click', async () => {
    if (!currentTabId) return;
    showStatus('Scanning page…', 'info');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files:  ['content.js'],
      });
      // Give the content script a moment to report back, then reload list
      setTimeout(loadVideos, RESCAN_DELAY_MS);
    } catch (err) {
      showStatus('Rescan failed: ' + err.message, 'error');
    }
  });

  btnClear.addEventListener('click', async () => {
    if (!currentTabId) return;
    await chrome.runtime.sendMessage({ action: 'clearVideos', tabId: currentTabId });
    renderVideos([]);
    showStatus('Cleared.', 'info');
  });

  // ---- Boot ----

  init();
})();
