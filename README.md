# PuzzleCam — Gesture Capture

A gesture-controlled photobooth app that runs entirely in the browser. No installation, no backend, no dependencies to install.

---

## **DESCRIPTION**

PuzzleCam captures a photo using your hands as the "frame", turns it into a 3x3 puzzle with a black-and-white photobooth effect, and lets you solve it with pinch gestures. When complete, it gets saved to a downloadable photo strip.

---

## **SYSTEM REQUIREMENTS**

- **Browser:** Chrome or Edge (recommended), Firefox, Safari (iOS)
- **Hardware:** Webcam (front camera on phones)
- **Internet connection:** Required to load the MediaPipe model (~10MB, first time only)
- **Local server:** Required to run the app (it cannot be opened directly as a file)
- **Deploying:** Serve over **HTTPS** (or `localhost`) — browsers only allow camera access in a secure context

---

## **INSTALLATION AND SETUP**

### 1. Clone the repository

```bash
git clone https://github.com/mishu006/Puzzle.git
cd Puzzle
```

### 2. Start a local server

The app uses ES modules and camera access, so it needs to run over HTTP.

Install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension in VS Code and click **Go Live**.

### 3. Open in the browser

```
http://localhost:5500
```

Allow camera access when the browser prompts you.

---

## **MOBILE & DEPLOYMENT**

The layout is responsive: below 900px wide the camera stage stacks on top and the
controls scroll underneath, with larger tap targets and safe-area padding for notched
phones. Puzzle pieces can be dragged with a **finger** as well as with a pinch gesture.

Because camera access requires a **secure context**, deploy the app over **HTTPS**:

- **Netlify / Vercel / GitHub Pages** — drag-and-drop or connect the repo; HTTPS is automatic
- **Any static host** — just upload `index.html`, `app.js`, and `css/`

For a quick LAN test on a phone, `http://<your-computer-ip>:5500` works on most browsers
only for `localhost`, so use a tunnel (e.g. `ngrok http 5500`) to get an HTTPS URL.

---

## **PROJECT STRUCTURE**

```
Puzzle/
├── index.html        # App entry point
├── app.js            # Full logic (tracking, puzzle, gallery, sharing)
├── qrcode.js         # Dependency-free QR code encoder (byte mode)
├── css/
│   └── styles.css    # Styling and layout
└── .gitignore
```

---

## **CONTROL GESTURES**

| Gesture | Action |
|---|---|
| Both hands pinching | Freeze the area and start the countdown |
| One hand pinching over a piece | Drag a loose puzzle piece (correctly-placed pieces lock in place) |
| Closed fist (hold) | Save completed puzzle / Reset board |

Use the **Puzzle orientation** control to enable **Mirror mode**. The next captured puzzle
will be flipped horizontally, including its live boomerang frames, while the camera preview
stays unchanged.

---

## **APP LOGIC**

1. Show both hands to the camera and pinch to define the capture frame
2. Hold the pinch during the countdown — the photo is taken automatically
3. The photo is split into a 3x3 puzzle with a black-and-white photobooth filter
4. Rearrange the pieces with pinch gestures — they snap into the grid and swap places, and each piece locks once it's in the correct spot
5. When complete, close your fist to save it to the strip with a shatter animation
6. Download the full strip once you have 3 saved puzzles

---

## **SHARING**

Every finished puzzle records **how long it took** and **how many moves** you made. The
share pack turns that into something you can send to other people:

### QR code on the strip

Each downloaded strip (Classic, Polaroid, Magazine, or Grid) carries a **QR code** in its
footer. Scanning it opens the same app — or, once you've solved a puzzle, opens your
**challenge link** with your time and move count attached.

### Challenge links (seeded puzzle)

The **Share Challenge & QR** button copies a link that encodes:

- the **seed** used to scramble the puzzle, so the recipient gets the exact same scramble
- your **finish time** and **move count** to beat
- the **settings** you played with (layout, filter, orientation, motion, title, theme)

Opening a link shows a **"Beat 00:42 · 14 moves"** chip and pre-loads those settings. The
scramble is reproducible because the shuffle runs on a deterministic, seeded PRNG
(`mulberry32` + Fisher–Yates) instead of `Math.random()`.

### Solve video (WebM)

While **Record solve video** is on, the app records the canvas with `MediaRecorder` from
the moment a puzzle appears until it's saved. The **Download Solve Video** button then
exports the latest recording as a `.webm` (or `.mp4` where WebM isn't supported). A red
**● REC** badge shows while recording. Turn the toggle off on low-end devices if you don't
need it.

> The QR encoder in `qrcode.js` is written from scratch (byte mode, versions 1–40, EC
> levels L/M/Q/H) so the app stays dependency-free and works offline.

---

## **TECH STACK**

- **[MediaPipe Tasks Vision](https://developers.google.com/mediapipe)** `v0.10.14` — hand landmark detection
- **Canvas 2D API** — rendering, puzzle pieces, photobooth effect
- **MediaRecorder + `canvas.captureStream()`** — WebM solve recordings
- **JavaScript (ES Modules)** — no frameworks
- **CSS Custom Properties** — theming and layout

All external dependencies are loaded via CDN, except the QR encoder (`qrcode.js`) which is
bundled locally. No additional installation is required.

---

## **TROUBLESHOOTING GUIDE**

### **The camera won't turn on**

Make sure no other application (Teams, Zoom, Discord, etc.) is using the camera in the background.

### **The app won't load the model**

Check your internet connection. The MediaPipe model (~10MB) downloads from `storage.googleapis.com` and the runtime from `cdn.jsdelivr.net`. If either of those domains is blocked on your network, the app won't be able to start.

### **The app shows a black screen**

Make sure you're opening the app from a local server (HTTP), not directly as a file from the file explorer.

### **The pinch gesture isn't detected**

Make sure you have good lighting and that both hands are visible to the camera. Bring your index finger and thumb closer together until the on-screen indicator activates.

### **The solve video button is greyed out**

Check that **Record solve video** is switched on and that you've completed (and saved) a
puzzle. Solve recording uses `MediaRecorder` with WebM, which Chrome, Edge, and Firefox
support; Safari records `.mp4` where available.

---

## **BROWSER COMPATIBILITY**

| Browser | Support |
|---|---|
| Chrome / Edge | Recommended |
| Firefox | Compatible |
| Safari | Limited (may require additional permissions) |
| Mobile | Supported (responsive layout, front camera + touch drag) |

---

## **LICENSE**

MIT — free to use, modify, and share.
