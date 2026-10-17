// qrcode.js — tiny dependency-free QR Code generator (byte mode).
//
// Produces ISO/IEC 18004 model-2 symbols (versions 1-40, EC levels L/M/Q/H)
// as a plain module matrix that can be drawn onto a canvas.
// Only byte mode is implemented, which is exactly what a URL needs.

const CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

// Number of error correction blocks per version, in L, M, Q, H order.
const EC_BLOCKS = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4,
  1, 2, 4, 4, 2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6,
  2, 5, 8, 8, 4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11,
  4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18, 6, 10, 17, 16,
  6, 11, 16, 19, 6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25,
  8, 17, 23, 25, 9, 17, 23, 34, 9, 18, 25, 30, 10, 20, 27, 32,
  12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42,
  14, 28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51, 17, 33, 45, 54,
  18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63, 20, 40, 56, 66,
  21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

// Total error correction codewords per version, in L, M, Q, H order.
const EC_CODEWORDS = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64,
  26, 48, 72, 88, 36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156,
  60, 110, 160, 192, 72, 130, 192, 224, 80, 150, 224, 264, 96, 176, 260, 308,
  104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480,
  168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700,
  224, 442, 644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960,
  312, 588, 870, 1050, 336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260,
  420, 784, 1140, 1350, 450, 812, 1200, 1440, 480, 868, 1290, 1530, 510, 924, 1350, 1620,
  540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590, 1890, 600, 1120, 1680, 1980,
  630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

const LEVELS = {
  L: { index: 0, bit: 1 },
  M: { index: 1, bit: 0 },
  Q: { index: 2, bit: 3 },
  H: { index: 3, bit: 2 },
};

const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

// --- Galois field GF(256) -------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

// --- BCH helpers ----------------------------------------------------------

function bchDigit(data) {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G15_BCH = bchDigit(G15);

function formatInfoBits(levelBit, mask) {
  const data = (levelBit << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - G15_BCH >= 0) {
    d ^= G15 << (bchDigit(d) - G15_BCH);
  }
  return ((data << 10) | d) ^ G15_MASK;
}

const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G18_BCH = bchDigit(G18);

function versionInfoBits(version) {
  let d = version << 12;
  while (bchDigit(d) - G18_BCH >= 0) {
    d ^= G18 << (bchDigit(d) - G18_BCH);
  }
  return (version << 12) | d;
}

// --- Capacity / version selection ----------------------------------------

function symbolSize(version) {
  return version * 4 + 17;
}

function charCountBits(version) {
  return version < 10 ? 8 : 16;
}

function capacityBytes(version, level) {
  const total = CODEWORDS[version];
  const ec = EC_CODEWORDS[(version - 1) * 4 + LEVELS[level].index];
  const dataBits = (total - ec) * 8;
  return Math.floor((dataBits - 4 - charCountBits(version)) / 8);
}

function pickVersion(byteLength, level) {
  for (let v = 1; v <= 40; v++) {
    if (byteLength <= capacityBytes(v, level)) return v;
  }
  throw new Error("QR data too large to encode");
}

// --- Codeword assembly ----------------------------------------------------

function buildDataCodewords(bytes, version, level) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  put(0b0100, 4); // byte mode indicator
  put(bytes.length, charCountBits(version));
  for (let i = 0; i < bytes.length; i++) put(bytes[i], 8);

  const total = CODEWORDS[version];
  const ec = EC_CODEWORDS[(version - 1) * 4 + LEVELS[level].index];
  const dataCodewordsCount = total - ec;
  const capacityBits = dataCodewordsCount * 8;

  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataCodewordsCount);
  for (let i = 0; i < bits.length; i += 8) {
    let byteVal = 0;
    for (let j = 0; j < 8; j++) byteVal = (byteVal << 1) | bits[i + j];
    data[i / 8] = byteVal;
  }
  let k = 0;
  for (let i = bits.length / 8; i < dataCodewordsCount; i++, k++) {
    data[i] = k % 2 ? 0x11 : 0xec;
  }
  return data;
}

