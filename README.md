**푸리에급수 이미지 프레임 구현**
인스타에서 본거

사진의 윤곽선을 딴 후 회전하는 원으로 그려나가는 과정을 보여주는 웹 사이트입니다.

## 파일

- `src/index.html`, `src/style.css` — 화면
- `src/js/edge.js` — 에지 검출, 점 샘플링, 경로 정렬
- `src/js/fourier.js` — DFT(학습)와 급수 복원
- `src/js/app.js` — 재생, 프레임 갤러리, 저장