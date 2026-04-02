# Video Downloader Pro — Deployment & Usage Guide

> A Chrome / Chromium browser extension that detects and downloads videos from almost
> any website — including HLS / M3U8 streaming video — directly from your browser.

---

## Table of Contents

1. [What the extension can do](#1-what-the-extension-can-do)
2. [Installation (Developer / Unpacked mode)](#2-installation-developer--unpacked-mode)
3. [Using the extension](#3-using-the-extension)
4. [Supported video types](#4-supported-video-types)
5. [Downloading HLS / M3U8 streams](#5-downloading-hls--m3u8-streams)
6. [YouTube downloads](#6-youtube-downloads)
7. [Converting `.ts` files to `.mp4`](#7-converting-ts-files-to-mp4)
8. [Known limitations](#8-known-limitations)
9. [Troubleshooting](#9-troubleshooting)
10. [Technical notes](#10-technical-notes)

---

## 1. What the extension can do

| Feature | Supported |
|---|---|
| Detect MP4 / WebM / FLV / MKV / OGG files on any page | ✅ |
| Download direct video file links | ✅ |
| Detect and download HLS / M3U8 streaming video (any site) | ✅ |
| Decrypt AES-128 encrypted HLS segments | ✅ |
| Auto-select highest-quality HLS variant stream | ✅ |
| Detect YouTube video streams (googlevideo.com) | ✅ |
| Show YouTube stream quality and itag labels | ✅ |
| Detect M3U8 URLs embedded in JavaScript players | ✅ |
| Live download progress bar for HLS streams | ✅ |
| Merge separate audio + video streams in-browser | ❌ (requires FFmpeg — see §7) |
| Download DRM-protected content (Widevine, PlayReady) | ❌ (browser limitation) |

---

## 2. Installation (Developer / Unpacked mode)

The extension is not currently published to the Chrome Web Store, so you
load it as an unpacked extension.

### Prerequisites

* **Google Chrome** 88 or newer, **Microsoft Edge** 88+, or any Chromium-based browser
* The extension source files (this repository)

### Steps

1. **Open the Extensions page**

   Navigate to `chrome://extensions` (Chrome) or `edge://extensions` (Edge).

2. **Enable Developer mode**

   Toggle the **Developer mode** switch in the top-right corner of the
   Extensions page.

3. **Load the extension**

   Click **Load unpacked**, then select the root folder of this repository
   (the folder that contains `manifest.json`).

4. **Pin the extension** *(optional but recommended)*

   Click the puzzle-piece icon in the toolbar → click the pin 📌 next to
   *Video Downloader Pro*.

The extension icon (green play button) will now appear in your toolbar.

### Updating after code changes

Go back to `chrome://extensions` and click the **↺ Refresh** button on
the *Video Downloader Pro* card.

---

## 3. Using the extension

1. **Browse to a page that contains a video** and let it start loading or
   playing.

2. **Click the extension icon** in the toolbar. The popup opens and shows
   every video stream that has been detected on the current tab.

3. Each detected video shows:
   * **Title** — the page title at the time of detection
   * **Type badge** — HLS/M3U8, MP4, YouTube, etc.
   * **URL** — truncated for display (hover for full URL)
   * **Warning note** — shown when a stream cannot be merged in-browser

4. Click **⬇ Download** to start downloading.

5. For **HLS / M3U8** streams a live progress bar appears:
   `45% (450/1000 segments)`.  
   Click **✕ Cancel** at any time to abort.

6. **↺** (Refresh) re-injects the page scanner — useful after the video
   starts playing or after page-level navigation in an SPA.

7. **✕** (Clear) removes all entries for the current tab.

---

## 4. Supported video types

| Badge | Meaning | Download method |
|---|---|---|
| `HLS / M3U8` | HLS playlist (any site) | Segment-by-segment download, concatenated to `.ts` |
| `MP4` | Direct MP4 file | `chrome.downloads` — browser's native save dialog |
| `WEBM` | Direct WebM file | `chrome.downloads` |
| `FLV` | Flash Video file | `chrome.downloads` |
| `MKV` | Matroska video | `chrome.downloads` |
| `YOUTUBE` | YouTube video-stream | `chrome.downloads` (see §6) |
| `AUDIO` | YouTube audio-only stream | `chrome.downloads` (see §6) |
| `DASH` | DASH manifest | `chrome.downloads` fetches manifest file only |

---

## 5. Downloading HLS / M3U8 streams

HLS (HTTP Live Streaming) is the streaming format used by most modern
video sites (Twitch VODs, news sites, sports streams, etc.).  
The extension handles it entirely in-browser:

1. **Master playlist** — if a master playlist with multiple quality levels
   is detected, the extension automatically picks the **highest-bandwidth
   variant**.

2. **Segment download** — every `.ts` segment is fetched sequentially.

3. **AES-128 decryption** — encrypted segments are decrypted with the
   Web Crypto API using the key URL from `#EXT-X-KEY`.

4. **Concatenation** — all segments are joined into a single binary blob
   and saved as a `.ts` file.

> **Output format:** The saved file has a `.ts` extension (MPEG Transport
> Stream).  Most media players (VLC, mpv, PotPlayer) can play `.ts`
> directly.  To convert to a standard `.mp4` see §7.

---

## 6. YouTube downloads

YouTube uses **adaptive bitrate streaming**: high-quality playback
delivers a separate video stream and a separate audio stream, which are
merged by the browser in real-time.  A pure browser extension cannot
merge these streams internally.

### What the extension detects

When you watch a YouTube video, the extension intercepts the
`googlevideo.com` network requests and lists every detected stream with
its quality label, derived from the YouTube `itag` parameter:

| Example label | Meaning |
|---|---|
| `720p MP4 (video+audio)` | Combined stream — safe to download directly |
| `1080p MP4 (video only)` | Video-only stream — needs FFmpeg merge |
| `128 kbps M4A (audio only)` | Audio-only stream — needs FFmpeg merge |

### Recommended workflow for YouTube

For a proper download with merged audio and video (especially 1080p+),
use **yt-dlp** on the command line:

```bash
# Install (macOS / Linux)
pip install yt-dlp          # or: brew install yt-dlp

# Install (Windows)
winget install yt-dlp

# Download best quality video + audio merged into MP4
yt-dlp -f "bestvideo+bestaudio" --merge-output-format mp4 "https://www.youtube.com/watch?v=VIDEO_ID"

# Download at a specific resolution
yt-dlp -f "bestvideo[height<=1080]+bestaudio" --merge-output-format mp4 "URL"
```

### Combined-stream download (≤ 720p)

If the extension detects a stream labelled **`(video+audio)`** you can
click **⬇ Download** to save it directly — no merging needed.

---

## 7. Converting `.ts` files to `.mp4`

HLS downloads are saved as raw MPEG Transport Stream (`.ts`) files.
Convert to `.mp4` with **FFmpeg** (lossless, near-instant):

```bash
# Install FFmpeg
# macOS:   brew install ffmpeg
# Ubuntu:  sudo apt install ffmpeg
# Windows: https://ffmpeg.org/download.html

# Convert .ts → .mp4 (no re-encode)
ffmpeg -i video.ts -c copy video.mp4

# Merge separate YouTube video + audio files
ffmpeg -i video_only.mp4 -i audio_only.m4a -c copy merged.mp4
```

---

## 8. Known limitations

| Limitation | Reason |
|---|---|
| Cannot merge video+audio in-browser | No FFmpeg-equivalent runs in a MV3 service worker without a 30 MB+ WASM bundle |
| DRM-protected content (Netflix, Disney+, etc.) | Browser blocks `captureStream()` on encrypted video elements |
| Some M3U8 downloads may fail with CORS errors | The streaming server rejects requests without a matching `Referer` or auth token |
| YouTube high-quality (>720p) requires yt-dlp | Only video+audio combined streams can be saved directly |
| Requires manual loading (no Web Store listing) | Extension is in developer/unpacked mode |

---

## 9. Troubleshooting

**No videos detected**

* Let the video start playing, then click **↺** to rescan.
* Some sites load video URLs lazily after user interaction — press Play
  first.
* A few sites use encrypted blob URLs that the extension cannot intercept.

**Download fails with "HTTP 403" or "CORS" error**

* The server is rejecting cross-origin requests from the extension.  
* Try opening the M3U8 URL directly in a new tab, then download from
  there.

**`.ts` file won't play**

* Open it in **VLC** or **mpv**, both of which support MPEG-TS natively.  
* Or convert with FFmpeg (see §7).

**YouTube streams not detected**

* Open the YouTube video, wait for playback to start, then open the popup.
* Click **↺** to trigger a fresh network scan.
* If the badge still shows 0, try seeking in the video so new requests
  are issued.

**"Extension context invalidated" error**

* The service worker was restarted.  Reload the extension at
  `chrome://extensions` and refresh the page.

---

## 10. Technical notes

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  popup.html / popup.js / popup.css                       │
│  (extension popup — renders video list, drives downloads)│
└─────────────────┬───────────────────────────────────────┘
                  │ chrome.runtime.sendMessage
┌─────────────────▼───────────────────────────────────────┐
│  background.js  (MV3 Service Worker)                     │
│  • chrome.webRequest.onBeforeRequest — intercepts URLs   │
│  • Map<tabId, Map<url, videoInfo>> — in-memory store     │
│  • Updates toolbar badge count per tab                   │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  content.js  (injected into every page)                  │
│  • Scans <video> elements and <source> children          │
│  • Scans inline <script> blocks for M3U8 URLs            │
│  • Debounced MutationObserver for SPA/dynamic content    │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  m3u8-downloader.js  (loaded in popup context)           │
│  • Fetches & parses master + media playlists             │
│  • Downloads segments in order (with optional AES-128)   │
│  • Returns a Blob (video/mp2t) for browser save          │
└─────────────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3), permissions, entry points |
| `background.js` | Service worker — network interception, video store |
| `content.js` | Page scanner — DOM video elements + inline script scan |
| `m3u8-downloader.js` | Self-contained HLS downloader (popup context) |
| `popup.html` | Popup shell HTML |
| `popup.js` | Popup logic — render, download, progress |
| `popup.css` | Popup styling (dark theme) |
| `icons/` | Extension icons (16 × 16, 48 × 48, 128 × 128 PNG) |

### Permissions used

| Permission | Why |
|---|---|
| `webRequest` | Intercept network requests to detect video URLs |
| `downloads` | Save files via the browser's native download system |
| `storage` | Reserved for future persistent settings |
| `tabs` | Identify the active tab to scope detected videos |
| `scripting` | Re-inject content.js on Refresh button click |
| `host_permissions: <all_urls>` | Allow cross-origin fetch in popup (for M3U8 segments) |
