// 복소 푸리에 급수: z(t) = Σ c_k · e^{i·2π·k·t},  t ∈ [0, 1)
const Fourier = (() => {
  'use strict';

  // 점 z_n = x_n + i·y_n 에 대한 이산 푸리에 변환.
  //   c_k = (1/N) Σ z_n · e^{-i·2π·k·n/N}
  // UI가 멈추지 않도록 잘게 나눠 계산하고, 진행률을 onProgress(0~1)로 알린다.
  // isCancelled()가 true를 돌려주면 null로 끝낸다.
  function dft(xs, ys, onProgress, isCancelled) {
    const N = xs.length;
    const cosT = new Float64Array(N);
    const sinT = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      cosT[i] = Math.cos(a);
      sinT[i] = Math.sin(a);
    }

    const coeffs = new Array(N);
    let k = 0;
    return new Promise((resolve) => {
      function step() {
        if (isCancelled()) return resolve(null);
        const t0 = performance.now();
        while (k < N && performance.now() - t0 < 16) {
          let re = 0, im = 0, idx = 0;
          for (let n = 0; n < N; n++) {
            // (x + iy)(cos θ − i sin θ),  θ = 2π·(k·n mod N)/N
            const c = cosT[idx], s = sinT[idx];
            re += xs[n] * c + ys[n] * s;
            im += ys[n] * c - xs[n] * s;
            idx += k;
            if (idx >= N) idx -= N;
          }
          re /= N;
          im /= N;
          coeffs[k] = {
            freq: k <= N / 2 ? k : k - N,
            re,
            im,
            amp: Math.hypot(re, im),
            phase: Math.atan2(im, re),
          };
          k++;
        }
        onProgress(k / N);
        if (k < N) setTimeout(step, 0);
        else resolve(coeffs);
      }
      step();
    });
  }

  // 주어진 항들로 t = n/N (n = 0..N-1) 에서의 급수 값을 계산한다.
  // 항마다 e^{i·2π·k/N} 를 곱해 가며 회전시키므로 삼각함수 호출이 필요 없다.
  function sampleCurve(terms, N) {
    const xs = new Float64Array(N);
    const ys = new Float64Array(N);
    for (const c of terms) {
      const step = (2 * Math.PI * c.freq) / N;
      const sr = Math.cos(step), si = Math.sin(step);
      let zr = c.re, zi = c.im;
      for (let n = 0; n < N; n++) {
        xs[n] += zr;
        ys[n] += zi;
        const t = zr * sr - zi * si;
        zi = zr * si + zi * sr;
        zr = t;
      }
    }
    return { xs, ys };
  }

  return { dft, sampleCurve };
})();
