import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { createQR, drawQR } from "./qrcode.js";

const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
};

const PINCH_THRESHOLD = 0.055;
const FRAME_PADDING = 28;
const FREEZE_HOLD_MS = 250;
const COUNTDOWN_SECONDS = 3;
const FIST_HOLD_FRAMES = 12;
const SNAP_DISTANCE_RATIO = 0.45;
const GRID = 3;
const LOAD_TIMEOUT_MS = 20000;

const PHOTOBOOTH_CONTRAST_ALPHA = 1.3;
const PHOTOBOOTH_BRIGHTNESS_BETA = 10;
const PHOTOBOOTH_NOISE_STD = 15;

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const videoEl = document.getElementById("webcam");
const canvas = document.getElementById("sceneCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const loadingOverlay = document.getElementById("loadingOverlay");
const loaderText = document.getElementById("loaderText");
const loaderRetry = document.getElementById("loaderRetry");
const errorBanner = document.getElementById("errorBanner");
const progressBadge = document.getElementById("progressBadge");
const progressText = document.getElementById("progressText");

const galleryStrip = document.getElementById("galleryStrip");
const galleryEmpty = document.getElementById("galleryEmpty");
const galleryCount = document.getElementById("galleryCount");
const downloadStripBtn = document.getElementById("downloadStripBtn");
const downloadGifBtn = document.getElementById("downloadGifBtn");
const copyClipboardBtn = document.getElementById("copyClipboardBtn");
const resetAllBtn = document.getElementById("resetAllBtn");
const stripCompleteMsg = document.getElementById("stripCompleteMsg");
const themeSelect = document.getElementById("themeSelect");
const backgroundFxSelect = document.getElementById("backgroundFxSelect");
const layoutSelect = document.getElementById("layoutSelect");
const photoFilterSelect = document.getElementById("photoFilterSelect");
const puzzleOrientationSelect = document.getElementById("puzzleOrientationSelect");
const liveMotionToggle = document.getElementById("liveMotionToggle");
const bgColorInput = document.getElementById("bgColorInput");
const accentColorInput = document.getElementById("accentColorInput");
const stripTitleInput = document.getElementById("stripTitleInput");
const toastNotification = document.getElementById("toastNotification");
const challengeChip = document.getElementById("challengeChip");
const recBadge = document.getElementById("recBadge");
const shareChallengeBtn = document.getElementById("shareChallengeBtn");
const downloadVideoBtn = document.getElementById("downloadVideoBtn");
const recordSolvesToggle = document.getElementById("recordSolvesToggle");
const qrOverlay = document.getElementById("qrOverlay");
const qrOverlayCanvas = document.getElementById("qrOverlayCanvas");
const qrOverlayLink = document.getElementById("qrOverlayLink");
const qrCopyBtn = document.getElementById("qrCopyBtn");
const qrCloseBtn = document.getElementById("qrCloseBtn");

let appState = "tracking";

const settings = {
  theme: "cyberpunk",
  bgColor: "#0b0c0e",
  accentColor: "#8b93ff",
  backgroundFx: "none",
  layout: "strip",
  photoFilter: "photobooth",
  puzzleOrientation: "normal",
  liveMotion: true,
  recordSolves: true,
  stripTitle: "PuzzleCam Session",
};

const themeDefaults = {
  cyberpunk: { bg: "#0b0c0e", accent: "#8b93ff" },
  studio: { bg: "#101114", accent: "#d7dae0" },
  sunset: { bg: "#14110e", accent: "#e6a34a" },
  arcade: { bg: "#0e0e10", accent: "#f2746b" },
};

const cameraFx = {
  frameCanvas: document.createElement("canvas"),
  frameCtx: null,
};
cameraFx.frameCtx = cameraFx.frameCanvas.getContext("2d", { willReadFrequently: true });

const smoothedBox = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  active: false,
};

function smoothBox(rawBox, alpha = 0.38) {
  if (!smoothedBox.active) {
    smoothedBox.x = rawBox.x;
    smoothedBox.y = rawBox.y;
    smoothedBox.width = rawBox.width;
    smoothedBox.height = rawBox.height;
    smoothedBox.active = true;
  } else {
    smoothedBox.x += (rawBox.x - smoothedBox.x) * alpha;
    smoothedBox.y += (rawBox.y - smoothedBox.y) * alpha;
    smoothedBox.width += (rawBox.width - smoothedBox.width) * alpha;
    smoothedBox.height += (rawBox.height - smoothedBox.height) * alpha;
  }
  return {
    x: smoothedBox.x,
    y: smoothedBox.y,
    width: smoothedBox.width,
    height: smoothedBox.height,
  };
}

const puzzle = {
  boardBox: null,
  pieces: [],
  solved: false,
  tileW: 0,
  tileH: 0,
  seed: null,
  nextSeed: null,
  startedAt: 0,
  elapsedMs: 0,
  moves: 0,
  solveRecorded: false,
};

const SHATTER_COLS = 6;
const SHATTER_ROWS = 6;
const SHATTER_DURATION_MS = 850;
const shatter = {
  active: false,
  startedAt: 0,
  fragments: [],
  pendingCanvas: null,
};

const STRIP_MAX_PHOTOS = 3;
const galleryEntries = [];

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function getAccentColor() {
  return cssVar("--accent") || settings.accentColor;
}

function getAccentTwoColor() {
  return cssVar("--accent-2") || "#b9bec9";
}

function getOkColor() {
  return cssVar("--ok") || "#57c99b";
}

function getPaperColor() {
  return cssVar("--paper") || "#e9eaee";
}

function sanitizeTitle(value) {
  return (value || "PuzzleCam Session").trim().slice(0, 28) || "PuzzleCam Session";
}

/* ==========================================================================
   Share pack — challenge links (seeded puzzles), QR codes, solve recording
   ========================================================================== */

const challenge = { active: null };
let lastSolve = null;
const solveRecorder = { recorder: null, targetEntry: null, recording: false };

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

// Deterministic PRNG so a shared seed always produces the same scramble.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRng(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodePayload(obj) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function decodePayload(str) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(str)));
}

function buildChallengePayload() {
  if (!lastSolve) return null;
  return {
    v: 1,
    seed: lastSolve.seed,
    t: lastSolve.elapsedMs,
    m: lastSolve.moves,
    l: lastSolve.layout,
    f: lastSolve.filter,
    o: lastSolve.orientation,
    lm: lastSolve.liveMotion ? 1 : 0,
    ti: lastSolve.title,
    th: lastSolve.theme,
    bg: lastSolve.bg,
    ac: lastSolve.accent,
    fx: lastSolve.fx,
  };
}

function buildShareUrl() {
  const base = `${location.origin}${location.pathname}`;
  const payload = buildChallengePayload();
  return payload ? `${base}#c=${encodePayload(payload)}` : base;
}

function readChallengeFromUrl() {
  const match = (location.hash || "").match(/[#&]c=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    return decodePayload(match[1]);
  } catch (err) {
    console.warn("[PuzzleCam] invalid challenge link:", err);
    return null;
  }
}

function setSelectValue(selectEl, value) {
  if (!selectEl || typeof value !== "string") return false;
  const exists = Array.prototype.some.call(
    selectEl.options,
    (option) => option.value === value
  );
  if (!exists) return false;
  selectEl.value = value;
  return true;
}

function updateChallengeChip() {
  if (!challengeChip) return;
  if (!challenge.active) {
    challengeChip.classList.remove("visible");
    challengeChip.textContent = "";
    return;
  }
  challengeChip.textContent = `🎯 Beat ${formatDuration(challenge.active.t)} · ${challenge.active.m} moves — same scramble loaded`;
  challengeChip.classList.add("visible");
}

function applyChallenge(payload) {
  if (!payload || typeof payload !== "object") return;

  challenge.active = {
    t: Number.isFinite(payload.t) ? payload.t : 0,
    m: Number.isFinite(payload.m) ? payload.m : 0,
  };
  if (typeof payload.seed === "number") puzzle.nextSeed = payload.seed >>> 0;

  if (setSelectValue(layoutSelect, payload.l)) settings.layout = payload.l;
  if (setSelectValue(photoFilterSelect, payload.f)) settings.photoFilter = payload.f;
  if (setSelectValue(puzzleOrientationSelect, payload.o)) settings.puzzleOrientation = payload.o;
  if (setSelectValue(backgroundFxSelect, payload.fx)) applyBackgroundFx(payload.fx);
  if (typeof payload.lm === "number") {
    settings.liveMotion = !!payload.lm;
    if (liveMotionToggle) liveMotionToggle.checked = settings.liveMotion;
  }
  if (typeof payload.ti === "string") {
    settings.stripTitle = sanitizeTitle(payload.ti);
    if (stripTitleInput) stripTitleInput.value = settings.stripTitle;
  }
  if (typeof payload.th === "string" && themeDefaults[payload.th]) {
    applyTheme(payload.th, false);
  }
  if (typeof payload.bg === "string") {
    settings.bgColor = payload.bg;
    if (bgColorInput) bgColorInput.value = payload.bg;
  }
  if (typeof payload.ac === "string") {
    settings.accentColor = payload.ac;
    if (accentColorInput) accentColorInput.value = payload.ac;
  }
  document.body.style.setProperty("--bg", settings.bgColor);
  document.body.style.setProperty("--accent", settings.accentColor);

  updateChallengeChip();
  showToast(
    `Challenge loaded — beat ${formatDuration(challenge.active.t)} · ${challenge.active.m} moves 🎯`,
    4600
  );
}

let qrMatrixCache = { url: null, matrix: null };

function getQrMatrix(url) {
  if (qrMatrixCache.url === url && qrMatrixCache.matrix) return qrMatrixCache.matrix;
  const matrix = createQR(url, { level: "M" });
  qrMatrixCache = { url, matrix };
  return matrix;
}

function drawShareQr(targetCtx, x, y, sizePx) {
  targetCtx.save();
  targetCtx.fillStyle = "#ffffff";
  targetCtx.fillRect(x, y, sizePx, sizePx);
  let matrix = null;
  try {
    matrix = getQrMatrix(buildShareUrl());
  } catch (err) {
    matrix = null;
  }
  if (matrix) {
    drawQR(targetCtx, matrix, x, y, sizePx, {
      dark: "#101010",
      light: "#ffffff",
      margin: 3,
    });
  } else {
    targetCtx.fillStyle = "#8a8f99";
    targetCtx.font = "600 11px 'IBM Plex Mono', monospace";
    targetCtx.textAlign = "center";
    targetCtx.textBaseline = "middle";
    targetCtx.fillText("QR unavailable", x + sizePx / 2, y + sizePx / 2);
  }
  targetCtx.restore();
}

// Shrink (and if needed truncate) text so it fits the given width.
// Sets the font on targetCtx and returns the string that should be drawn.
function fitText(targetCtx, text, maxWidth, maxSize, minSize, weight, family) {
  let size = maxSize;
  targetCtx.font = `${weight} ${size}px ${family}`;
  while (size > minSize && targetCtx.measureText(text).width > maxWidth) {
    size -= 1;
    targetCtx.font = `${weight} ${size}px ${family}`;
  }
  let out = text;
  if (targetCtx.measureText(out).width > maxWidth) {
    while (out.length > 1 && targetCtx.measureText(`${out}…`).width > maxWidth) {
      out = out.slice(0, -1);
    }
    out = out.length > 1 ? `${out}…` : out;
  }
  return out;
}

function renderQrToCanvas(targetCanvas, url, cssSize) {
  if (!targetCanvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(cssSize * dpr);
  targetCanvas.width = px;
  targetCanvas.height = px;
  targetCanvas.style.width = `${cssSize}px`;
  targetCanvas.style.height = `${cssSize}px`;
  const c = targetCanvas.getContext("2d");
  c.clearRect(0, 0, px, px);
  try {
    const matrix = getQrMatrix(url);
    drawQR(c, matrix, 0, 0, px, { dark: "#0b0c0e", light: "#ffffff", margin: 2 });
  } catch (err) {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, px, px);
    c.fillStyle = "#333333";
    c.font = "600 14px monospace";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("QR unavailable", px / 2, px / 2);
  }
}

function showQrOverlay(url) {
  if (!qrOverlay) return;
  if (qrOverlayLink) qrOverlayLink.textContent = url;
  renderQrToCanvas(qrOverlayCanvas, url, 260);
  qrOverlay.classList.add("visible");
}

function hideQrOverlay() {
  if (qrOverlay) qrOverlay.classList.remove("visible");
}

async function shareChallenge() {
  const url = buildShareUrl();
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      copied = true;
    }
  } catch (err) {
    copied = false;
  }
  showQrOverlay(url);
  showToast(copied ? "Challenge link copied — scan the QR too! 🔗" : "Scan the QR to share 🔗");
}