function interleaveCodewords(data, version, level) {
  const total = CODEWORDS[version];
  const ecTotal = EC_CODEWORDS[(version - 1) * 4 + LEVELS[level].index];
  const dataTotal = total - ecTotal;
  const blocks = EC_BLOCKS[(version - 1) * 4 + LEVELS[level].index];

  const blocksGroup2 = total % blocks;
  const blocksGroup1 = blocks - blocksGroup2;
  const codewordsPerBlock = Math.floor(total / blocks);
  const dataPerBlock1 = Math.floor(dataTotal / blocks);
  const dataPerBlock2 = dataPerBlock1 + 1;
  const ecPerBlock = codewordsPerBlock - dataPerBlock1;

  const dcBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  let maxData = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < blocksGroup1 ? dataPerBlock1 : dataPerBlock2;
    const block = data.slice(offset, offset + size);
    dcBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += size;
    maxData = Math.max(maxData, size);
  }

  const out = new Uint8Array(total);
  let index = 0;
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < dcBlocks[b].length) out[index++] = dcBlocks[b][i];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) out[index++] = ecBlocks[b][i];
  }
  return out;
}

// --- Matrix construction --------------------------------------------------

function alignmentCoords(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < count - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

function maskBit(pattern, r, c) {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r * c) % 3) + ((r + c) % 2)) % 2 === 0;
    default: return false;
  }
}

function buildMatrix(version, level, codewords, forcedMask) {
  const size = symbolSize(version);
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);

  const set = (r, c, value, reserve) => {
    const i = r * size + c;
    modules[i] = value ? 1 : 0;
    if (reserve) reserved[i] = 1;
  };
  const isReserved = (r, c) => reserved[r * size + c];

  // Finder patterns (with separators).
  const finders = [[0, 0], [0, size - 7], [size - 7, 0]];
  for (let f = 0; f < finders.length; f++) {
    const fr = finders[f][0];
    const fc = finders[f][1];
    for (let r = -1; r <= 7; r++) {
      if (fr + r < 0 || fr + r >= size) continue;
      for (let c = -1; c <= 7; c++) {
        if (fc + c < 0 || fc + c >= size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(fr + r, fc + c, dark, true);
      }
    }
  }

  // Timing patterns.
  for (let r = 8; r < size - 8; r++) {
    const dark = r % 2 === 0;
    set(r, 6, dark, true);
    set(6, r, dark, true);
  }

  // Alignment patterns.
  const coords = alignmentCoords(version);
  for (let i = 0; i < coords.length; i++) {
    for (let j = 0; j < coords.length; j++) {
      const row = coords[i];
      const col = coords[j];
      if (
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6)
      ) {
        continue;
      }
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          set(row + r, col + c, dark, true);
        }
      }
    }
  }

  const setupFormatInfo = (mask) => {
    const bits = formatInfoBits(LEVELS[level].bit, mask);
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1;
      if (i < 6) set(i, 8, dark, true);
      else if (i < 8) set(i + 1, 8, dark, true);
      else set(size - 15 + i, 8, dark, true);

      if (i < 8) set(8, size - i - 1, dark, true);
      else if (i < 9) set(8, 15 - i, dark, true);
      else set(8, 15 - i - 1, dark, true);
    }
    set(size - 8, 8, 1, true);
  };

  // Reserve format areas before data placement (values get rewritten later).
  setupFormatInfo(0);

  // Version information (version 7+).
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = (i % 3) + size - 11;
      const dark = ((bits >> i) & 1) === 1;
      set(row, col, dark, true);
      set(col, row, dark, true);
    }
  }

  // Data placement (zig-zag, right to left, skipping the timing column).
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (!isReserved(row, col - c)) {
          let dark = false;
          if (byteIndex < codewords.length) {
            dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          }
          set(row, col - c, dark, false);
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }

  const applyMask = (pattern) => {
    for (let c = 0; c < size; c++) {
      for (let r = 0; r < size; r++) {
        if (reserved[r * size + c]) continue;
        if (maskBit(pattern, r, c)) modules[r * size + c] ^= 1;
      }
    }
  };

  const penaltyN1 = () => {
    let points = 0;
    for (let r = 0; r < size; r++) {
      let runRow = 0;
      let runCol = 0;
      let lastRow = -1;
      let lastCol = -1;
      for (let c = 0; c < size; c++) {
        const rowVal = modules[r * size + c];
        if (rowVal === lastRow) runRow++;
        else {
          if (runRow >= 5) points += PENALTY.N1 + (runRow - 5);
          lastRow = rowVal;
          runRow = 1;
        }
        const colVal = modules[c * size + r];
        if (colVal === lastCol) runCol++;
        else {
          if (runCol >= 5) points += PENALTY.N1 + (runCol - 5);
          lastCol = colVal;
          runCol = 1;
        }
      }
      if (runRow >= 5) points += PENALTY.N1 + (runRow - 5);
      if (runCol >= 5) points += PENALTY.N1 + (runCol - 5);
    }
    return points;
  };

  const penaltyN2 = () => {
    let points = 0;
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const sum =
          modules[r * size + c] +
          modules[r * size + c + 1] +
          modules[(r + 1) * size + c] +
          modules[(r + 1) * size + c + 1];
        if (sum === 0 || sum === 4) points++;
      }
    }
    return points * PENALTY.N2;
  };

  const penaltyN3 = () => {
    let points = 0;
    for (let r = 0; r < size; r++) {
      let bitsRow = 0;
      let bitsCol = 0;
      for (let c = 0; c < size; c++) {
        bitsRow = ((bitsRow << 1) & 0x7ff) | modules[r * size + c];
        if (c >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
        bitsCol = ((bitsCol << 1) & 0x7ff) | modules[c * size + r];
        if (c >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;
      }
    }
    return points * PENALTY.N3;
  };

  const penaltyN4 = () => {
    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i];
    const k = Math.abs(Math.ceil((dark * 100) / modules.length / 5) - 10);
    return k * PENALTY.N4;
  };

  let mask = forcedMask;
  if (mask == null) {
    let best = 0;
    let lowest = Infinity;
    for (let p = 0; p < 8; p++) {
      setupFormatInfo(p);
      applyMask(p);
      const score = penaltyN1() + penaltyN2() + penaltyN3() + penaltyN4();
      applyMask(p);
      if (score < lowest) {
        lowest = score;
        best = p;
      }
    }
    mask = best;
  }

  applyMask(mask);
  setupFormatInfo(mask);

  return { size, modules, mask, version, level };
}

