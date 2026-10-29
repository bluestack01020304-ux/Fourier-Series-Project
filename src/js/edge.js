// 이미지 → 윤곽선(에지) → 샘플링된 점 → 한 붓 그리기 경로
const Edge = (() => {
  'use strict';

  // RGBA 픽셀에서 Canny 방식(블러 → Sobel → 비최대 억제 → 히스테리시스)으로 에지를 찾는다.
  // highFrac: 최대 기울기 대비 강한 에지 임계값 비율 (0~1)
  function detect(rgba, w, h, highFrac) {
    const n = w * h;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }

    const blurred = blur(gray, w, h);

    const mag = new Float32Array(n);
    const gxs = new Float32Array(n);
    const gys = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const tl = blurred[i - w - 1], t = blurred[i - w], tr = blurred[i - w + 1];
        const l = blurred[i - 1], r = blurred[i + 1];
        const bl = blurred[i + w - 1], b = blurred[i + w], br = blurred[i + w + 1];
        const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        gxs[i] = gx;
        gys[i] = gy;
        mag[i] = Math.hypot(gx, gy);
      }
    }

    // 비최대 억제: 기울기 방향으로 이웃보다 크지 않으면 버려서 에지를 1픽셀 두께로 만든다.
    const thin = new Float32Array(n);
    let max = 0;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const m = mag[i];
        if (m === 0) continue;
        const a = Math.atan2(gys[i], gxs[i]);
        const d = Math.round(Math.sin(a)) * w + Math.round(Math.cos(a));
        if (m >= mag[i + d] && m >= mag[i - d]) {
          thin[i] = m;
          if (m > max) max = m;
        }
      }
    }

    const edges = new Uint8Array(n);
    let count = 0;
    if (max === 0) return { edges, count };

    // 히스테리시스: 강한 에지에서 시작해 약한 에지로 이어지는 픽셀만 남긴다.
    const high = highFrac * max;
    const low = high * 0.4;
    const stack = [];
    const neighbors = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
    for (let i = 0; i < n; i++) {
      if (thin[i] < high || edges[i]) continue;
      edges[i] = 1;
      count++;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop();
        for (const d of neighbors) {
          const k = j + d;
          if (!edges[k] && thin[k] >= low) {
            edges[k] = 1;
            count++;
            stack.push(k);
          }
        }
      }
    }
    return { edges, count };
  }

  // 분리 가능한 5탭 가우시안 블러 [1 4 6 4 1] / 16
  function blur(src, w, h) {
    const k = [1, 4, 6, 4, 1];
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -2; j <= 2; j++) {
          const xx = Math.min(w - 1, Math.max(0, x + j));
          s += k[j + 2] * src[y * w + xx];
        }
        tmp[y * w + x] = s / 16;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -2; j <= 2; j++) {
          const yy = Math.min(h - 1, Math.max(0, y + j));
          s += k[j + 2] * tmp[yy * w + x];
        }
        out[y * w + x] = s / 16;
      }
    }
    return out;
  }

  // 에지 픽셀을 격자(cell×cell)당 하나씩만 남겨 목표 개수 이하로 줄인다.
  function samplePoints(edges, w, h, target) {
    const ex = [], ey = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (edges[y * w + x]) { ex.push(x); ey.push(y); }
      }
    }
    let cell = Math.max(1, Math.floor(ex.length / target / 1.5));
    let xs, ys;
    for (;;) {
      const gw = Math.ceil(w / cell);
      const occupied = new Uint8Array(gw * Math.ceil(h / cell));
      xs = [];
      ys = [];
      for (let i = 0; i < ex.length; i++) {
        const key = Math.floor(ey[i] / cell) * gw + Math.floor(ex[i] / cell);
        if (occupied[key]) continue;
        occupied[key] = 1;
        xs.push(ex[i]);
        ys.push(ey[i]);
      }
      if (xs.length <= target || cell >= 64) break;
      cell++;
    }
    return { xs, ys, cell, edgeCount: ex.length };
  }

  // 최근접 이웃 탐욕법으로 점들을 하나의 경로로 정렬한다.
  // gaps[n] = 1 이면 n → n+1 구간이 서로 다른 윤곽선 사이의 '점프'다.
  function orderPath(inXs, inYs, cell) {
    const n = inXs.length;
    const xs = Float64Array.from(inXs);
    const ys = Float64Array.from(inYs);

    let start = 0;
    for (let i = 1; i < n; i++) {
      if (xs[i] + ys[i] < xs[start] + ys[start]) start = i;
    }
    swap(xs, ys, 0, start);

    for (let i = 0; i < n - 1; i++) {
      const x = xs[i], y = ys[i];
      let best = i + 1, bestD = Infinity;
      for (let j = i + 1; j < n; j++) {
        const dx = xs[j] - x, dy = ys[j] - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      swap(xs, ys, i + 1, best);
    }

    const jump = 3 * cell + 1;
    const gaps = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      gaps[i] = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) > jump ? 1 : 0;
    }
    return { xs, ys, gaps };
  }

  function swap(xs, ys, a, b) {
    let t = xs[a]; xs[a] = xs[b]; xs[b] = t;
    t = ys[a]; ys[a] = ys[b]; ys[b] = t;
  }

  return { detect, samplePoints, orderPath };
})();