function recordSolveIfNeeded() {
  if (puzzle.solveRecorded || !puzzle.solved || !puzzle.startedAt) return;
  puzzle.solveRecorded = true;
  puzzle.elapsedMs = Math.max(0, Math.round(performance.now() - puzzle.startedAt));
  lastSolve = {
    seed: puzzle.seed,
    elapsedMs: puzzle.elapsedMs,
    moves: puzzle.moves,
    layout: settings.layout,
    filter: settings.photoFilter,
    orientation: settings.puzzleOrientation,
    liveMotion: settings.liveMotion,
    title: sanitizeTitle(settings.stripTitle),
    theme: settings.theme,
    bg: settings.bgColor,
    accent: settings.accentColor,
    fx: settings.backgroundFx,
  };
  showToast(
    `Solved in ${formatDuration(puzzle.elapsedMs)} · ${puzzle.moves} moves 🎉`,
    3600
  );
}

function pickRecorderMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

function updateRecBadge() {
  const on = !!(solveRecorder.recorder && solveRecorder.recorder.state === "recording");
  solveRecorder.recording = on;
  if (recBadge) recBadge.classList.toggle("visible", on);
}

function startSolveRecording() {
  if (!settings.recordSolves) return;
  if (solveRecorder.recorder) return;
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
    return;
  }

  const mime = pickRecorderMime();
  try {
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) chunks.push(evt.data);
    };
    recorder.onstop = () => {
      const blob = chunks.length ? new Blob(chunks, { type: mime || "video/webm" }) : null;
      const entry = solveRecorder.targetEntry;
      solveRecorder.recorder = null;
      solveRecorder.targetEntry = null;
      updateRecBadge();
      if (entry && blob) entry.video = blob;
      updateStripDownloadAvailability();
    };
    recorder.start();
    solveRecorder.recorder = recorder;
    solveRecorder.targetEntry = null;
    updateRecBadge();
  } catch (err) {
    console.warn("[PuzzleCam] solve recording unavailable:", err);
    solveRecorder.recorder = null;
    updateRecBadge();
  }
}

function stopSolveRecording(entry) {
  solveRecorder.targetEntry = entry || null;
  const recorder = solveRecorder.recorder;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  updateRecBadge();
}

function discardSolveRecording() {
  stopSolveRecording(null);
}

function downloadSolveVideo() {
  const entry = [...galleryEntries].reverse().find((e) => e.video);
  if (!entry) {
    showToast("No recorded solve video yet 🎬");
    return;
  }
  const url = URL.createObjectURL(entry.video);
  const link = document.createElement("a");
  link.href = url;
  const fileTitle = sanitizeTitle(settings.stripTitle)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const ext = entry.video.type.includes("mp4") ? "mp4" : "webm";
  link.download = `${fileTitle || "puzzlecam"}_solve_${Date.now()}.${ext}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast("Solve video saved! 🎬");
}

function applyTheme(theme, useDefaults = false) {
  settings.theme = theme;
  document.body.classList.remove("theme-cyberpunk", "theme-studio", "theme-sunset", "theme-arcade");
  document.body.classList.add(`theme-${theme}`);
  if (useDefaults && themeDefaults[theme]) {
    settings.bgColor = themeDefaults[theme].bg;
    settings.accentColor = themeDefaults[theme].accent;
    bgColorInput.value = settings.bgColor;
    accentColorInput.value = settings.accentColor;
  }
  document.body.style.setProperty("--bg", settings.bgColor);
  document.body.style.setProperty("--accent", settings.accentColor);
}

function applyBackgroundFx(effect) {
  settings.backgroundFx = effect;
  document.body.classList.remove("fx-prism", "fx-static", "fx-scanlines", "fx-hypno", "fx-none");
  document.body.classList.add(`fx-${effect}`);
}

function showToast(message, duration = 2800) {
  if (!toastNotification) return;
  toastNotification.textContent = message;
  toastNotification.classList.add("visible");
  clearTimeout(toastNotification._timer);
  toastNotification._timer = setTimeout(() => {
    toastNotification.classList.remove("visible");
  }, duration);
}

function applyPhotoFilterToCanvas(targetCanvas, filterType) {
  const targetCtx = targetCanvas.getContext("2d");
  const imgData = targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
  const d = imgData.data;
  const w = targetCanvas.width;
  const h = targetCanvas.height;

  if (filterType === "vintage") {
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] * 1.15 + 12;
      let g = d[i + 1] * 1.02 + 4;
      let b = d[i + 2] * 0.86 - 6;
      const noise = (Math.random() - 0.5) * 16;
      d[i] = Math.max(0, Math.min(255, r + noise));
      d[i + 1] = Math.max(0, Math.min(255, g + noise));
      d[i + 2] = Math.max(0, Math.min(255, b + noise));
    }
  } else if (filterType === "cyber") {
    const copy = new Uint8ClampedArray(d);
    const shift = Math.max(3, Math.round(w * 0.008));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const leftIdx = (y * w + Math.max(0, x - shift)) * 4;
        const rightIdx = (y * w + Math.min(w - 1, x + shift)) * 4;
        d[idx] = Math.min(255, copy[leftIdx] * 1.3);
        d[idx + 1] = copy[idx + 1];
        d[idx + 2] = Math.min(255, copy[rightIdx + 2] * 1.4);
      }
    }
  } else if (filterType === "thermal") {
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      let r = 0, g = 0, b = 0;
      if (lum < 0.25) {
        const t = lum / 0.25;
        r = Math.round(t * 110);
        g = 0;
        b = Math.round(140 + t * 115);
      } else if (lum < 0.55) {
        const t = (lum - 0.25) / 0.3;
        r = Math.round(110 + t * 145);
        g = Math.round(t * 80);
        b = Math.round(255 * (1 - t));
      } else if (lum < 0.85) {
        const t = (lum - 0.55) / 0.3;
        r = 255;
        g = Math.round(80 + t * 175);
        b = 0;
      } else {
        const t = (lum - 0.85) / 0.15;
        r = 255;
        g = 255;
        b = Math.round(t * 255);
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  } else if (filterType === "natural") {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.max(0, Math.min(255, (d[i] - 128) * 1.1 + 128 + 4));
      d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - 128) * 1.1 + 128 + 4));
      d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - 128) * 1.1 + 128 + 4));
    }
  } else {
    applyPhotoboothEffect(imgData);
  }

  targetCtx.putImageData(imgData, 0, 0);
}

function mirrorCanvasHorizontally(sourceCanvas) {
  const mirrored = document.createElement("canvas");
  mirrored.width = sourceCanvas.width;
  mirrored.height = sourceCanvas.height;
  const mirroredCtx = mirrored.getContext("2d");
  mirroredCtx.translate(mirrored.width, 0);
  mirroredCtx.scale(-1, 1);
  mirroredCtx.drawImage(sourceCanvas, 0, 0);
  return mirrored;
}

function applyPuzzleOrientation(sourceCanvas) {
  return settings.puzzleOrientation === "mirror"
    ? mirrorCanvasHorizontally(sourceCanvas)
    : sourceCanvas;
}

function addToGallery(snapshotCanvas, boomerangFrames = null) {
  if (galleryEntries.length >= STRIP_MAX_PHOTOS) return null;

  const frames = boomerangFrames && boomerangFrames.length > 0 ? boomerangFrames : [snapshotCanvas];
  const entry = { canvas: snapshotCanvas, frames, time: Date.now() };
  galleryEntries.push(entry);
  renderGalleryThumb(snapshotCanvas, galleryEntries.length);
  galleryCount.textContent = `${galleryEntries.length} / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) galleryEmpty.style.display = "none";

  if (galleryEntries.length >= STRIP_MAX_PHOTOS) {
    showStripComplete();
  }
  return entry;
}

function isStripFull() {
  return galleryEntries.length >= STRIP_MAX_PHOTOS;
}

function showStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.add("visible");
  updateStripDownloadAvailability();
}

function hideStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.remove("visible");
}