// --- Public API -----------------------------------------------------------

/**
 * Build a QR module matrix for the given text.
 *
 * @param {string} text
 * @param {{ level?: "L"|"M"|"Q"|"H", version?: number, mask?: number }} [options]
 * @returns {{ size:number, modules:Uint8Array, version:number, level:string, mask:number }}
 */
export function createQR(text, options = {}) {
  const level = LEVELS[options.level] ? options.level : "M";
  const bytes = new TextEncoder().encode(text);
  const version =
    options.version && options.version >= 1 && options.version <= 40
      ? options.version
      : pickVersion(bytes.length, level);

  if (bytes.length > capacityBytes(version, level)) {
    throw new Error(`QR data does not fit in version ${version} at level ${level}`);
  }

  const dataCodewords = buildDataCodewords(bytes, version, level);
  const codewords = interleaveCodewords(dataCodewords, version, level);
  const forcedMask =
    options.mask != null && options.mask >= 0 && options.mask <= 7 ? options.mask : null;

  return buildMatrix(version, level, codewords, forcedMask);
}

/**
 * Draw a QR matrix onto a canvas 2D context.
 */
export function drawQR(targetCtx, matrix, x, y, sizePx, options = {}) {
  const dark = options.dark || "#000000";
  const light = options.light || "#ffffff";
  const margin = options.margin == null ? 4 : options.margin;
  const total = matrix.size + margin * 2;
  const n = matrix.size;

  // Draw at a whole number of pixels per module and centre the symbol in the
  // requested box. Uniform module sizes keep the code easy for scanners to
  // resolve at any output resolution.
  const scale = Math.max(1, Math.floor(sizePx / total));
  const drawn = total * scale;
  const originX = Math.round(x + (sizePx - drawn) / 2);
  const originY = Math.round(y + (sizePx - drawn) / 2);

  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.rect(x, y, sizePx, sizePx);
  targetCtx.clip();

  targetCtx.fillStyle = light;
  targetCtx.fillRect(x, y, sizePx, sizePx);
  targetCtx.fillStyle = dark;

  for (let r = 0; r < n; r++) {
    const top = originY + (margin + r) * scale;
    for (let c = 0; c < n; c++) {
      if (!matrix.modules[r * n + c]) continue;
      targetCtx.fillRect(originX + (margin + c) * scale, top, scale, scale);
    }
  }
  targetCtx.restore();
}
