import {
  FilesetResolver,
  HandLandmarker,
  ImageSegmenter,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

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
const resetAllBtn = document.getElementById("resetAllBtn");
const stripCompleteMsg = document.getElementById("stripCompleteMsg");
const themeSelect = document.getElementById("themeSelect");
const backgroundFxSelect = document.getElementById("backgroundFxSelect");
const bgColorInput = document.getElementById("bgColorInput");
const accentColorInput = document.getElementById("accentColorInput");
const stripTitleInput = document.getElementById("stripTitleInput");
const imageGallery = document.getElementById("imageGallery");

let appState = "tracking";

const settings = {
  theme: "cyberpunk",
  bgColor: "#070816",
  accentColor: "#00e5ff",
  backgroundFx: "aurora",
  stripTitle: "PuzzleCam Session",
  puzzleImage: "camera",
};

const themeDefaults = {
  cyberpunk: { bg: "#070816", accent: "#00e5ff" },
  studio: { bg: "#111318", accent: "#e7eef8" },
  sunset: { bg: "#180b22", accent: "#ffb86b" },
  arcade: { bg: "#05050b", accent: "#7cff00" },
};

const puzzleImageChoices = [
  { id: "camera", label: "Camera" },
  { id: "neon", label: "Neon" },
  { id: "studio", label: "Studio" },
  { id: "tropical", label: "Tropic" },
  { id: "arcade", label: "Arcade" },
];

const cameraFx = {
  frameCanvas: document.createElement("canvas"),
  frameCtx: null,
};
cameraFx.frameCtx = cameraFx.frameCanvas.getContext("2d", { willReadFrequently: true });

let imageSegmenter = null;

const segmentationState = {
  maskCanvas: document.createElement("canvas"),
  maskCtx: null,
  rawCanvas: document.createElement("canvas"),
  rawCtx: null,
  personCanvas: document.createElement("canvas"),
  personCtx: null,
  rawImageData: null,
  hasSegmentation: false,
  lastUpdateMs: 0,
};

segmentationState.maskCtx = segmentationState.maskCanvas.getContext("2d", { willReadFrequently: true });
segmentationState.rawCtx = segmentationState.rawCanvas.getContext("2d", { willReadFrequently: true });
segmentationState.personCtx = segmentationState.personCanvas.getContext("2d", { willReadFrequently: true });

const puzzle = {
  boardBox: null,
  pieces: [],
  solved: false,
  tileW: 0,
  tileH: 0,
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
  return cssVar("--accent-2") || "#ff3df2";
}

function getOkColor() {
  return cssVar("--ok") || "#4ade80";
}

function getPaperColor() {
  return cssVar("--paper") || "#f7fbff";
}

function sanitizeTitle(value) {
  return (value || "PuzzleCam Session").trim().slice(0, 28) || "PuzzleCam Session";
}

function drawProceduralImage(targetCanvas, variant) {
  const w = targetCanvas.width;
  const h = targetCanvas.height;
  const imageCtx = targetCanvas.getContext("2d");
  const gradient = imageCtx.createLinearGradient(0, 0, w, h);

  if (variant === "studio") {
    gradient.addColorStop(0, "#f7f8fb");
    gradient.addColorStop(1, "#8692a8");
  } else if (variant === "tropical") {
    gradient.addColorStop(0, "#ff7a59");
    gradient.addColorStop(0.55, "#ffcf6b");
    gradient.addColorStop(1, "#1fc7b6");
  } else if (variant === "arcade") {
    gradient.addColorStop(0, "#0a0620");
    gradient.addColorStop(0.5, "#22145a");
    gradient.addColorStop(1, "#06070d");
  } else {
    gradient.addColorStop(0, "#0b1028");
    gradient.addColorStop(0.45, "#651fff");
    gradient.addColorStop(1, "#00d4ff");
  }

  imageCtx.fillStyle = gradient;
  imageCtx.fillRect(0, 0, w, h);

  if (variant === "studio") {
    imageCtx.fillStyle = "rgba(255,255,255,0.58)";
    imageCtx.fillRect(w * 0.12, h * 0.16, w * 0.76, h * 0.62);
    imageCtx.strokeStyle = "rgba(20,25,34,0.28)";
    imageCtx.lineWidth = Math.max(2, w * 0.012);
    imageCtx.strokeRect(w * 0.12, h * 0.16, w * 0.76, h * 0.62);
    imageCtx.fillStyle = "rgba(25,30,40,0.22)";
    imageCtx.beginPath();
    imageCtx.arc(w * 0.34, h * 0.42, w * 0.14, 0, Math.PI * 2);
    imageCtx.fill();
  } else if (variant === "tropical") {
    imageCtx.fillStyle = "rgba(255,255,255,0.8)";
    imageCtx.beginPath();
    imageCtx.arc(w * 0.76, h * 0.24, w * 0.13, 0, Math.PI * 2);
    imageCtx.fill();
    imageCtx.fillStyle = "rgba(12,91,87,0.45)";
    for (let i = 0; i < 5; i++) {
      imageCtx.beginPath();
      imageCtx.ellipse(w * (0.18 + i * 0.15), h * 0.78, w * 0.12, h * 0.035, -0.5 + i * 0.25, 0, Math.PI * 2);
      imageCtx.fill();
    }
  } else if (variant === "arcade") {
    imageCtx.strokeStyle = "#7cff00";
    imageCtx.lineWidth = Math.max(2, w * 0.01);
    for (let x = 0; x < w; x += w / 8) {
      imageCtx.beginPath();
      imageCtx.moveTo(x, 0);
      imageCtx.lineTo(w / 2 + (x - w / 2) * 0.35, h);
      imageCtx.stroke();
    }
    imageCtx.strokeStyle = "#ff2bd6";
    for (let y = h * 0.55; y < h; y += h / 10) {
      imageCtx.beginPath();
      imageCtx.moveTo(0, y);
      imageCtx.lineTo(w, y);
      imageCtx.stroke();
    }
  } else {
    imageCtx.strokeStyle = "rgba(255,255,255,0.82)";
    imageCtx.lineWidth = Math.max(2, w * 0.012);
    for (let i = 0; i < 6; i++) {
      imageCtx.beginPath();
      imageCtx.arc(w * (0.18 + i * 0.13), h * (0.28 + (i % 2) * 0.25), w * 0.12, 0, Math.PI * 2);
      imageCtx.stroke();
    }
    imageCtx.fillStyle = "rgba(255,61,242,0.55)";
    imageCtx.fillRect(w * 0.16, h * 0.68, w * 0.68, h * 0.08);
  }

}

function createProceduralCanvas(width, height, variant) {
  const generated = document.createElement("canvas");
  generated.width = width;
  generated.height = height;
  drawProceduralImage(generated, variant);
  return generated;
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
  document.body.classList.remove("fx-aurora", "fx-prism", "fx-static", "fx-scanlines", "fx-hypno", "fx-none");
  document.body.classList.add(`fx-${effect}`);
}

function renderImageGallery() {
  if (!imageGallery) return;
  imageGallery.innerHTML = "";

  puzzleImageChoices.forEach((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-choice";
    button.title = choice.label;
    button.setAttribute("role", "option");
    button.setAttribute("aria-label", choice.label);

    const preview = document.createElement("canvas");
    preview.width = 120;
    preview.height = 120;
    if (choice.id === "camera") {
      const previewCtx = preview.getContext("2d");
      previewCtx.fillStyle = "#070816";
      previewCtx.fillRect(0, 0, preview.width, preview.height);
      previewCtx.strokeStyle = settings.accentColor;
      previewCtx.lineWidth = 5;
      previewCtx.strokeRect(22, 32, 76, 50);
      previewCtx.beginPath();
      previewCtx.arc(60, 57, 16, 0, Math.PI * 2);
      previewCtx.stroke();
    } else {
      drawProceduralImage(preview, choice.id);
    }

    button.appendChild(preview);
    button.classList.toggle("is-selected", settings.puzzleImage === choice.id);
    button.setAttribute("aria-selected", settings.puzzleImage === choice.id ? "true" : "false");
    button.addEventListener("click", () => {
      settings.puzzleImage = choice.id;
      renderImageGallery();
    });
    imageGallery.appendChild(button);
  });
}

function addToGallery(snapshotCanvas) {
  if (galleryEntries.length >= STRIP_MAX_PHOTOS) return;

  galleryEntries.push({ canvas: snapshotCanvas, time: Date.now() });
  renderGalleryThumb(snapshotCanvas, galleryEntries.length);
  galleryCount.textContent = `${galleryEntries.length} / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) galleryEmpty.style.display = "none";

  if (galleryEntries.length >= STRIP_MAX_PHOTOS) {
    showStripComplete();
  }
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
  if (!downloadStripBtn) return;
  downloadStripBtn.disabled = galleryEntries.length === 0;
}

const STRIP_FILE_BORDER = 24;
const STRIP_FILE_GAP = 16;
const STRIP_FILE_BG = "#ffffff";

function downloadPhotoStrip() {
  if (galleryEntries.length === 0) return;

  const entries = galleryEntries;
  const targetW = entries[0].canvas.width;
  const scaledHeights = entries.map((entry) =>
    Math.round(entry.canvas.height * (targetW / entry.canvas.width))
  );

  const totalH =
    STRIP_FILE_BORDER * 2 +
    28 +
    scaledHeights.reduce((sum, h) => sum + h, 0) +
    STRIP_FILE_GAP * (entries.length - 1);
  const totalW = targetW + STRIP_FILE_BORDER * 2;

  const stripCanvas = document.createElement("canvas");
  stripCanvas.width = totalW;
  stripCanvas.height = totalH;
  const stripCtx = stripCanvas.getContext("2d");

  stripCtx.fillStyle = STRIP_FILE_BG;
  stripCtx.fillRect(0, 0, totalW, totalH);

  stripCtx.fillStyle = "#10131f";
  stripCtx.font = "700 28px Inter, sans-serif";
  stripCtx.textAlign = "center";
  stripCtx.textBaseline = "top";
  stripCtx.fillText(sanitizeTitle(settings.stripTitle), totalW / 2, 10);

  let cursorY = STRIP_FILE_BORDER + 28;
  entries.forEach((entry, i) => {
    const h = scaledHeights[i];
    stripCtx.drawImage(entry.canvas, STRIP_FILE_BORDER, cursorY, targetW, h);
    cursorY += h + STRIP_FILE_GAP;
  });

  stripCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const fileTitle = sanitizeTitle(settings.stripTitle).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    link.download = `${fileTitle || "puzzlecam"}_strip_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

function resetEverything() {
  galleryEntries.length = 0;
  galleryStrip.innerHTML = "";
  galleryCount.textContent = `0 / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) {
    galleryEmpty.style.display = "block";
    galleryStrip.appendChild(galleryEmpty);
  }
  hideStripComplete();
  updateStripDownloadAvailability();
  resetPuzzleOnly();
  statusText.textContent = "all reset";
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
  shatter.active = false;
  shatter.fragments = [];
  shatter.pendingCanvas = null;
  fistHoldCounter = 0;
  lastSeenFrame.box = null;
  lastSeenFrame.at = 0;
  updateProgressBadge();
}

function fitCanvasToWindow() {
  const stageEl = document.getElementById("stage");
  const vw = stageEl.clientWidth;
  const vh = stageEl.clientHeight;
  const videoAspect = canvas.width / canvas.height;
  const containerAspect = vw / vh;

  let cssWidth, cssHeight;
  if (containerAspect > videoAspect) {
    cssWidth = vw;
    cssHeight = vw / videoAspect;
  } else {
    cssHeight = vh;
    cssWidth = vh * videoAspect;
  }

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

window.addEventListener("resize", fitCanvasToWindow);

async function initWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador no soporta getUserMedia.");
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
      "Tiempo de espera agotado descargando el modelo HandLandmarker (~10MB) con GPU."
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

  let imgSeg = null;
  try {
    imgSeg = await withTimeout(
      ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }),
      LOAD_TIMEOUT_MS,
      "Timed out downloading Selfie Segmenter (GPU)."
    );
  } catch (gpuSegErr) {
    console.warn("[PuzzleCam] GPU delegate failed for ImageSegmenter, retrying with CPU...", gpuSegErr);
    try {
      imgSeg = await withTimeout(
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        }),
        LOAD_TIMEOUT_MS,
        "Timed out downloading Selfie Segmenter (CPU)."
      );
    } catch (cpuSegErr) {
      console.warn("[PuzzleCam] ImageSegmenter failed to load. Falling back to shape mask.", cpuSegErr);
    }
  }

  return { handLandmarker: handLm, imageSegmenter: imgSeg };
}

let isSegmenting = false;

function runSegmentation(nowMs) {
  if (!imageSegmenter || videoEl.readyState < 2 || isSegmenting) return;
  isSegmenting = true;
  try {
    imageSegmenter.segmentForVideo(videoEl, nowMs, (result) => {
      try {
        if (result && result.categoryMask) {
          updateSegmentationMask(result.categoryMask);
          result.categoryMask.close();
        }
      } catch (e) {
        console.warn("[PuzzleCam] Error in segmentation callback:", e);
      } finally {
        isSegmenting = false;
      }
    });
  } catch (err) {
    isSegmenting = false;
    console.warn("[PuzzleCam] segmentForVideo call failed:", err);
  }
}

function updateSegmentationMask(categoryMask) {
  const maskW = categoryMask.width;
  const maskH = categoryMask.height;
  if (!maskW || !maskH) return;

  const maskBytes = categoryMask.getAsUint8Array();
  if (!maskBytes || maskBytes.length !== maskW * maskH) return;

  if (segmentationState.rawCanvas.width !== maskW || segmentationState.rawCanvas.height !== maskH) {
    segmentationState.rawCanvas.width = maskW;
    segmentationState.rawCanvas.height = maskH;
    segmentationState.rawImageData = segmentationState.rawCtx.createImageData(maskW, maskH);
  }

  const imgData = segmentationState.rawImageData;
  const data = imgData.data;

  for (let i = 0; i < maskBytes.length; i++) {
    const isPerson = maskBytes[i] === 0;
    const idx = i * 4;
    data[idx] = 255;
    data[idx + 1] = 255;
    data[idx + 2] = 255;
    data[idx + 3] = isPerson ? 255 : 0;
  }

  segmentationState.rawCtx.putImageData(imgData, 0, 0);

  const targetW = canvas.width || videoEl.videoWidth || 640;
  const targetH = canvas.height || videoEl.videoHeight || 480;

  if (segmentationState.maskCanvas.width !== targetW || segmentationState.maskCanvas.height !== targetH) {
    segmentationState.maskCanvas.width = targetW;
    segmentationState.maskCanvas.height = targetH;
  }

  const mCtx = segmentationState.maskCtx;
  mCtx.clearRect(0, 0, targetW, targetH);
  mCtx.save();
  mCtx.filter = "blur(4px)";
  mCtx.translate(targetW, 0);
  mCtx.scale(-1, 1);
  mCtx.drawImage(segmentationState.rawCanvas, 0, 0, targetW, targetH);
  mCtx.restore();

  segmentationState.hasSegmentation = true;
  segmentationState.lastUpdateMs = performance.now();
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

  return { x, y, width, height };
}

const freezeGate = { holding: false, since: 0 };

const FRAME_GRACE_MS = 450;
const lastSeenFrame = { box: null, at: 0 };

const countdown = {
  active: false,
  startedAt: 0,
};

function startCountdown(frameBox) {
  puzzle.boardBox = { ...frameBox };
  appState = "countdown";
  countdown.active = true;
  countdown.startedAt = performance.now();
}

function drawCountdownOverlay(box) {
  const elapsed = (performance.now() - countdown.startedAt) / 1000;
  const remaining = COUNTDOWN_SECONDS - elapsed;

  if (remaining <= 0) {
    finishCountdownAndCapture(box);
    return;
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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
  if (settings.puzzleImage === "camera") {
    cropCtx.drawImage(
      mirroredFrame,
      box.x, box.y, box.width, box.height,
      0, 0, cropCanvas.width, cropCanvas.height
    );
  } else {
    const selectedImage = createProceduralCanvas(cropCanvas.width, cropCanvas.height, settings.puzzleImage);
    cropCtx.drawImage(selectedImage, 0, 0, cropCanvas.width, cropCanvas.height);
  }

  const fullImageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  applyPhotoboothEffect(fullImageData);
  cropCtx.putImageData(fullImageData, 0, 0);

  puzzle.fullPhotoboothCanvas = cropCanvas;

  const tileW = Math.floor(cropCanvas.width / GRID);
  const tileH = Math.floor(cropCanvas.height / GRID);
  const pieces = [];

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const sx = col * tileW;
      const sy = row * tileH;
      const w = col === GRID - 1 ? cropCanvas.width - sx : tileW;
      const h = row === GRID - 1 ? cropCanvas.height - sy : tileH;

      const pieceCanvas = document.createElement("canvas");
      pieceCanvas.width = w;
      pieceCanvas.height = h;
      pieceCanvas.getContext("2d").drawImage(cropCanvas, sx, sy, w, h, 0, 0, w, h);

      pieces.push({
        row, col,
        canvas: pieceCanvas,
        w, h,
        x: 0, y: 0,
        placed: false,
        dragging: false,
      });
    }
  }

  const slots = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      slots.push({ x: box.x + col * tileW, y: box.y + row * tileH });
    }
  }
  shuffle(slots);

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
  appState = "puzzle";
  fistHoldCounter = 0;
  updateProgressBadge();
}

const drag = {
  activeHand: null,
  piece: null,
  offsetX: 0,
  offsetY: 0,
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

  const jitterX = (Math.random() - 0.5) * tileW * 0.5;
  const jitterY = (Math.random() - 0.5) * tileH * 0.5;
  const targetX = box.x + targetSlot.col * tileW + jitterX;
  const targetY = box.y + targetSlot.row * tileH + jitterY;

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
    if (piece.displacing) continue;
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

function handleDragForHand(handLabel, pinching, indexPx) {
  if (pinching) {
    if (drag.activeHand === null) {
      const candidate = findNearestPiece(indexPx.x, indexPx.y);
      if (candidate) {
        drag.activeHand = handLabel;
        drag.piece = candidate;
        drag.offsetX = indexPx.x - candidate.x;
        drag.offsetY = indexPx.y - candidate.y;
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
      if (isNearOwnCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH)) {
        snapPieceToCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      } else {
        clampPieceToBoard(piece);
        const box = puzzle.boardBox;
        const cx = piece.x + piece.w / 2;
        const cy = piece.y + piece.h / 2;
        const dropCol = Math.min(
          GRID - 1,
          Math.max(0, Math.floor((cx - box.x) / puzzle.tileW))
        );
        const dropRow = Math.min(
          GRID - 1,
          Math.max(0, Math.floor((cy - box.y) / puzzle.tileH))
        );
        displaceCellOccupant(piece, dropRow, dropCol, box, puzzle.tileW, puzzle.tileH);
      }
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
    ctx.drawImage(piece.canvas, piece.x, piece.y, piece.w, piece.h);
    ctx.strokeStyle = piece.placed ? getOkColor() : `${getPaperColor()}99`;
    ctx.lineWidth = piece.dragging ? 3 : 1.5;
    ctx.strokeRect(piece.x, piece.y, piece.w, piece.h);
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
  progressText.textContent = `${placedCount} / ${puzzle.pieces.length} piezas colocadas`;
  progressBadge.classList.add("visible");
  progressBadge.classList.toggle("solved", puzzle.solved);
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

function drawSharpPortraitWindow(targetCtx, width, height) {
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.ellipse(width * 0.5, height * 0.53, width * 0.24, height * 0.46, 0, 0, Math.PI * 2);
  targetCtx.clip();
  drawMirroredVideo(targetCtx, width, height);
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

  fxCtx.save();
  fxCtx.filter = effect === "aurora" ? "blur(18px) saturate(130%) brightness(108%)" : "blur(8px) saturate(145%) contrast(112%)";
  drawMirroredVideo(fxCtx, width, height);
  fxCtx.restore();

  if (effect === "aurora") {
    const glow = fxCtx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, width * 0.56);
    glow.addColorStop(0, "rgba(255,255,255,0.08)");
    glow.addColorStop(0.48, `${getAccentColor()}20`);
    glow.addColorStop(1, "rgba(0,0,0,0.38)");
    fxCtx.fillStyle = glow;
    fxCtx.fillRect(0, 0, width, height);
  } else {
    drawCameraPatternOverlay(fxCtx, width, height, effect);
  }

  const isSegFresh = segmentationState.hasSegmentation && (performance.now() - segmentationState.lastUpdateMs < 1200);

  if (isSegFresh) {
    if (segmentationState.personCanvas.width !== width || segmentationState.personCanvas.height !== height) {
      segmentationState.personCanvas.width = width;
      segmentationState.personCanvas.height = height;
    }
    const pCtx = segmentationState.personCtx;
    pCtx.clearRect(0, 0, width, height);

    drawMirroredVideo(pCtx, width, height);

    pCtx.globalCompositeOperation = "destination-in";
    pCtx.drawImage(segmentationState.maskCanvas, 0, 0, width, height);
    pCtx.globalCompositeOperation = "source-over";

    fxCtx.drawImage(segmentationState.personCanvas, 0, 0, width, height);
  } else {
    drawSharpPortraitWindow(fxCtx, width, height);
  }

  targetCtx.drawImage(cameraFx.frameCanvas, 0, 0, width, height);
}

function applyBWInsideBox(box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(canvas.width - x, Math.round(box.width));
  const h = Math.min(canvas.height - y, Math.round(box.height));
  if (w <= 0 || h <= 0) return;

  const region = ctx.getImageData(x, y, w, h);
  applyPhotoboothEffect(region);
  ctx.putImageData(region, x, y);
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

function startShatter(sourceCanvas, box) {
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
  shatter.active = true;
  shatter.startedAt = performance.now();
  appState = "shattering";
}

function updateAndDrawShatter() {
  const elapsedMs = performance.now() - shatter.startedAt;
  const t = Math.min(1, elapsedMs / SHATTER_DURATION_MS);

  if (t >= 1) {
    finishShatter();
    return;
  }

  const dt = 1 / 60;
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
    addToGallery(shatter.pendingCanvas);
    statusText.textContent = "saved to strip";
    shatter.pendingCanvas = null;
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
    startShatter(puzzle.fullPhotoboothCanvas, puzzle.boardBox);
  } else {
    statusText.textContent = "reset by fist";
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
        statusText.textContent = "manos en seguimiento";
      }
    } else {
      freezeGate.holding = false;
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyBWInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
        statusText.textContent = "manos en seguimiento";
      } else {
        statusText.textContent = "manos en seguimiento";
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
    if (imageSegmenter && settings.backgroundFx !== "none") {
      runSegmentation(nowMs);
    }
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
    renderImageGallery();
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
    renderImageGallery();
  });
}

if (stripTitleInput) {
  stripTitleInput.addEventListener("input", () => {
    settings.stripTitle = sanitizeTitle(stripTitleInput.value);
    stripTitleInput.value = settings.stripTitle;
  });
}

applyTheme(settings.theme);
applyBackgroundFx(settings.backgroundFx);
renderImageGallery();

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
    imageSegmenter = models.imageSegmenter;

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
      showLoaderError((err && err.message) || "Error iniciando la app.");
    }
  }
}

loaderRetry.addEventListener("click", () => {
  boot();
});

if (downloadStripBtn) {
  downloadStripBtn.addEventListener("click", downloadPhotoStrip);
  updateStripDownloadAvailability();
}

if (resetAllBtn) {
  resetAllBtn.addEventListener("click", () => {
    const confirmed = window.confirm(
      "Clear the whole photo strip and start over?"
    );
    if (confirmed) resetEverything();
  });
}

boot();