function updateStripDownloadAvailability() {
  const hasEntries = galleryEntries.length > 0;
  const hasVideo = galleryEntries.some((entry) => entry.video);
  if (downloadStripBtn) downloadStripBtn.disabled = !hasEntries;
  if (downloadGifBtn) downloadGifBtn.disabled = !hasEntries;
  if (copyClipboardBtn) copyClipboardBtn.disabled = !hasEntries;
  if (shareChallengeBtn) shareChallengeBtn.disabled = !hasEntries;
  if (downloadVideoBtn) downloadVideoBtn.disabled = !hasVideo;
}

function renderLayoutCanvas(entries, layout = "strip", frameIndex = 0) {
  if (!entries || entries.length === 0) return null;

  const getEntryFrame = (entry) => {
    if (entry.frames && entry.frames.length > 0) {
      return entry.frames[frameIndex % entry.frames.length];
    }
    return entry.canvas;
  };

  const activeEntries = entries.map((e) => ({
    frameCanvas: getEntryFrame(e),
    original: e,
  }));

  const targetW = activeEntries[0].frameCanvas.width;
  const targetH = activeEntries[0].frameCanvas.height;
  const now = new Date();
  const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  const titleText = sanitizeTitle(settings.stripTitle);

  if (layout === "polaroid") {
    const padding = 28;
    const totalW = targetW + padding * 2;
    const qrSize = Math.min(128, Math.max(72, Math.round(totalW * 0.24)));
    const bottomExtra = 44 + qrSize;
    const totalH = targetH + padding + bottomExtra;

    const out = document.createElement("canvas");
    out.width = totalW;
    out.height = totalH;
    const outCtx = out.getContext("2d");

    outCtx.fillStyle = "#fafbfe";
    outCtx.fillRect(0, 0, totalW, totalH);

    outCtx.fillStyle = "rgba(0,0,0,0.06)";
    outCtx.fillRect(0, 0, totalW, 6);

    const latest = activeEntries[activeEntries.length - 1];
    outCtx.drawImage(latest.frameCanvas, padding, padding, targetW, targetH);

    outCtx.strokeStyle = "rgba(0,0,0,0.12)";
    outCtx.lineWidth = 1;
    outCtx.strokeRect(padding, padding, targetW, targetH);

    const qrX = totalW - padding - qrSize;
    const qrY = totalH - padding - qrSize;
    const textMaxW = Math.max(40, qrX - (padding + 4) - 16);
    const dateLine = `${dateStr} • SHOT #${String(entries.length).padStart(2, "0")}`;

    outCtx.fillStyle = "#1e2230";
    outCtx.textAlign = "left";
    outCtx.textBaseline = "middle";
    const drawTitle = fitText(outCtx, titleText, textMaxW, 24, 12, "800", "'IBM Plex Mono', monospace");
    outCtx.fillText(drawTitle, padding + 4, targetH + padding + 34);

    outCtx.fillStyle = "#667085";
    const drawDate = fitText(outCtx, dateLine, textMaxW, 13, 9, "600", "'IBM Plex Mono', monospace");
    outCtx.fillText(drawDate, padding + 4, targetH + padding + 60);

    drawShareQr(outCtx, qrX, qrY, qrSize);
    outCtx.fillStyle = "#667085";
    outCtx.font = "700 10px 'IBM Plex Mono', monospace";
    outCtx.textAlign = "center";
    outCtx.textBaseline = "top";
    outCtx.fillText("SCAN TO PLAY", qrX + qrSize / 2, qrY + qrSize + 8);

    return out;
  }

  if (layout === "magazine") {
    const totalW = targetW + 48;
    const qrSize = Math.min(150, Math.max(76, Math.round(totalW * 0.26)));
    const footerH = 44 + qrSize;
    const totalH = targetH + 76 + footerH;

    const out = document.createElement("canvas");
    out.width = totalW;
    out.height = totalH;
    const outCtx = out.getContext("2d");

    outCtx.fillStyle = "#090a12";
    outCtx.fillRect(0, 0, totalW, totalH);

    outCtx.fillStyle = getAccentColor();
    outCtx.font = "900 36px 'Inter', sans-serif";
    outCtx.textAlign = "center";
    outCtx.textBaseline = "top";
    outCtx.letterSpacing = "4px";
    outCtx.fillText("PUZZLECAM", totalW / 2, 16);

    outCtx.fillStyle = "#aeb7d4";
    outCtx.font = "700 11px 'IBM Plex Mono', monospace";
    outCtx.fillText("VOL. 2026 • GESTURE PHOTOBOOTH EDITION", totalW / 2, 58);

    const hero = activeEntries[activeEntries.length - 1];
    outCtx.drawImage(hero.frameCanvas, 24, 76, targetW, targetH);

    outCtx.strokeStyle = `${getAccentColor()}88`;
    outCtx.lineWidth = 2;
    outCtx.strokeRect(24, 76, targetW, targetH);

    const qrX = totalW - 28 - qrSize;
    const qrY = totalH - 28 - qrSize;
    const footerTop = totalH - footerH + 14;
    const textMaxW = Math.max(40, qrX - 28 - 16);
    const magTitle = titleText.toUpperCase();
    const magSub = `FEATURING ${entries.length} CAPTURES • ${dateStr}`;

    outCtx.fillStyle = "#ffffff";
    outCtx.textAlign = "left";
    outCtx.textBaseline = "top";
    const drawMagTitle = fitText(outCtx, magTitle, textMaxW, 18, 11, "800", "'Inter', sans-serif");
    outCtx.fillText(drawMagTitle, 28, footerTop);

    outCtx.fillStyle = getAccentTwoColor();
    const drawMagSub = fitText(outCtx, magSub, textMaxW, 11, 8, "700", "'IBM Plex Mono', monospace");
    outCtx.fillText(drawMagSub, 28, footerTop + 26);

    drawShareQr(outCtx, qrX, qrY, qrSize);
    outCtx.fillStyle = getAccentTwoColor();
    outCtx.font = "700 10px 'IBM Plex Mono', monospace";
    outCtx.textAlign = "center";
    outCtx.textBaseline = "top";
    outCtx.fillText("SCAN TO PLAY", qrX + qrSize / 2, qrY + qrSize + 8);

    return out;
  }

  if (layout === "grid") {
    const pad = 24;
    const gap = 14;
    const halfW = Math.round(targetW * 0.7);
    const halfH = Math.round(targetH * 0.7);
    const totalW = pad * 2 + halfW * 2 + gap;
    const qrSize = Math.min(140, Math.max(72, Math.round(totalW * 0.24)));
    const footerH = 40 + qrSize;
    const totalH = pad * 2 + halfH * 2 + gap + footerH;

    const out = document.createElement("canvas");
    out.width = totalW;
    out.height = totalH;
    const outCtx = out.getContext("2d");

    outCtx.fillStyle = "#ffffff";
    outCtx.fillRect(0, 0, totalW, totalH);

    const positions = [
      { x: pad, y: pad },
      { x: pad + halfW + gap, y: pad },
      { x: pad, y: pad + halfH + gap },
      { x: pad + halfW + gap, y: pad + halfH + gap },
    ];

    positions.forEach((pos, idx) => {
      const entry = activeEntries[idx % activeEntries.length];
      outCtx.drawImage(entry.frameCanvas, pos.x, pos.y, halfW, halfH);
      outCtx.strokeStyle = "rgba(0,0,0,0.12)";
      outCtx.lineWidth = 1;
      outCtx.strokeRect(pos.x, pos.y, halfW, halfH);
    });

    const qrX = totalW - pad - qrSize;
    const qrY = totalH - 26 - qrSize;
    const textMaxW = Math.max(40, qrX - pad - 16);

    outCtx.fillStyle = "#111422";
    outCtx.textAlign = "left";
    outCtx.textBaseline = "top";
    const drawTitle = fitText(outCtx, titleText, textMaxW, 20, 12, "800", "'IBM Plex Mono', monospace");
    outCtx.fillText(drawTitle, pad, qrY + 8);

    outCtx.fillStyle = "#667085";
    const drawDate = fitText(outCtx, dateStr, textMaxW, 12, 9, "600", "'IBM Plex Mono', monospace");
    outCtx.fillText(drawDate, pad, qrY + 36);

    drawShareQr(outCtx, qrX, qrY, qrSize);
    outCtx.fillStyle = "#667085";
    outCtx.font = "700 10px 'IBM Plex Mono', monospace";
    outCtx.textAlign = "center";
    outCtx.textBaseline = "top";
    outCtx.fillText("SCAN TO PLAY", qrX + qrSize / 2, qrY + qrSize + 7);

    return out;
  }

  // Default: Classic Vertical Strip
  const border = 24;
  const gap = 16;
  const scaledHeights = activeEntries.map((entry) =>
    Math.round(entry.frameCanvas.height * (targetW / entry.frameCanvas.width))
  );

  const totalW = targetW + border * 2;
  const qrSize = Math.min(150, Math.max(76, Math.round(totalW * 0.28)));
  const footerH = 44 + qrSize;

  const totalH =
    border * 2 +
    38 +
    scaledHeights.reduce((sum, h) => sum + h, 0) +
    gap * (activeEntries.length - 1) +
    footerH;

  const stripCanvas = document.createElement("canvas");
  stripCanvas.width = totalW;
  stripCanvas.height = totalH;
  const stripCtx = stripCanvas.getContext("2d");

  stripCtx.fillStyle = "#ffffff";
  stripCtx.fillRect(0, 0, totalW, totalH);

  stripCtx.fillStyle = "#10131f";
  stripCtx.font = "800 22px 'Inter', sans-serif";
  stripCtx.textAlign = "center";
  stripCtx.textBaseline = "top";
  stripCtx.fillText(titleText, totalW / 2, 12);

  stripCtx.fillStyle = "#667085";
  stripCtx.font = "600 11px 'IBM Plex Mono', monospace";
  stripCtx.fillText(`PUZZLE.CAM • ${dateStr}`, totalW / 2, 36);

  let cursorY = border + 34;
  activeEntries.forEach((entry, i) => {
    const h = scaledHeights[i];
    stripCtx.drawImage(entry.frameCanvas, border, cursorY, targetW, h);
    stripCtx.strokeStyle = "rgba(0,0,0,0.12)";
    stripCtx.lineWidth = 1;
    stripCtx.strokeRect(border, cursorY, targetW, h);
    cursorY += h + gap;
  });

  const qrX = totalW - border - qrSize;
  const qrY = totalH - 34 - qrSize;
  const textMaxW = Math.max(40, qrX - border - 20);

  stripCtx.textAlign = "left";
  stripCtx.textBaseline = "top";
  if (lastSolve) {
    const head = `BEST ${formatDuration(lastSolve.elapsedMs)} • ${lastSolve.moves} MOVES`;
    stripCtx.fillStyle = "#10131f";
    const drawHead = fitText(stripCtx, head, textMaxW, 20, 11, "800", "'Inter', sans-serif");
    stripCtx.fillText(drawHead, border, qrY + 8);
    stripCtx.fillStyle = "#667085";
    stripCtx.font = "600 11px 'IBM Plex Mono', monospace";
    stripCtx.fillText("beat my time on puzzle.cam", border, qrY + 36);
  } else {
    stripCtx.fillStyle = "#10131f";
    const drawHead = fitText(stripCtx, "PUZZLECAM", textMaxW, 20, 11, "800", "'Inter', sans-serif");
    stripCtx.fillText(drawHead, border, qrY + 8);
    stripCtx.fillStyle = "#667085";
    stripCtx.font = "600 11px 'IBM Plex Mono', monospace";
    stripCtx.fillText("gesture photobooth strip", border, qrY + 36);
  }

  drawShareQr(stripCtx, qrX, qrY, qrSize);
  stripCtx.fillStyle = "#667085";
  stripCtx.font = "700 10px 'IBM Plex Mono', monospace";
  stripCtx.textAlign = "center";
  stripCtx.textBaseline = "top";
  stripCtx.fillText("SCAN TO PLAY", qrX + qrSize / 2, qrY + qrSize + 7);

  return stripCanvas;
}

