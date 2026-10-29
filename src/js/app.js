(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const MAX_DIM = 360;          // 처리할 이미지의 최대 변 길이(px)
  const THUMB = 150;            // 프레임 썸네일 크기(CSS px)
  const THUMB_CIRCLES = 40;     // 썸네일에 그릴 원 개수
  const SHEET_MAX = 4096;       // 프레임 시트 PNG 최대 변 길이(px)
  const CONVERGE_TERMS = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

  const COLORS = {
    bg: '#0f1222',
    circle: 'rgba(255, 255, 255, 0.16)',
    radius: 'rgba(255, 255, 255, 0.45)',
    path: '#ffc93c',
    tip: '#ff5c7a',
    label: 'rgba(255, 255, 255, 0.75)',
  };

  const state = {
    source: null,     // 처리용으로 축소한 원본 캔버스
    path: null,       // { xs, ys, gaps, w, h, cx, cy } (cx, cy: 중심)
    coeffs: null,     // 진폭 내림차순으로 정렬된 푸리에 계수
    terms: 0,
    curve: null,      // 현재 항 개수로 복원한 곡선
    frameCount: 120,
    frame: 0,
    playing: true,
    learnJob: 0,
    galleryJob: 0,
    convergeJob: 0,
  };

  const ui = {
    file: $('file'),
    sample: $('sample'),
    threshold: $('threshold'),
    thresholdOut: $('thresholdOut'),
    points: $('points'),
    pointsOut: $('pointsOut'),
    srcCanvas: $('srcCanvas'),
    edgeCanvas: $('edgeCanvas'),
    pathCanvas: $('pathCanvas'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    stats: $('stats'),
    play: $('play'),
    frame: $('frame'),
    frameOut: $('frameOut'),
    fps: $('fps'),
    fpsOut: $('fpsOut'),
    terms: $('terms'),
    termsOut: $('termsOut'),
    frameCount: $('frameCount'),
    showCircles: $('showCircles'),
    hideJumps: $('hideJumps'),
    savePng: $('savePng'),
    mainCanvas: $('mainCanvas'),
    framesInfo: $('framesInfo'),
    saveSheet: $('saveSheet'),
    frameGrid: $('frameGrid'),
    convergeGrid: $('convergeGrid'),
  };

  // ---------- 1. 사진 → 경로 ----------

  function setSource(drawable, w, h) {
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // 투명 PNG는 흰 배경 위에 합성
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    state.source = canvas;

    ui.srcCanvas.width = canvas.width;
    ui.srcCanvas.height = canvas.height;
    ui.srcCanvas.getContext('2d').drawImage(canvas, 0, 0);
    extract();
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function makeSample() {
    const c = document.createElement('canvas');
    c.width = 360;
    c.height = 360;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 360, 360);
    g.fillStyle = '#000';
    g.beginPath();
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * 2 * Math.PI;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      if (i === 0) g.moveTo(180 + x * 5.5, 120 - y * 5.5);
      else g.lineTo(180 + x * 5.5, 120 - y * 5.5);
    }
    g.fill();
    g.font = 'bold 76px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Fourier', 180, 290);
    return c;
  }

  function extract() {
    if (!state.source) return;
    const { width: w, height: h } = state.source;
    const rgba = state.source.getContext('2d').getImageData(0, 0, w, h).data;
    const { edges } = Edge.detect(rgba, w, h, ui.threshold.value / 100);
    drawEdges(edges, w, h);

    const sampled = Edge.samplePoints(edges, w, h, Number(ui.points.value));
    if (sampled.xs.length < 3) {
      state.learnJob++;
      state.path = null;
      clearResults();
      setStats([['상태', '윤곽선이 거의 없습니다. 에지 임계값을 낮춰 보세요.']]);
      return;
    }
    const ordered = Edge.orderPath(sampled.xs, sampled.ys, sampled.cell);
    const N = ordered.xs.length;
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) { cx += ordered.xs[i]; cy += ordered.ys[i]; }
    cx /= N;
    cy /= N;
    state.path = { ...ordered, w, h, cx, cy, edgeCount: sampled.edgeCount };
    drawPathPreview();
    learn();
  }

  function drawEdges(edges, w, h) {
    ui.edgeCanvas.width = w;
    ui.edgeCanvas.height = h;
    const g = ui.edgeCanvas.getContext('2d');
    const img = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = edges[i] ? 0 : 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  // 점 순서를 색상(무지개)으로, 윤곽선 사이 점프를 점선으로 보여준다.
  function drawPathPreview() {
    const { xs, ys, gaps, w, h } = state.path;
    const N = xs.length;
    ui.pathCanvas.width = w;
    ui.pathCanvas.height = h;
    const g = ui.pathCanvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.lineWidth = 1.2;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      g.beginPath();
      g.moveTo(xs[i], ys[i]);
      g.lineTo(xs[j], ys[j]);
      if (gaps[i]) {
        g.setLineDash([3, 3]);
        g.strokeStyle = 'rgba(0, 0, 0, 0.15)';
      } else {
        g.setLineDash([]);
        g.strokeStyle = `hsl(${(i / N) * 300}, 85%, 45%)`;
      }
      g.stroke();
    }
    g.setLineDash([]);
  }

  // ---------- 2. 학습 ----------

  async function learn() {
    const job = ++state.learnJob;
    const { xs, ys, cx, cy, w, h, edgeCount } = state.path;
    const N = xs.length;
    const zx = new Float64Array(N);
    const zy = new Float64Array(N);
    for (let i = 0; i < N; i++) { zx[i] = xs[i] - cx; zy[i] = ys[i] - cy; }

    setProgress(0);
    const t0 = performance.now();
    const coeffs = await Fourier.dft(zx, zy, (p) => {
      if (job === state.learnJob) setProgress(p);
    }, () => job !== state.learnJob);
    if (!coeffs) return;
    const elapsed = performance.now() - t0;

    coeffs.sort((a, b) => b.amp - a.amp);
    state.coeffs = coeffs;
    setStats([
      ['이미지 크기', `${w} × ${h}px`],
      ['에지 픽셀', edgeCount.toLocaleString()],
      ['샘플 점 (N)', N.toLocaleString()],
      ['푸리에 계수', `${N.toLocaleString()}개 (주파수 ${-Math.floor((N - 1) / 2)} ~ ${Math.floor(N / 2)})`],
      ['학습 시간', `${elapsed.toFixed(0)} ms`],
      ['가장 큰 원', `반지름 ${coeffs[0].amp.toFixed(1)}px · 주파수 ${coeffs[0].freq}`],
    ]);

    ui.terms.max = N;
    ui.terms.value = N;
    setTerms(N);
    renderConvergence();
  }

  function setProgress(p) {
    ui.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
    ui.progressText.textContent = p < 1 ? `학습 중… ${(p * 100).toFixed(0)}%` : '학습 완료';
  }

  function setStats(rows) {
    ui.stats.innerHTML = '';
    for (const [k, v] of rows) {
      const item = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      item.append(dt, dd);
      ui.stats.append(item);
    }
  }

  function clearResults() {
    state.coeffs = null;
    state.curve = null;
    state.galleryJob++;
    state.convergeJob++;
    ui.frameGrid.innerHTML = '';
    ui.convergeGrid.innerHTML = '';
    setProgress(0);
    renderMain();
  }

  // ---------- 3. 그리기 ----------

  function setTerms(m) {
    if (!state.coeffs) return;
    state.terms = m;
    state.curve = Fourier.sampleCurve(state.coeffs.slice(0, m), state.coeffs.length);
    ui.termsOut.textContent = `${m.toLocaleString()} / ${state.coeffs.length.toLocaleString()}`;
    renderMain();
    scheduleGallery();
  }

  // 이미지 영역 전체가 size×size 정사각형 안에 들어오도록 하는 좌표 변환
  function makeView(size) {
    const { w, h, cx, cy } = state.path;
    const scale = (size * 0.92) / Math.max(w, h);
    return {
      scale,
      x: (x) => size / 2 + (x + cx - w / 2) * scale,
      y: (y) => size / 2 + (y + cy - h / 2) * scale,
    };
  }

  // t ∈ (0, 1]: 한 주기 중 진행 비율. t = 1 이면 완성된 그림.
  function drawScene(g, size, t, opts) {
    const curve = opts.curve || state.curve;
    const terms = opts.terms || state.terms;
    const { coeffs } = state;
    const { gaps } = state.path;
    const hideJumps = ui.hideJumps.checked;
    const v = makeView(size);
    const N = curve.xs.length;
    const count = Math.min(N, Math.floor(t * N));

    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, size, size);

    // 원(에피사이클) 사슬: 끝점이 지금 그리고 있는 위치
    let x = 0, y = 0;
    const done = t >= 1;
    if (!done && opts.circles) {
      g.lineWidth = 1;
      const circles = new Path2D();
      const radii = new Path2D();
      radii.moveTo(v.x(0), v.y(0));
      for (let i = 0; i < terms; i++) {
        const c = coeffs[i];
        const a = 2 * Math.PI * c.freq * t + c.phase;
        const nx = x + c.amp * Math.cos(a);
        const ny = y + c.amp * Math.sin(a);
        if (i < opts.maxCircles) {
          const r = c.amp * v.scale;
          if (c.freq !== 0 && r > 0.4) {
            circles.moveTo(v.x(x) + r, v.y(y));
            circles.arc(v.x(x), v.y(y), r, 0, 2 * Math.PI);
          }
          radii.lineTo(v.x(nx), v.y(ny));
        }
        x = nx;
        y = ny;
      }
      g.strokeStyle = COLORS.circle;
      g.stroke(circles);
      g.strokeStyle = COLORS.radius;
      g.stroke(radii);
    } else if (!done) {
      for (let i = 0; i < terms; i++) {
        const c = coeffs[i];
        const a = 2 * Math.PI * c.freq * t + c.phase;
        x += c.amp * Math.cos(a);
        y += c.amp * Math.sin(a);
      }
    }

    // 지금까지 그려진 궤적
    g.strokeStyle = COLORS.path;
    g.lineWidth = opts.lineWidth;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    let pen = false;
    for (let n = 0; n < count; n++) {
      const px = v.x(curve.xs[n]), py = v.y(curve.ys[n]);
      if (pen) g.lineTo(px, py);
      else { g.moveTo(px, py); pen = true; }
      if (hideJumps && gaps[n]) pen = false;
    }
    if (done) {
      if (!(hideJumps && gaps[N - 1])) g.lineTo(v.x(curve.xs[0]), v.y(curve.ys[0]));
    } else if (pen) {
      g.lineTo(v.x(x), v.y(y));
    }
    g.stroke();

    if (!done) {
      g.fillStyle = COLORS.tip;
      g.beginPath();
      g.arc(v.x(x), v.y(y), Math.max(2, opts.lineWidth * 1.8), 0, 2 * Math.PI);
      g.fill();
    }

    if (opts.label) {
      g.fillStyle = 'rgba(0, 0, 0, 0.45)';
      g.font = `${Math.round(size / 13)}px system-ui, sans-serif`;
      const tw = g.measureText(opts.label).width;
      const pad = size / 40;
      g.fillRect(0, 0, tw + pad * 2, size / 13 + pad * 2);
      g.fillStyle = COLORS.label;
      g.textBaseline = 'top';
      g.fillText(opts.label, pad, pad);
    }
  }

  const frameT = (f) => (f + 1) / state.frameCount;

  function setupCanvas(canvas, size) {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  function mainSize() {
    return Math.min(640, ui.mainCanvas.parentElement.clientWidth);
  }

  function renderMain() {
    const size = mainSize();
    const g = setupCanvas(ui.mainCanvas, size);
    if (!state.curve) {
      g.fillStyle = COLORS.bg;
      g.fillRect(0, 0, size, size);
      return;
    }
    drawScene(g, size, frameT(state.frame), {
      circles: ui.showCircles.checked,
      maxCircles: Infinity,
      lineWidth: 1.6,
    });
    ui.frame.value = state.frame;
    ui.frameOut.textContent = `${state.frame + 1} / ${state.frameCount}`;
    highlightThumb();
  }

  // ---------- 재생 ----------

  let lastTime = performance.now();
  let acc = 0;
  function tick(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    if (state.playing && state.curve) {
      acc = Math.min(acc + dt * Number(ui.fps.value), 5);
      if (acc >= 1) {
        const steps = Math.floor(acc);
        acc -= steps;
        state.frame = (state.frame + steps) % state.frameCount;
        renderMain();
      }
    }
    requestAnimationFrame(tick);
  }

  function seek(f) {
    state.frame = f;
    renderMain();
  }

  function setPlaying(p) {
    state.playing = p;
    ui.play.textContent = p ? '일시정지' : '재생';
  }

  // ---------- 4. 전체 프레임 ----------

  let galleryTimer = 0;
  function scheduleGallery() {
    clearTimeout(galleryTimer);
    galleryTimer = setTimeout(renderGallery, 150);
  }

  let thumbs = [];
  let highlighted = -1;

  function renderGallery() {
    const job = ++state.galleryJob;
    const F = state.frameCount;
    ui.frameGrid.innerHTML = '';
    thumbs = [];
    highlighted = -1;
    ui.framesInfo.textContent = `${F}개 프레임 · 항 ${state.terms.toLocaleString()}개`;
    if (!state.curve) return;

    const frag = document.createDocumentFragment();
    for (let f = 0; f < F; f++) {
      const cell = document.createElement('button');
      cell.className = 'thumb';
      cell.title = `프레임 ${f + 1}로 이동`;
      const canvas = document.createElement('canvas');
      const label = document.createElement('span');
      label.textContent = `#${f + 1}`;
      cell.append(canvas, label);
      cell.addEventListener('click', () => {
        setPlaying(false);
        seek(f);
        ui.mainCanvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      frag.append(cell);
      thumbs.push(canvas);
    }
    ui.frameGrid.append(frag);
    highlightThumb();

    let f = 0;
    const step = () => {
      if (job !== state.galleryJob) return;
      const t0 = performance.now();
      while (f < F && performance.now() - t0 < 12) {
        drawScene(setupCanvas(thumbs[f], THUMB), THUMB, frameT(f), {
          circles: ui.showCircles.checked,
          maxCircles: THUMB_CIRCLES,
          lineWidth: 1,
        });
        f++;
      }
      if (f < F) requestAnimationFrame(step);
    };
    step();
  }

  function highlightThumb() {
    if (highlighted === state.frame) return;
    if (thumbs[highlighted]) thumbs[highlighted].parentElement.classList.remove('current');
    highlighted = state.frame;
    if (thumbs[highlighted]) thumbs[highlighted].parentElement.classList.add('current');
  }

  // 모든 프레임을 한 장의 PNG로 저장
  function saveSheet() {
    if (!state.curve) return;
    const F = state.frameCount;
    const cols = Math.ceil(Math.sqrt(F));
    const rows = Math.ceil(F / cols);
    const cell = Math.min(240, Math.floor(SHEET_MAX / cols));
    const canvas = document.createElement('canvas');
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    for (let f = 0; f < F; f++) {
      g.save();
      g.translate((f % cols) * cell, Math.floor(f / cols) * cell);
      g.beginPath();
      g.rect(1, 1, cell - 2, cell - 2);
      g.clip();
      drawScene(g, cell, frameT(f), {
        circles: ui.showCircles.checked,
        maxCircles: THUMB_CIRCLES,
        lineWidth: 1,
        label: `#${f + 1}`,
      });
      g.restore();
    }
    download(canvas, `fourier-frames-${F}.png`);
  }

  function savePng() {
    if (!state.curve) return;
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    drawScene(canvas.getContext('2d'), size, frameT(state.frame), {
      circles: ui.showCircles.checked,
      maxCircles: Infinity,
      lineWidth: 2.4,
    });
    download(canvas, `fourier-frame-${state.frame + 1}.png`);
  }

  function download(canvas, name) {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  // ---------- 5. 항 개수에 따른 근사 ----------

  function renderConvergence() {
    const job = ++state.convergeJob;
    const N = state.coeffs.length;
    const list = CONVERGE_TERMS.filter((m) => m < N).concat(N);
    ui.convergeGrid.innerHTML = '';
    const items = list.map((m) => {
      const cell = document.createElement('figure');
      cell.className = 'thumb';
      const canvas = document.createElement('canvas');
      const label = document.createElement('span');
      label.textContent = m === N ? `전체 ${m.toLocaleString()}항` : `${m.toLocaleString()}항`;
      cell.append(canvas, label);
      ui.convergeGrid.append(cell);
      return { m, canvas };
    });

    let i = 0;
    const step = () => {
      if (job !== state.convergeJob || i >= items.length) return;
      const { m, canvas } = items[i++];
      const curve = Fourier.sampleCurve(state.coeffs.slice(0, m), N);
      drawScene(setupCanvas(canvas, THUMB), THUMB, 1, { curve, terms: m, lineWidth: 1 });
      requestAnimationFrame(step);
    };
    step();
  }

  // ---------- 이벤트 ----------

  function rerenderAll() {
    renderMain();
    scheduleGallery();
    if (state.coeffs) renderConvergence();
  }

  let extractTimer = 0;
  function scheduleExtract() {
    clearTimeout(extractTimer);
    extractTimer = setTimeout(extract, 250);
  }

  ui.file.addEventListener('change', () => loadFile(ui.file.files[0]));
  ui.sample.addEventListener('click', () => {
    const c = makeSample();
    setSource(c, c.width, c.height);
  });

  ui.threshold.addEventListener('input', () => {
    ui.thresholdOut.textContent = `${ui.threshold.value}%`;
    scheduleExtract();
  });
  ui.points.addEventListener('input', () => {
    ui.pointsOut.textContent = ui.points.value;
    scheduleExtract();
  });

  ui.play.addEventListener('click', () => setPlaying(!state.playing));
  ui.frame.addEventListener('input', () => {
    setPlaying(false);
    seek(Number(ui.frame.value));
  });
  ui.fps.addEventListener('input', () => {
    ui.fpsOut.textContent = `${ui.fps.value} fps`;
  });
  ui.terms.addEventListener('input', () => setTerms(Number(ui.terms.value)));
  ui.frameCount.addEventListener('change', () => {
    const F = Number(ui.frameCount.value);
    state.frame = Math.min(F - 1, Math.round(((state.frame + 1) / state.frameCount) * F) - 1);
    state.frame = Math.max(0, state.frame);
    state.frameCount = F;
    ui.frame.max = F - 1;
    renderMain();
    scheduleGallery();
  });
  ui.showCircles.addEventListener('change', () => { renderMain(); scheduleGallery(); });
  ui.hideJumps.addEventListener('change', rerenderAll);
  ui.savePng.addEventListener('click', savePng);
  ui.saveSheet.addEventListener('click', saveSheet);

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    loadFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', (e) => {
    const item = [...e.clipboardData.items].find((it) => it.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderMain, 100);
  });

  ui.frame.max = state.frameCount - 1;
  ui.fpsOut.textContent = `${ui.fps.value} fps`;
  const sample = makeSample();
  setSource(sample, sample.width, sample.height);
  requestAnimationFrame(tick);
})();