// Pure Vanilla JS Animated GIF89a Encoder (Zero dependencies)
function encodeGIF(canvases, delayMs = 90) {
  if (!canvases || canvases.length === 0) return null;
  const width = canvases[0].width;
  const height = canvases[0].height;
  const bytes = [];

  function writeStr(s) {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  }
  function write16(n) {
    bytes.push(n & 0xff, (n >> 8) & 0xff);
  }

  writeStr("GIF89a");
  write16(width);
  write16(height);
  bytes.push(0x70, 0, 0);

  // Netscape looping extension
  bytes.push(0x21, 0xff, 0x0b);
  writeStr("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  canvases.forEach((c) => {
    const ctx = c.getContext("2d");
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;

    const palette = [];
    const colorMap = new Map();
    const indexedPixels = new Uint8Array(width * height);

    for (let i = 0; i < d.length; i += 4) {
      const r = Math.min(3, Math.floor(d[i] / 64)) * 85;
      const g = Math.min(3, Math.floor(d[i + 1] / 64)) * 85;
      const b = Math.min(3, Math.floor(d[i + 2] / 64)) * 85;
      const key = (r << 16) | (g << 8) | b;
      let idx = colorMap.get(key);
      if (idx === undefined) {
        idx = palette.length / 3;
        if (idx < 64) {
          palette.push(r, g, b);
          colorMap.set(key, idx);
        } else {
          idx = 0;
        }
      }
      indexedPixels[i / 4] = idx;
    }

    while (palette.length < 64 * 3) {
      palette.push(0, 0, 0);
    }

    const colorDepth = 6;
    const delayUnits = Math.max(2, Math.round(delayMs / 10));
    bytes.push(0x21, 0xf9, 0x04, 0x00);
    write16(delayUnits);
    bytes.push(0x00, 0x00);

    bytes.push(0x2c);
    write16(0);
    write16(0);
    write16(width);
    write16(height);
    bytes.push(0x80 | (colorDepth - 1));

    for (let i = 0; i < palette.length; i++) {
      bytes.push(palette[i]);
    }

    const minCodeSize = Math.max(2, colorDepth);
    bytes.push(minCodeSize);

    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dict = new Map();

    function initDict() {
      dict.clear();
      for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    }
    initDict();

    const outBits = [];
    function writeBits(code, len) {
      for (let b = 0; b < len; b++) outBits.push((code >> b) & 1);
    }

    writeBits(clearCode, codeSize);
    let curPattern = "";
    for (let i = 0; i < indexedPixels.length; i++) {
      const ch = String.fromCharCode(indexedPixels[i]);
      const comb = curPattern + ch;
      if (dict.has(comb)) {
        curPattern = comb;
      } else {
        writeBits(dict.get(curPattern), codeSize);
        if (nextCode < 4096) {
          dict.set(comb, nextCode++);
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        } else {
          writeBits(clearCode, codeSize);
          initDict();
        }
        curPattern = ch;
      }
    }
    if (curPattern !== "") writeBits(dict.get(curPattern), codeSize);
    writeBits(eoiCode, codeSize);

    const stream = [];
    for (let i = 0; i < outBits.length; i += 8) {
      let byteVal = 0;
      for (let b = 0; b < 8 && i + b < outBits.length; b++) {
        byteVal |= outBits[i + b] << b;
      }
      stream.push(byteVal);
    }

    for (let i = 0; i < stream.length; i += 254) {
      const sub = stream.slice(i, i + 254);
      bytes.push(sub.length);
      for (let j = 0; j < sub.length; j++) bytes.push(sub[j]);
    }
    bytes.push(0x00);
  });

  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

function downloadPhotoStrip() {
  if (galleryEntries.length === 0) return;
  const stripCanvas = renderLayoutCanvas(galleryEntries, settings.layout);
  if (!stripCanvas) return;

  stripCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const fileTitle = sanitizeTitle(settings.stripTitle).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    link.download = `${fileTitle || "puzzlecam"}_${settings.layout}_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast("Downloaded photo strip! 📸");
  }, "image/png");
}

function downloadAnimatedGif() {
  if (galleryEntries.length === 0) return;
  showToast("Rendering animated Boomerang GIF... 🎞️", 4000);

  setTimeout(() => {
    const maxFrames = Math.max(...galleryEntries.map((e) => (e.frames ? e.frames.length : 1)));
    const frameCanvases = [];
    for (let f = 0; f < maxFrames; f++) {
      const frameCanvas = renderLayoutCanvas(galleryEntries, settings.layout, f);
      if (frameCanvas) frameCanvases.push(frameCanvas);
    }

    if (frameCanvases.length === 0) return;

    const gifBlob = encodeGIF(frameCanvases, 90);
    if (!gifBlob) {
      showToast("Error creating GIF");
      return;
    }

    const url = URL.createObjectURL(gifBlob);
    const link = document.createElement("a");
    link.href = url;
    const fileTitle = sanitizeTitle(settings.stripTitle).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    link.download = `${fileTitle || "puzzlecam"}_animated_${Date.now()}.gif`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast("Animated GIF saved! ✨");
  }, 40);
}

async function copyPhotoToClipboard() {
  if (galleryEntries.length === 0) return;
  const stripCanvas = renderLayoutCanvas(galleryEntries, settings.layout);
  if (!stripCanvas) return;

  try {
    stripCanvas.toBlob(async (blob) => {
      if (!blob) return;
      if (navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        showToast("Copied photo strip to clipboard! 📋");
      } else {
        showToast("Clipboard copy not supported in this browser");
      }
    }, "image/png");
  } catch (err) {
    console.warn("Clipboard copy failed:", err);
    showToast("Could not copy to clipboard");
  }
}

function resetEverything() {
  discardSolveRecording();
  galleryEntries.length = 0;
  galleryStrip.innerHTML = "";
  galleryCount.textContent = `0 / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) {
    galleryEmpty.style.display = "block";
    galleryStrip.appendChild(galleryEmpty);
  }
  hideStripComplete();
  challenge.active = null;
  lastSolve = null;
  updateChallengeChip();
  updateStripDownloadAvailability();
  resetPuzzleOnly();
  statusText.textContent = "all reset";
  showToast("All reset");
}

function renderGalleryThumb(snapshotCanvas, index) {
  const print = document.createElement("div");
  print.className = "print";

  const thumbCanvas = document.createElement("canvas");
  const THUMB_W = 220;
  const scale = THUMB_W / snapshotCanvas.width;
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = Math.round(snapshotCanvas.height * scale);
  thumbCanvas.getContext("2d").drawImage(snapshotCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);

  const label = document.createElement("div");
  label.className = "print-label";
  label.textContent = `${sanitizeTitle(settings.stripTitle)} #${String(index).padStart(2, "0")}`;

  print.appendChild(thumbCanvas);
  print.appendChild(label);
  galleryStrip.insertBefore(print, galleryStrip.firstChild);
}

function resetPuzzleOnly() {
  puzzle.boardBox = null;
  puzzle.pieces = [];
  puzzle.solved = false;
  puzzle.fullPhotoboothCanvas = null;
  appState = "tracking";
  countdown.active = false;
  drag.activeHand = null;
  drag.piece = null;
  pointerDrag.active = false;
  pointerDrag.piece = null;
  pointerDrag.pointerId = null;
  shatter.active = false;
  shatter.fragments = [];
  shatter.pendingCanvas = null;
  fistHoldCounter = 0;
  lastSeenFrame.box = null;
  lastSeenFrame.at = 0;
  smoothedBox.active = false;
  updateProgressBadge();
}

function fitCanvasToWindow() {
  const stageEl = document.getElementById("stage");
  const vw = stageEl.clientWidth;
  const vh = stageEl.clientHeight;
  const videoAspect = canvas.width / canvas.height;
  const containerAspect = vw / vh;

  // On narrow screens, letterbox (contain) so the whole camera view — and the
  // user's hands — stay visible instead of being cropped at the edges.
  const contain = window.matchMedia("(max-width: 900px)").matches;

  let cssWidth, cssHeight;
  if (containerAspect > videoAspect) {
    if (contain) {
      cssHeight = vh;
      cssWidth = vh * videoAspect;
    } else {
      cssWidth = vw;
      cssHeight = vw / videoAspect;
    }
  } else {
    if (contain) {
      cssWidth = vw;
      cssHeight = vw / videoAspect;
    } else {
      cssHeight = vh;
      cssWidth = vh * videoAspect;
    }
  }

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

window.addEventListener("resize", fitCanvasToWindow);
window.addEventListener("orientationchange", () => {
  setTimeout(fitCanvasToWindow, 150);
});

async function initWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support getUserMedia.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  videoEl.srcObject = stream;

  await new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });

  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  fitCanvasToWindow();
}

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function initVisionModels() {
  let vision;
  try {
    vision = await withTimeout(
      FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      ),
      LOAD_TIMEOUT_MS,
      "Timed out loading the MediaPipe runtime (WASM). Check your connection or whether cdn.jsdelivr.net is blocked."
    );
  } catch (err) {
    throw err;
  }

  let handLm = null;
  try {
    handLm = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "video",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Timed out downloading the HandLandmarker model (~10MB) with GPU."
    );
  } catch (gpuErr) {
    console.warn("[PuzzleCam] GPU delegate failed for HandLandmarker, retrying with CPU...", gpuErr);
    handLm = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "CPU",
        },
        runningMode: "video",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Timed out downloading the HandLandmarker model (~10MB), even with CPU. Check your connection or whether storage.googleapis.com is blocked."
    );
  }

  return { handLandmarker: handLm };
}

function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isPinching(landmarks) {
  return dist2D(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) < PINCH_THRESHOLD;
}

function isFist(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  let curled = 0;
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) < dist2D(landmarks[mcpIdx], wrist)) curled++;
  }
  return curled >= 4;
}

function toPixel(landmarkNorm) {
  return { x: landmarkNorm.x * canvas.width, y: landmarkNorm.y * canvas.height };
}

function mirrorLandmarkX(landmark) {
  return { x: 1 - landmark.x, y: landmark.y };
}

function computeHandFrame(indexTipA, indexTipB) {
  const a = toPixel(indexTipA);
  const b = toPixel(indexTipB);

  const minX = Math.min(a.x, b.x) - FRAME_PADDING;
  const maxX = Math.max(a.x, b.x) + FRAME_PADDING;
  const minY = Math.min(a.y, b.y) - FRAME_PADDING;
  const maxY = Math.max(a.y, b.y) + FRAME_PADDING;

  const x = Math.max(0, minX);
  const y = Math.max(0, minY);
  const width = Math.min(canvas.width, maxX) - x;
  const height = Math.min(canvas.height, maxY) - y;

  return smoothBox({ x, y, width, height });
}

const freezeGate = { holding: false, since: 0 };

const FRAME_GRACE_MS = 450;
const lastSeenFrame = { box: null, at: 0 };

const countdownBurst = {
  frames: [],
  lastSampleTime: 0,
};

const countdown = {
  active: false,
  startedAt: 0,
};

function startCountdown(frameBox) {
  puzzle.boardBox = { ...frameBox };
  appState = "countdown";
  countdown.active = true;
  countdown.startedAt = performance.now();
  countdownBurst.frames = [];
  countdownBurst.lastSampleTime = 0;
}

function drawCountdownOverlay(box) {
  const elapsed = (performance.now() - countdown.startedAt) / 1000;
  const remaining = COUNTDOWN_SECONDS - elapsed;

  if (remaining <= 0) {
    finishCountdownAndCapture(box);
    return;
  }

  // Sample Boomerang video frames during the countdown
  const now = performance.now();
  if (now - countdownBurst.lastSampleTime > 85) {
    countdownBurst.lastSampleTime = now;
    const cropW = Math.max(1, Math.round(box.width));
    const cropH = Math.max(1, Math.round(box.height));
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = cropW;
    sampleCanvas.height = cropH;
    const sCtx = sampleCanvas.getContext("2d");
    sCtx.save();
    sCtx.drawImage(
      videoEl,
      0, 0, videoEl.videoWidth, videoEl.videoHeight,
      0, 0, cropW, cropH
    );
    sCtx.restore();
    // Mirror horizontal for natural webcam feel
    const mirroredSample = document.createElement("canvas");
    mirroredSample.width = cropW;
    mirroredSample.height = cropH;
    const mCtx = mirroredSample.getContext("2d");
    mCtx.translate(cropW, 0);
    mCtx.scale(-1, 1);
    mCtx.drawImage(sampleCanvas, 0, 0);
    applyPhotoFilterToCanvas(mirroredSample, settings.photoFilter);
    countdownBurst.frames.push(applyPuzzleOrientation(mirroredSample));
    if (countdownBurst.frames.length > 10) {
      countdownBurst.frames.shift();
    }
  }

  applyBWInsideBox(box);

  ctx.save();
  ctx.strokeStyle = getAccentColor();
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const n = Math.ceil(remaining);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  ctx.fillStyle = "rgba(10,10,8,0.45)";
  ctx.fillRect(box.x, box.y, box.width, box.height);

  ctx.font = `${Math.max(48, Math.min(box.width, box.height) * 0.4)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = getAccentColor();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), cx, cy);
  ctx.restore();

  statusText.textContent = `capturing in ${n}...`;
}

function gaussianNoise(std) {
  const u1 = Math.random() || 1e-6;
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * std;
}

function applyPhotoboothEffect(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let v = gray * PHOTOBOOTH_CONTRAST_ALPHA + PHOTOBOOTH_BRIGHTNESS_BETA;
    v += gaussianNoise(PHOTOBOOTH_NOISE_STD);
    v = Math.max(0, Math.min(255, v));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return imageData;
}

function finishCountdownAndCapture(box) {
  countdown.active = false;

  const mirroredFrame = document.createElement("canvas");
  mirroredFrame.width = canvas.width;
  mirroredFrame.height = canvas.height;
  const mirroredCtx = mirroredFrame.getContext("2d");
  drawCameraFrame(mirroredCtx, mirroredFrame.width, mirroredFrame.height);

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(box.width));
  cropCanvas.height = Math.max(1, Math.round(box.height));
  const cropCtx = cropCanvas.getContext("2d");
  cropCtx.drawImage(
    mirroredFrame,
    box.x, box.y, box.width, box.height,
    0, 0, cropCanvas.width, cropCanvas.height
  );

  applyPhotoFilterToCanvas(cropCanvas, settings.photoFilter);
  const orientedCropCanvas = applyPuzzleOrientation(cropCanvas);
  puzzle.fullPhotoboothCanvas = orientedCropCanvas;

  // Build Boomerang ping-pong sequence
  const boomerang = [];
  if (countdownBurst.frames.length >= 2) {
    const forward = [...countdownBurst.frames, orientedCropCanvas];
    const reverse = [...countdownBurst.frames].reverse();
    boomerang.push(...forward, ...reverse);
  } else {
    boomerang.push(orientedCropCanvas);
  }
  puzzle.boomerangFrames = boomerang;

  const tileW = Math.floor(orientedCropCanvas.width / GRID);
  const tileH = Math.floor(orientedCropCanvas.height / GRID);
  const pieces = [];

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const sx = col * tileW;
      const sy = row * tileH;
      const w = col === GRID - 1 ? orientedCropCanvas.width - sx : tileW;
      const h = row === GRID - 1 ? orientedCropCanvas.height - sy : tileH;

      const pieceCanvas = document.createElement("canvas");
      pieceCanvas.width = w;
      pieceCanvas.height = h;
      pieceCanvas.getContext("2d").drawImage(orientedCropCanvas, sx, sy, w, h, 0, 0, w, h);

      // Create slice for each frame in Boomerang motion
      const pieceFrames = boomerang.map((bFrame) => {
        const pCanvas = document.createElement("canvas");
        pCanvas.width = w;
        pCanvas.height = h;
        pCanvas.getContext("2d").drawImage(bFrame, sx, sy, w, h, 0, 0, w, h);
        return pCanvas;
      });

      pieces.push({
        row, col,
        canvas: pieceCanvas,
        frames: pieceFrames,
        w, h,
        x: 0, y: 0,
        placed: false,
        dragging: false,
      });
    }
  }

  const seed = puzzle.nextSeed != null ? puzzle.nextSeed : randomSeed();
  puzzle.nextSeed = null;
  puzzle.seed = seed;

  const slots = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      slots.push({ x: box.x + col * tileW, y: box.y + row * tileH });
    }
  }
  shuffleWithRng(slots, mulberry32(seed));

  pieces.forEach((piece, i) => {
    piece.x = slots[i].x;
    piece.y = slots[i].y;
    if (isNearOwnCell(piece, box, tileW, tileH)) {
      snapPieceToCell(piece, box, tileW, tileH);
    }
  });

  puzzle.boardBox = box;
  puzzle.pieces = pieces;
  puzzle.tileW = tileW;
  puzzle.tileH = tileH;
  puzzle.solved = pieces.every((p) => p.placed);
  puzzle.startedAt = performance.now();
  puzzle.elapsedMs = 0;
  puzzle.moves = 0;
  puzzle.solveRecorded = false;
  appState = "puzzle";
  fistHoldCounter = 0;
  startSolveRecording();
  updateProgressBadge();
}

const drag = {
  activeHand: null,
  piece: null,
  offsetX: 0,
  offsetY: 0,
};

const pointerDrag = {
  active: false,
  piece: null,
  offsetX: 0,
  offsetY: 0,
  pointerId: null,
};

function isNearOwnCell(piece, box, tileW, tileH) {
  const correctX = box.x + piece.col * tileW;
  const correctY = box.y + piece.row * tileH;
  const dx = piece.x - correctX;
  const dy = piece.y - correctY;
  const tolerance = Math.min(tileW, tileH) * SNAP_DISTANCE_RATIO;
  return Math.sqrt(dx * dx + dy * dy) < tolerance;
}

function reconcilePlacedState(box, tileW, tileH) {
  if (!box || !puzzle.pieces.length) return false;
  for (const piece of puzzle.pieces) {
    if (piece.displacing || piece.dragging) continue;
    piece.placed = isNearOwnCell(piece, box, tileW, tileH);
  }
  return puzzle.pieces.every((p) => p.placed);
}

function snapPieceToCell(piece, box, tileW, tileH) {
  displaceCellOccupant(piece, piece.row, piece.col, box, tileW, tileH);
  piece.x = box.x + piece.col * tileW;
  piece.y = box.y + piece.row * tileH;
  piece.placed = true;
}

function displaceCellOccupant(piece, targetRow, targetCol, box, tileW, tileH) {
  const cellX = box.x + targetCol * tileW;
  const cellY = box.y + targetRow * tileH;

  const occupant = puzzle.pieces.find((p) => {
    if (p === piece || p.displacing) return false;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return (
      cx >= cellX && cx < cellX + tileW &&
      cy >= cellY && cy < cellY + tileH
    );
  });
  if (!occupant) return;

  // Never displace a piece that's locked in its correct cell.
  if (occupant.row === targetRow && occupant.col === targetCol && occupant.placed) {
    return;
  }

  occupant.placed = false;

  const freeCells = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (row === targetRow && col === targetCol) continue;
      const cx0 = box.x + col * tileW;
      const cy0 = box.y + row * tileH;
      const taken = puzzle.pieces.some((p) => {
        if (p === occupant || p === piece || p.displacing) return false;
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        return cx >= cx0 && cx < cx0 + tileW && cy >= cy0 && cy < cy0 + tileH;
      });
      if (!taken) freeCells.push({ row, col });
    }
  }

  let targetSlot;
  if (freeCells.length > 0) {
    targetSlot = freeCells[Math.floor(Math.random() * freeCells.length)];
  } else {
    targetSlot = { row: occupant.row, col: occupant.col };
  }

  const targetX = box.x + targetSlot.col * tileW;
  const targetY = box.y + targetSlot.row * tileH;

  animateDisplacement(occupant, targetX, targetY, box);
}

const DISPLACE_ANIM_MS = 220;

function animateDisplacement(piece, targetX, targetY, box) {
  const startX = piece.x;
  const startY = piece.y;
  const startedAt = performance.now();

  piece.displacing = true;

  function step() {
    const t = Math.min(1, (performance.now() - startedAt) / DISPLACE_ANIM_MS);
    const eased = 1 - Math.pow(1 - t, 3);

    piece.x = startX + (targetX - startX) * eased;
    piece.y = startY + (targetY - startY) * eased;

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      piece.x = targetX;
      piece.y = targetY;
      piece.displacing = false;
      clampPieceToBoard(piece);
    }
  }

  requestAnimationFrame(step);
}

function findNearestPiece(px, py) {
  let best = null;
  let bestDist = Infinity;
  for (const piece of puzzle.pieces) {
    if (piece.displacing || piece.placed) continue; // locked in its correct spot
    const cx = piece.x + piece.w / 2;
    const cy = piece.y + piece.h / 2;
    const d = Math.hypot(px - cx, py - cy);
    if (d < Math.max(piece.w, piece.h) * 0.75 && d < bestDist) {
      best = piece;
      bestDist = d;
    }
  }
  return best;
}

function cellFromPoint(px, py, box, tileW, tileH) {
  return {
    row: Math.min(GRID - 1, Math.max(0, Math.floor((py - box.y) / tileH))),
    col: Math.min(GRID - 1, Math.max(0, Math.floor((px - box.x) / tileW))),
  };
}

function pieceCell(piece, box, tileW, tileH) {
  return cellFromPoint(piece.x + piece.w / 2, piece.y + piece.h / 2, box, tileW, tileH);
}

function pieceInCell(row, col, box, tileW, tileH, exclude) {
  const cellX = box.x + col * tileW;
  const cellY = box.y + row * tileH;
  return puzzle.pieces.find((p) => {
    if (p === exclude || p.displacing) return false;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return cx >= cellX && cx < cellX + tileW && cy >= cellY && cy < cellY + tileH;
  }) || null;
}

function placePieceInCell(piece, row, col, box, tileW, tileH) {
  piece.x = box.x + col * tileW;
  piece.y = box.y + row * tileH;
}

// Snap a released piece into the grid (swapping with a loose occupant) so that
// exactly one piece sits in every cell and pieces never overlap.
function settleDroppedPiece(piece) {
  const box = puzzle.boardBox;
  const tileW = puzzle.tileW;
  const tileH = puzzle.tileH;
  if (!box || !tileW || !tileH) return;

  const origin = piece.dragOrigin || pieceCell(piece, box, tileW, tileH);
  const target = pieceCell(piece, box, tileW, tileH);
  piece.dragOrigin = null;

  if (target.row === piece.row && target.col === piece.col) {
    // Landed on its own cell → snap home and lock.
    snapPieceToCell(piece, box, tileW, tileH);
  } else {
    const occupant = pieceInCell(target.row, target.col, box, tileW, tileH, piece);

    if (occupant && occupant.placed) {
      // A locked piece owns the target cell → send this piece back where it started.
      placePieceInCell(piece, origin.row, origin.col, box, tileW, tileH);
    } else {
      // Swap with the loose occupant so the origin cell stays filled.
      if (occupant) {
        occupant.placed = false;
        if (occupant.row === origin.row && occupant.col === origin.col) {
          snapPieceToCell(occupant, box, tileW, tileH);
        } else {
          placePieceInCell(occupant, origin.row, origin.col, box, tileW, tileH);
        }
      }
      placePieceInCell(piece, target.row, target.col, box, tileW, tileH);
      piece.placed = false;
    }
  }

  const finalCell = pieceCell(piece, box, tileW, tileH);
  if (finalCell.row !== origin.row || finalCell.col !== origin.col) {
    puzzle.moves = (puzzle.moves || 0) + 1;
  }
}

function handleDragForHand(handLabel, pinching, indexPx) {
  if (pinching) {
    if (drag.activeHand === null) {
      const candidate = findNearestPiece(indexPx.x, indexPx.y);
      if (candidate) {
        drag.activeHand = handLabel;
        drag.piece = candidate;
        drag.offsetX = indexPx.x - candidate.x;
        drag.offsetY = indexPx.y - candidate.y;
        candidate.dragOrigin = pieceCell(candidate, puzzle.boardBox, puzzle.tileW, puzzle.tileH);
        candidate.dragging = true;
        candidate.placed = false;
      }
    } else if (drag.activeHand === handLabel && drag.piece) {
      drag.piece.x = indexPx.x - drag.offsetX;
      drag.piece.y = indexPx.y - drag.offsetY;
    }
  } else {
    if (drag.activeHand === handLabel && drag.piece) {
      const piece = drag.piece;
      piece.dragging = false;
      settleDroppedPiece(piece);
      drag.activeHand = null;
      drag.piece = null;
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
    }
  }
}

function clampPieceToBoard(piece) {
  const box = puzzle.boardBox;
  piece.x = Math.min(Math.max(piece.x, box.x), box.x + box.width - piece.w);
  piece.y = Math.min(Math.max(piece.y, box.y), box.y + box.height - piece.h);
}

function drawPieceLock(piece) {
  const s = Math.max(12, Math.min(piece.w, piece.h) * 0.26);
  const pad = s * 0.3;
  const cx = piece.x + piece.w - pad - s * 0.5;
  const cy = piece.y + pad + s * 0.5;
  const bodyW = s * 0.58;
  const bodyH = s * 0.46;
  const bodyX = cx - bodyW / 2;
  const bodyY = cy - s * 0.02;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.62, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = getOkColor();
  ctx.lineWidth = Math.max(1.5, s * 0.13);
  ctx.beginPath();
  ctx.arc(cx, bodyY, s * 0.2, Math.PI, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = getOkColor();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(bodyX, bodyY, bodyW, bodyH, s * 0.1);
  } else {
    ctx.rect(bodyX, bodyY, bodyW, bodyH);
  }
  ctx.fill();
  ctx.restore();
}

function drawBoardAndPieces() {
  const box = puzzle.boardBox;

  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = `${getAccentColor()}33`;
  ctx.lineWidth = 1;
  for (let i = 1; i < GRID; i++) {
    ctx.beginPath();
    ctx.moveTo(box.x + i * puzzle.tileW, box.y);
    ctx.lineTo(box.x + i * puzzle.tileW, box.y + box.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(box.x, box.y + i * puzzle.tileH);
    ctx.lineTo(box.x + box.width, box.y + i * puzzle.tileH);
    ctx.stroke();
  }
  ctx.restore();

  const sorted = [...puzzle.pieces].sort((a, b) => (a.dragging ? 1 : 0) - (b.dragging ? 1 : 0));

  for (const piece of sorted) {
    ctx.save();
    if (piece.dragging) {
      ctx.shadowColor = getAccentColor();
      ctx.shadowBlur = 14;
    }
    let drawSource = piece.canvas;
    if (settings.liveMotion && piece.frames && piece.frames.length > 0) {
      const fIdx = Math.floor((performance.now() / 100) % piece.frames.length);
      drawSource = piece.frames[fIdx] || piece.canvas;
    }
    ctx.drawImage(drawSource, piece.x, piece.y, piece.w, piece.h);
    ctx.strokeStyle = piece.placed ? getOkColor() : `${getPaperColor()}99`;
    ctx.lineWidth = piece.dragging ? 3 : 1.5;
    ctx.strokeRect(piece.x, piece.y, piece.w, piece.h);
    if (piece.placed && !piece.dragging) {
      drawPieceLock(piece);
    }
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = puzzle.solved ? getOkColor() : getAccentColor();
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();

  if (puzzle.solved) {
    ctx.save();
    ctx.fillStyle = `${getOkColor()}26`;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.font = `${Math.max(20, box.width * 0.07)}px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = getOkColor();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("COMPLETE - make a fist to save", box.x + box.width / 2, box.y + box.height / 2);
    ctx.restore();
  }
}

function updateProgressBadge() {
  if (appState !== "puzzle") {
    progressBadge.classList.remove("visible", "solved");
    return;
  }
  const placedCount = puzzle.pieces.filter((p) => p.placed).length;
  const clock = puzzle.startedAt ? ` • ${formatDuration(performance.now() - puzzle.startedAt)}` : "";
  progressText.textContent = `${placedCount} / ${puzzle.pieces.length} pieces • ${puzzle.moves} moves${clock}`;
  progressBadge.classList.add("visible");
  progressBadge.classList.toggle("solved", puzzle.solved);
  recordSolveIfNeeded();
}

function drawVideoFrame() {
  drawCameraFrame(ctx, canvas.width, canvas.height);
}

function ensureCameraFxCanvas(width, height) {
  if (cameraFx.frameCanvas.width !== width || cameraFx.frameCanvas.height !== height) {
    cameraFx.frameCanvas.width = width;
    cameraFx.frameCanvas.height = height;
  }
}

function drawMirroredVideo(targetCtx, width, height) {
  targetCtx.save();
  targetCtx.translate(width, 0);
  targetCtx.scale(-1, 1);
  targetCtx.drawImage(videoEl, 0, 0, width, height);
  targetCtx.restore();
}

function drawCameraPatternOverlay(targetCtx, width, height, effect) {
  targetCtx.save();
  targetCtx.globalCompositeOperation = "screen";

  if (effect === "prism") {
    targetCtx.globalAlpha = 0.38;
    targetCtx.strokeStyle = getAccentColor();
    targetCtx.lineWidth = Math.max(2, width * 0.002);
    const step = Math.max(34, width * 0.052);
    for (let x = -width; x < width * 1.6; x += step) {
      targetCtx.beginPath();
      targetCtx.moveTo(x, 0);
      targetCtx.lineTo(x + width * 0.42, height);
      targetCtx.stroke();
    }
    targetCtx.strokeStyle = getAccentTwoColor();
    for (let y = -height * 0.2; y < height * 1.2; y += step * 0.9) {
      targetCtx.beginPath();
      targetCtx.moveTo(0, y);
      targetCtx.lineTo(width, y + height * 0.18);
      targetCtx.stroke();
    }
  } else if (effect === "static") {
    targetCtx.globalAlpha = 0.22;
    const dotSize = Math.max(1, Math.round(width / 360));
    for (let i = 0; i < 900; i++) {
      const isAccent = i % 5 === 0;
      targetCtx.fillStyle = isAccent ? getAccentColor() : "rgba(255,255,255,0.9)";
      targetCtx.fillRect(Math.random() * width, Math.random() * height, dotSize, dotSize);
    }
  } else if (effect === "scanlines") {
    targetCtx.globalAlpha = 0.3;
    targetCtx.fillStyle = getAccentColor();
    const lineGap = Math.max(5, height * 0.012);
    for (let y = 0; y < height; y += lineGap) {
      targetCtx.fillRect(0, y, width, 1);
    }
    const sweepX = ((performance.now() / 18) % (width * 1.4)) - width * 0.2;
    const gradient = targetCtx.createLinearGradient(sweepX - width * 0.18, 0, sweepX + width * 0.18, 0);
    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(0.5, getAccentTwoColor());
    gradient.addColorStop(1, "transparent");
    targetCtx.fillStyle = gradient;
    targetCtx.fillRect(0, 0, width, height);
  } else if (effect === "hypno") {
    targetCtx.globalAlpha = 0.36;
    targetCtx.strokeStyle = getAccentTwoColor();
    targetCtx.lineWidth = Math.max(2, width * 0.0025);
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.hypot(width, height);
    const offset = (performance.now() / 28) % 28;
    for (let r = 18 + offset; r < maxR; r += 38) {
      targetCtx.beginPath();
      targetCtx.arc(cx, cy, r, 0, Math.PI * 2);
      targetCtx.stroke();
    }
    targetCtx.strokeStyle = getAccentColor();
    for (let i = 0; i < 18; i++) {
      const angle = (i / 18) * Math.PI * 2 + performance.now() / 2500;
      targetCtx.beginPath();
      targetCtx.moveTo(cx, cy);
      targetCtx.lineTo(cx + Math.cos(angle) * maxR, cy + Math.sin(angle) * maxR);
      targetCtx.stroke();
    }
  }

  targetCtx.restore();
}

function drawCameraFrame(targetCtx, width, height) {
  const effect = settings.backgroundFx;

  if (effect === "none") {
    drawMirroredVideo(targetCtx, width, height);
    return;
  }

  ensureCameraFxCanvas(width, height);
  const fxCtx = cameraFx.frameCtx;

  fxCtx.clearRect(0, 0, width, height);
  drawMirroredVideo(fxCtx, width, height);
  drawCameraPatternOverlay(fxCtx, width, height, effect);

  targetCtx.drawImage(cameraFx.frameCanvas, 0, 0, width, height);
}

function applyBWInsideBox(box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(canvas.width - x, Math.round(box.width));
  const h = Math.min(canvas.height - y, Math.round(box.height));
  if (w <= 0 || h <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.filter = "grayscale(100%) contrast(130%) brightness(105%)";
  drawMirroredVideo(ctx, canvas.width, canvas.height);
  ctx.restore();
}

function drawLiveFrameOverlay(box) {
  ctx.save();
  ctx.strokeStyle = getAccentColor();
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const cornerLen = 18;
  ctx.lineWidth = 4;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.width, box.y, -1, 1],
    [box.x, box.y + box.height, 1, -1],
    [box.x + box.width, box.y + box.height, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + cornerLen * dy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + cornerLen * dx, cy);
    ctx.stroke();
  }
  ctx.restore();
}

function isPointInBoard(px, py, box) {
  if (!box) return false;
  return (
    px >= box.x &&
    px <= box.x + box.width &&
    py >= box.y &&
    py <= box.y + box.height
  );
}

function drawHandSkeleton(landmarksPx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(255,255,255,0.85)";
  ctx.shadowBlur = 10;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;

  for (const [iA, iB] of HAND_CONNECTIONS) {
    const a = landmarksPx[iA];
    const b = landmarksPx[iB];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.shadowBlur = 6;
  ctx.fillStyle = "white";
  for (const p of landmarksPx) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawHandSkeletonsOverBoard(handsLandmarks, box) {
  if (!box || !handsLandmarks || handsLandmarks.length === 0) return;

  for (const lm of handsLandmarks) {
    const landmarksPx = lm.map((pt) => toPixel(mirrorLandmarkX(pt)));
    const overBoard = landmarksPx.some((p) => isPointInBoard(p.x, p.y, box));
    if (overBoard) {
      drawHandSkeleton(landmarksPx);
    }
  }
}

function startShatter(sourceCanvas, box, boomerangFrames = null) {
  const cols = SHATTER_COLS;
  const rows = SHATTER_ROWS;
  const fragW = sourceCanvas.width / cols;
  const fragH = sourceCanvas.height / rows;
  const fragments = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = col * fragW;
      const sy = row * fragH;

      const fragCanvas = document.createElement("canvas");
      fragCanvas.width = Math.ceil(fragW);
      fragCanvas.height = Math.ceil(fragH);
      fragCanvas.getContext("2d").drawImage(
        sourceCanvas,
        sx, sy, fragW, fragH,
        0, 0, fragCanvas.width, fragCanvas.height
      );

      const cx = box.x + sx + fragW / 2;
      const cy = box.y + sy + fragH / 2;

      const boardCx = box.x + box.width / 2;
      const boardCy = box.y + box.height / 2;
      const dirX = cx - boardCx;
      const dirY = cy - boardCy;
      const dirLen = Math.max(1, Math.hypot(dirX, dirY));
      const speed = 90 + Math.random() * 160;

      fragments.push({
        canvas: fragCanvas,
        x: cx,
        y: cy,
        w: fragW,
        h: fragH,
        vx: (dirX / dirLen) * speed + (Math.random() - 0.5) * 40,
        vy: (dirY / dirLen) * speed + (Math.random() - 0.5) * 40 - 60,
        rotation: 0,
        rotationSpeed: (Math.random() - 0.5) * 6,
        gravity: 220 + Math.random() * 80,
      });
    }
  }

  shatter.fragments = fragments;
  shatter.pendingFrames = boomerangFrames || [sourceCanvas];
  shatter.active = true;
  shatter.startedAt = performance.now();
  lastShatterTime = shatter.startedAt;
  appState = "shattering";
}

let lastShatterTime = 0;

function updateAndDrawShatter() {
  const now = performance.now();
  const elapsedMs = now - shatter.startedAt;
  const t = Math.min(1, elapsedMs / SHATTER_DURATION_MS);

  if (t >= 1) {
    finishShatter();
    return;
  }

  const dt = lastShatterTime > 0 ? Math.min(0.04, Math.max(0.001, (now - lastShatterTime) / 1000)) : 1 / 60;
  lastShatterTime = now;
  const fadeStart = 0.45;

  ctx.save();
  for (const frag of shatter.fragments) {
    frag.x += frag.vx * dt;
    frag.y += frag.vy * dt;
    frag.vy += frag.gravity * dt;
    frag.rotation += frag.rotationSpeed * dt;

    const alpha = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (1 - fadeStart));
    const scale = 1 - t * 0.25;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(frag.x, frag.y);
    ctx.rotate(frag.rotation);
    ctx.scale(scale, scale);
    ctx.drawImage(frag.canvas, -frag.w / 2, -frag.h / 2, frag.w, frag.h);
    ctx.restore();
  }
  ctx.restore();
}

function finishShatter() {
  shatter.active = false;
  shatter.fragments = [];
  if (shatter.pendingCanvas) {
    const entry = addToGallery(shatter.pendingCanvas, shatter.pendingFrames);
    stopSolveRecording(entry);
    statusText.textContent = "saved to strip";
    showToast("Saved to strip! 📸");
    shatter.pendingCanvas = null;
    shatter.pendingFrames = null;
  } else {
    discardSolveRecording();
  }
  resetPuzzleOnly();
}

function handleFistReset() {
  if (appState !== "puzzle") {
    statusText.textContent = "reset by fist";
    resetPuzzleOnly();
    return;
  }

  const reallySolved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
  puzzle.solved = reallySolved;

  if (reallySolved && puzzle.fullPhotoboothCanvas) {
    shatter.pendingCanvas = puzzle.fullPhotoboothCanvas;
    startShatter(puzzle.fullPhotoboothCanvas, puzzle.boardBox, puzzle.boomerangFrames);
  } else {
    statusText.textContent = "reset by fist";
    discardSolveRecording();
    resetPuzzleOnly();
  }
}

let handLandmarker = null;
let fistHoldCounter = 0;

function processResults(result) {
  if (appState === "shattering") {
    updateAndDrawShatter();
    statusText.textContent = "saving...";
    return;
  }

  const handsLandmarks = result.landmarks || [];
  const noHands = handsLandmarks.length === 0;

  if (noHands) {
    statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot";
    fistHoldCounter = 0;
    freezeGate.holding = false;

    if (drag.activeHand && drag.piece) {
      handleDragForHand(drag.activeHand, false, { x: drag.piece.x, y: drag.piece.y });
    }

    if (appState === "tracking") {
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyBWInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
      }
      statusText.textContent = isStripFull()
        ? "strip complete - download or reset"
        : "looking for hands...";
      return;
    }

    if (appState === "countdown") {
      drawCountdownOverlay(puzzle.boardBox);
      return;
    }

    if (appState === "puzzle") {
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
      drawBoardAndPieces();
      statusText.textContent = puzzle.solved
        ? "puzzle complete - make a fist to save"
        : "solve the puzzle with pinch";
      return;
    }

    return;
  }

  statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot live";

  const anyFist = handsLandmarks.some((lm) => isFist(lm));
  const draggingNow = drag.activeHand !== null && drag.piece !== null;
  if (anyFist && !draggingNow && appState !== "tracking") {
    fistHoldCounter++;
    if (fistHoldCounter >= FIST_HOLD_FRAMES) {
      fistHoldCounter = 0;
      handleFistReset();
      return;
    }
  } else {
    fistHoldCounter = 0;
  }

  if (appState === "tracking") {
    if (isStripFull()) {
      statusText.textContent = "strip complete - download or reset";
      return;
    }
    if (handsLandmarks.length === 2) {
      const [handA, handB] = handsLandmarks;
      const indexA = mirrorLandmarkX(handA[LM.INDEX_TIP]);
      const indexB = mirrorLandmarkX(handB[LM.INDEX_TIP]);
      const frameBox = computeHandFrame(indexA, indexB);

      if (frameBox.width > 4 && frameBox.height > 4) {
        applyBWInsideBox(frameBox);
        drawLiveFrameOverlay(frameBox);
        lastSeenFrame.box = frameBox;
        lastSeenFrame.at = performance.now();
      }

      const bothPinching = isPinching(handA) && isPinching(handB);
      if (bothPinching && frameBox.width > 40 && frameBox.height > 40) {
        if (!freezeGate.holding) {
          freezeGate.holding = true;
          freezeGate.since = performance.now();
        }
        statusDot.className = "status-dot armed";
        statusText.textContent = "hold the pinch...";

        if (performance.now() - freezeGate.since > FREEZE_HOLD_MS) {
          freezeGate.holding = false;
          startCountdown(frameBox);
        }
      } else {
        freezeGate.holding = false;
        statusText.textContent = "hands in tracking";
      }
    } else {
      freezeGate.holding = false;
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyBWInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
        statusText.textContent = "hands in tracking";
      } else {
        statusText.textContent = "hands in tracking";
      }
    }
    return;
  }

  if (appState === "countdown") {
    drawCountdownOverlay(puzzle.boardBox);
    return;
  }

  if (appState === "puzzle") {
    const labelsPresent = new Set();
    handsLandmarks.forEach((lm, i) => {
      const label = i === 0 ? "A" : "B";
      labelsPresent.add(label);
      const pinching = isPinching(lm);
      const indexPx = toPixel(mirrorLandmarkX(lm[LM.INDEX_TIP]));
      handleDragForHand(label, pinching, indexPx);
    });

    if (drag.activeHand && !labelsPresent.has(drag.activeHand) && drag.piece) {
      handleDragForHand(drag.activeHand, false, { x: drag.piece.x, y: drag.piece.y });
    }

    if (!drag.piece) {
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
    }

    drawBoardAndPieces();
    drawHandSkeletonsOverBoard(handsLandmarks, puzzle.boardBox);

    statusText.textContent = puzzle.solved
      ? (fistHoldCounter > 0
          ? `saving... hold fist (${fistHoldCounter}/${FIST_HOLD_FRAMES})`
          : "puzzle complete - make a fist to save")
      : "solve the puzzle with pinch";
  }
}

function renderLoop() {
  if (videoEl.readyState >= 2 && handLandmarker) {
    const nowMs = performance.now();
    drawVideoFrame();
    const result = handLandmarker.detectForVideo(videoEl, nowMs);
    processResults(result);
  }
  requestAnimationFrame(renderLoop);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
}

function showLoaderError(message) {
  loaderText.textContent = message;
  loaderText.style.color = "#e0533d";
  loaderRetry.classList.remove("hidden");
}

function resetLoaderUI() {
  loadingOverlay.classList.remove("hidden");
  loaderText.style.color = "";
  loaderText.textContent = "loading AI vision models...";
  loaderRetry.classList.add("hidden");
  errorBanner.style.display = "none";
}

if (themeSelect) {
  themeSelect.addEventListener("change", () => {
    applyTheme(themeSelect.value, true);
  });
}

if (backgroundFxSelect) {
  backgroundFxSelect.addEventListener("change", () => {
    applyBackgroundFx(backgroundFxSelect.value);
  });
}

if (bgColorInput) {
  bgColorInput.addEventListener("input", () => {
    settings.bgColor = bgColorInput.value;
    document.body.style.setProperty("--bg", settings.bgColor);
  });
}

if (accentColorInput) {
  accentColorInput.addEventListener("input", () => {
    settings.accentColor = accentColorInput.value;
    document.body.style.setProperty("--accent", settings.accentColor);
  });
}

if (stripTitleInput) {
  stripTitleInput.addEventListener("input", () => {
    settings.stripTitle = stripTitleInput.value;
  });
  stripTitleInput.addEventListener("blur", () => {
    settings.stripTitle = sanitizeTitle(stripTitleInput.value);
    stripTitleInput.value = settings.stripTitle;
  });
}

applyTheme(settings.theme);
applyBackgroundFx(settings.backgroundFx);

if (recordSolvesToggle) recordSolvesToggle.checked = settings.recordSolves;

const incomingChallenge = readChallengeFromUrl();
if (incomingChallenge) {
  applyChallenge(incomingChallenge);
}
updateChallengeChip();

async function boot() {
  resetLoaderUI();

  let settled = false;
  const watchdogMs = (LOAD_TIMEOUT_MS * 2) + 5000;
  const watchdog = setTimeout(() => {
    if (!settled) {
      showLoaderError("Loading is taking too long. Retry or check your connection.");
    }
  }, watchdogMs);

  try {
    if (!videoEl.srcObject) {
      await initWebcam();
    }

    const models = await initVisionModels();
    handLandmarker = models.handLandmarker;

    settled = true;
    clearTimeout(watchdog);
    loadingOverlay.classList.add("hidden");
    statusText.textContent = "ready";
    requestAnimationFrame(renderLoop);
  } catch (err) {
    settled = true;
    clearTimeout(watchdog);
    if (err && err.name === "NotAllowedError") {
      showLoaderError("Camera permission was denied. Enable it in your browser settings, then retry.");
    } else if (err && err.name === "NotFoundError") {
      showLoaderError("No webcam was found.");
    } else {
      showLoaderError((err && err.message) || "Error starting the app.");
    }
  }
}

loaderRetry.addEventListener("click", () => {
  boot();
});

if (layoutSelect) {
  layoutSelect.addEventListener("change", () => {
    settings.layout = layoutSelect.value;
  });
}

if (photoFilterSelect) {
  photoFilterSelect.addEventListener("change", () => {
    settings.photoFilter = photoFilterSelect.value;
  });
}

if (puzzleOrientationSelect) {
  puzzleOrientationSelect.addEventListener("change", () => {
    settings.puzzleOrientation = puzzleOrientationSelect.value;
    showToast(
      settings.puzzleOrientation === "mirror"
        ? "Mirror mode enabled for the next puzzle 🪞"
        : "Normal puzzle orientation enabled"
    );
  });
}

if (liveMotionToggle) {
  liveMotionToggle.addEventListener("change", () => {
    settings.liveMotion = liveMotionToggle.checked;
  });
}

if (recordSolvesToggle) {
  recordSolvesToggle.addEventListener("change", () => {
    settings.recordSolves = recordSolvesToggle.checked;
    if (!settings.recordSolves) {
      discardSolveRecording();
    } else if (appState === "puzzle") {
      startSolveRecording();
    }
  });
}

if (downloadStripBtn) {
  downloadStripBtn.addEventListener("click", downloadPhotoStrip);
}

if (downloadGifBtn) {
  downloadGifBtn.addEventListener("click", downloadAnimatedGif);
}

if (copyClipboardBtn) {
  copyClipboardBtn.addEventListener("click", copyPhotoToClipboard);
}

if (downloadVideoBtn) {
  downloadVideoBtn.addEventListener("click", downloadSolveVideo);
}

if (shareChallengeBtn) {
  shareChallengeBtn.addEventListener("click", shareChallenge);
}

if (qrCloseBtn) {
  qrCloseBtn.addEventListener("click", hideQrOverlay);
}

if (qrCopyBtn) {
  qrCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildShareUrl());
      showToast("Link copied! 🔗");
    } catch (err) {
      showToast("Could not copy the link");
    }
  });
}

if (qrOverlay) {
  qrOverlay.addEventListener("click", (evt) => {
    if (evt.target === qrOverlay) hideQrOverlay();
  });
}

document.addEventListener("keydown", (evt) => {
  if (evt.key === "Escape") hideQrOverlay();
});

updateStripDownloadAvailability();

if (resetAllBtn) {
  resetAllBtn.addEventListener("click", () => {
    const confirmed = window.confirm(
      "Clear the whole photo strip and start over?"
    );
    if (confirmed) resetEverything();
  });
}

function getCanvasPointerPos(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

canvas.addEventListener("pointerdown", (evt) => {
  if (appState !== "puzzle" || !puzzle.pieces.length) return;
  const pos = getCanvasPointerPos(evt);
  const piece = findNearestPiece(pos.x, pos.y);
  if (piece) {
    try { canvas.setPointerCapture(evt.pointerId); } catch (e) {}
    pointerDrag.active = true;
    pointerDrag.piece = piece;
    pointerDrag.pointerId = evt.pointerId;
    pointerDrag.offsetX = pos.x - piece.x;
    pointerDrag.offsetY = pos.y - piece.y;
    piece.dragOrigin = pieceCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH);
    piece.dragging = true;
    piece.placed = false;
  }
});

canvas.addEventListener("pointermove", (evt) => {
  if (!pointerDrag.active || !pointerDrag.piece || pointerDrag.pointerId !== evt.pointerId) return;
  const pos = getCanvasPointerPos(evt);
  pointerDrag.piece.x = pos.x - pointerDrag.offsetX;
  pointerDrag.piece.y = pos.y - pointerDrag.offsetY;
});

function finishPointerDrag(evt) {
  if (!pointerDrag.active || (pointerDrag.pointerId !== null && pointerDrag.pointerId !== evt.pointerId)) return;
  const piece = pointerDrag.piece;
  if (piece) {
    piece.dragging = false;
    settleDroppedPiece(piece);
    puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
    updateProgressBadge();
  }
  try { if (evt.pointerId) canvas.releasePointerCapture(evt.pointerId); } catch (e) {}
  pointerDrag.active = false;
  pointerDrag.piece = null;
  pointerDrag.pointerId = null;
}

canvas.addEventListener("pointerup", finishPointerDrag);
canvas.addEventListener("pointercancel", finishPointerDrag);

boot();
