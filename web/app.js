"use strict";

/*
 * PedrinhaTracker Web — V5
 *
 * Escopo desta versão:
 * - rastrear 3 copos e preservar suas identidades 1/2/3;
 * - manter as caixas estáveis e limitar saltos;
 * - recuperar copos após pequenas oclusões;
 * - fixar a marca PEDRINHA à identidade de um copo escolhido pelo usuário.
 *
 * Importante: a marca PEDRINHA representa o copo selecionado.
 * Esta versão NÃO tenta reconstruir a posição de uma pedrinha escondida.
 */

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const startButton = document.getElementById("start");
const calibrarButton = document.getElementById("calibrar");
const pedrinhaButton = document.getElementById("pedrinha");
const limparButton = document.getElementById("limpar");
const cameraBox = document.querySelector(".camera");

// Processamento pequeno o suficiente para iPhone 8, mas sem distorcer a imagem.
const MAX_PROCESS_PIXELS = 120000;
const PROCESS_MS = 50;

// Dimensões do template em proporção à imagem processada.
let W = 240;
let H = 430;
let TEMPLATE_W = 34;
let TEMPLATE_H = 62;
let SEARCH_RADIUS = 62;
let MAX_SEARCH_RADIUS = 104;
let MAX_JUMP = 54;

const SAMPLE_STEP = 3;
const MIN_PATCH_ERROR = 5.5;
const SMOOTH_VISIBLE = 0.58;
const SMOOTH_RECOVER = 0.78;
const VELOCITY_SMOOTH = 0.68;
const TEMPLATE_BLEND = 0.018;
const MAX_LOST = 18;
const MIN_TRACK_SEPARATION = 22;
const MAX_MARKER_DISTANCE = 90;

const sampleCanvas = document.createElement("canvas");
const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let cameraAtiva = false;
let modo = "parado";
let copos = [];
let alvoCopoId = null;
let rafId = 0;
let processando = false;
let lastProcessTime = 0;
let trackerReady = false;
let frameData = null;

function status(t) {
  statusEl.textContent = t;
}

function prepararVideo() {
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("autoplay", "");
  video.setAttribute("muted", "");
  video.setAttribute("disablepictureinpicture", "");
  video.setAttribute("disableremoteplayback", "");
}

function ajustarDimensoesProcessamento() {
  if (!video.videoWidth || !video.videoHeight) return;

  const pixels = video.videoWidth * video.videoHeight;
  const scale = Math.min(1, Math.sqrt(MAX_PROCESS_PIXELS / pixels));
  W = Math.max(160, Math.round(video.videoWidth * scale));
  H = Math.max(160, Math.round(video.videoHeight * scale));

  // Mantém o template proporcional ao quadro e suficientemente pequeno para Safari.
  TEMPLATE_H = clamp(Math.round(H * 0.072), 42, 72);
  TEMPLATE_W = clamp(Math.round(W * 0.142), 26, 48);

  // O raio de procura acompanha a resolução processada.
  const base = Math.round(Math.min(W, H) * 0.23);
  SEARCH_RADIUS = clamp(base, 46, 78);
  MAX_SEARCH_RADIUS = clamp(Math.round(SEARCH_RADIUS * 1.65), 78, 122);
  MAX_JUMP = clamp(Math.round(Math.min(W, H) * 0.22), 40, 64);

  if (sampleCanvas.width !== W || sampleCanvas.height !== H) {
    sampleCanvas.width = W;
    sampleCanvas.height = H;
  }

  // O quadro da interface passa a ter exatamente a mesma proporção do vídeo.
  // Isso elimina a distorção/corte que existia na V4.
  cameraBox.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
}

function ajustarCanvas() {
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

function capturarFrame() {
  if (!video.videoWidth || !video.videoHeight) return null;
  sampleCtx.drawImage(video, 0, 0, W, H);
  return sampleCtx.getImageData(0, 0, W, H);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function gray(data, x, y) {
  x = clamp(x | 0, 1, W - 2);
  y = clamp(y | 0, 1, H - 2);
  const i = (y * W + x) * 4;
  return data.data[i] * 0.299 + data.data[i + 1] * 0.587 + data.data[i + 2] * 0.114;
}

function templateAt(data, cx, cy) {
  const vals = [];
  const x0 = Math.round(cx - TEMPLATE_W / 2);
  const y0 = Math.round(cy - TEMPLATE_H / 2);
  let sum = 0;

  for (let y = 0; y < TEMPLATE_H; y += SAMPLE_STEP) {
    for (let x = 0; x < TEMPLATE_W; x += SAMPLE_STEP) {
      const v = gray(data, x0 + x, y0 + y);
      vals.push(v);
      sum += v;
    }
  }

  const mean = sum / vals.length;
  let ss = 0;
  for (const v of vals) {
    const q = v - mean;
    ss += q * q;
  }

  const sd = Math.sqrt(Math.max(9, ss / vals.length));
  return vals.map(v => (v - mean) / sd);
}

function patchScore(data, cx, cy, templ) {
  if (!templ) return Infinity;

  const vals = [];
  const x0 = Math.round(cx - TEMPLATE_W / 2);
  const y0 = Math.round(cy - TEMPLATE_H / 2);
  let sum = 0;

  for (let y = 0; y < TEMPLATE_H; y += SAMPLE_STEP) {
    for (let x = 0; x < TEMPLATE_W; x += SAMPLE_STEP) {
      const v = gray(data, x0 + x, y0 + y);
      vals.push(v);
      sum += v;
    }
  }

  const mean = sum / vals.length;
  let ss = 0;
  for (const v of vals) {
    const q = v - mean;
    ss += q * q;
  }

  const sd = Math.sqrt(Math.max(9, ss / vals.length));
  let e = 0;
  for (let i = 0; i < vals.length; i++) {
    const z = (vals[i] - mean) / sd - templ[i];
    e += z * z;
  }
  return e / vals.length;
}

function gradientSignature(data, cx, cy) {
  const sig = [];
  const hx = Math.max(8, Math.round(TEMPLATE_W * 0.34));
  const hy = Math.max(12, Math.round(TEMPLATE_H * 0.34));
  const step = Math.max(4, Math.round(Math.min(TEMPLATE_W, TEMPLATE_H) / 7));

  for (let y = -hy; y <= hy; y += step) {
    for (let x = -hx; x <= hx; x += step) {
      const gx = gray(data, cx + x + 1, cy + y) - gray(data, cx + x - 1, cy + y);
      const gy = gray(data, cx + x, cy + y + 1) - gray(data, cx + x, cy + y - 1);
      sig.push(Math.min(30, Math.hypot(gx, gy)));
    }
  }
  return sig;
}

function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function predicted(c) {
  return {
    x: clamp(c.x + c.vx, TEMPLATE_W / 2 + 2, W - TEMPLATE_W / 2 - 2),
    y: clamp(c.y + c.vy, TEMPLATE_H / 2 + 2, H - TEMPLATE_H / 2 - 2)
  };
}

function findBest(c, data) {
  const p = predicted(c);
  const radius = Math.min(MAX_SEARCH_RADIUS, SEARCH_RADIUS + c.lost * 3);
  const stride = c.lost > 5 ? 3 : 4;
  let best = null;

  for (
    let y = Math.max(TEMPLATE_H / 2 + 2, Math.round(p.y - radius));
    y <= Math.min(H - TEMPLATE_H / 2 - 2, Math.round(p.y + radius));
    y += stride
  ) {
    for (
      let x = Math.max(TEMPLATE_W / 2 + 2, Math.round(p.x - radius));
      x <= Math.min(W - TEMPLATE_W / 2 - 2, Math.round(p.x + radius));
      x += stride
    ) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy > radius * radius) continue;

      const patch = patchScore(data, x, y, c.template);
      if (patch > MIN_PATCH_ERROR * 2.25) continue;

      const sig = gradientSignature(data, x, y);
      const sigDist = signatureDistance(c.signature, sig);
      const predDist = Math.hypot(x - p.x, y - p.y);
      const jump = Math.hypot(x - c.x, y - c.y);

      const score = patch + sigDist * 0.13 + predDist * 0.04 + jump * 0.014;
      if (!best || score < best.score) {
        best = { x, y, score, sig, patch, sigDist };
      }
    }
  }

  return best;
}

function makeTrack(c, data) {
  c.template = templateAt(data, c.x, c.y);
  c.signature = gradientSignature(data, c.x, c.y);
  c.initialTemplate = c.template.slice();
  c.vx = 0;
  c.vy = 0;
  c.lost = 0;
  c.conf = 1;
}

function initTracker(data) {
  for (const c of copos) makeTrack(c, data);
  trackerReady = true;
}

function resolveCollisions(results) {
  // Se dois rastros terminarem praticamente no mesmo ponto, só o mais confiável
  // fica com a detecção. O outro entra em predição; isso evita duas caixas grudadas.
  for (let i = 0; i < copos.length; i++) {
    if (!results[i]) continue;
    for (let j = i + 1; j < copos.length; j++) {
      if (!results[j]) continue;
      const d = Math.hypot(results[i].x - results[j].x, results[i].y - results[j].y);
      if (d >= MIN_TRACK_SEPARATION) continue;

      if (results[i].score <= results[j].score) results[j] = null;
      else results[i] = null;
    }
  }
}

function atualizar(data) {
  if (!trackerReady) {
    initTracker(data);
    return;
  }

  const results = copos.map(c => findBest(c, data));
  resolveCollisions(results);

  for (let i = 0; i < copos.length; i++) {
    const c = copos[i];
    const q = results[i];

    if (!q) {
      c.lost++;
      c.conf = Math.max(0, c.conf - 0.055);
      c.x = clamp(c.x + c.vx, TEMPLATE_W / 2 + 2, W - TEMPLATE_W / 2 - 2);
      c.y = clamp(c.y + c.vy, TEMPLATE_H / 2 + 2, H - TEMPLATE_H / 2 - 2);
      c.vx *= 0.92;
      c.vy *= 0.92;
      continue;
    }

    const jump = Math.hypot(q.x - c.x, q.y - c.y);
    const allowedJump = MAX_JUMP + Math.min(c.lost, 6) * 7;
    if (jump > allowedJump) {
      c.lost++;
      c.conf = Math.max(0, c.conf - 0.12);
      c.x = clamp(c.x + c.vx, TEMPLATE_W / 2 + 2, W - TEMPLATE_W / 2 - 2);
      c.y = clamp(c.y + c.vy, TEMPLATE_H / 2 + 2, H - TEMPLATE_H / 2 - 2);
      c.vx *= 0.88;
      c.vy *= 0.88;
      continue;
    }

    const a = c.lost ? SMOOTH_RECOVER : SMOOTH_VISIBLE;
    const nx = c.x * (1 - a) + q.x * a;
    const ny = c.y * (1 - a) + q.y * a;
    const dx = nx - c.x;
    const dy = ny - c.y;

    c.vx = c.vx * (1 - VELOCITY_SMOOTH) + dx * VELOCITY_SMOOTH;
    c.vy = c.vy * (1 - VELOCITY_SMOOTH) + dy * VELOCITY_SMOOTH;
    c.x = nx;
    c.y = ny;
    c.lost = 0;
    c.conf = Math.min(1, c.conf + 0.09);

    // Adaptação lenta: o template muda muito pouco e nunca perde a referência inicial.
    const fresh = templateAt(data, c.x, c.y);
    for (let k = 0; k < c.template.length; k++) {
      c.template[k] = c.template[k] * (1 - TEMPLATE_BLEND) + fresh[k] * TEMPLATE_BLEND;
    }

    const fs = gradientSignature(data, c.x, c.y);
    if (signatureDistance(c.signature, fs) < 18) {
      c.signature = c.signature.map((v, k) => v * 0.99 + fs[k] * 0.01);
    }
  }

  if (alvoCopoId !== null && !copos.some(c => c.id === alvoCopoId)) {
    alvoCopoId = null;
  }
}

function desenhar() {
  if (!cameraAtiva) return;
  ajustarCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sx = canvas.width / W;
  const sy = canvas.height / H;
  const lw = Math.max(3, canvas.width / 250);

  for (const c of copos) {
    const x = c.x * sx;
    const y = c.y * sy;
    const w = TEMPLATE_W * 1.85 * sx;
    const h = TEMPLATE_H * 1.70 * sy;

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = lw;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);

    ctx.fillStyle = "#fff";
    ctx.font = `900 ${Math.max(24, canvas.width / 30)}px Arial`;
    ctx.fillText(String(c.id), x - 10, y - h / 2 - 8);

    if (c.id === alvoCopoId) {
      // A marca está vinculada à identidade do copo, não a uma nova detecção.
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(5, canvas.width / 180);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(20, Math.min(canvas.width, canvas.height) / 13), 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = `900 ${Math.max(14, canvas.width / 52)}px Arial`;
      ctx.fillText("PEDRINHA", x - Math.max(46, canvas.width / 24), y - Math.max(26, canvas.height / 32));
    }

    const barW = Math.max(38, canvas.width / 9);
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillRect(x - barW / 2, y + h / 2 + 8, barW, 4);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - barW / 2, y + h / 2 + 8, barW * c.conf, 4);
  }
}

function loop(now) {
  if (cameraAtiva && !processando && now - lastProcessTime >= PROCESS_MS && copos.length === 3) {
    processando = true;
    lastProcessTime = now;
    frameData = capturarFrame();
    if (frameData) atualizar(frameData);
    processando = false;
  }

  desenhar();
  rafId = requestAnimationFrame(loop);
}

async function iniciarCamera() {
  status("Solicitando acesso à câmera...");
  prepararVideo();

  if (!navigator.mediaDevices?.getUserMedia) {
    status("Este Safari não disponibiliza a câmera para esta página.");
    return;
  }

  if (stream) stream.getTracks().forEach(t => t.stop());

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
  } catch (e1) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e2) {
      status(e2.name === "NotAllowedError" ? "A câmera foi bloqueada. Permita a câmera para este site." : "Não consegui acessar a câmera.");
      return;
    }
  }

  video.srcObject = stream;
  prepararVideo();

  await new Promise(resolve => {
    if (video.readyState >= 1) resolve();
    else video.onloadedmetadata = resolve;
  });

  ajustarDimensoesProcessamento();
  ajustarCanvas();

  try {
    await video.play();
  } catch (e) {
    // O botão já foi acionado pelo usuário; alguns Safari ainda exigem nova tentativa.
  }

  cameraAtiva = true;
  trackerReady = false;
  status("🔥 CÂMERA ATIVA! Calibre os 3 copos.");

  if (!rafId) rafId = requestAnimationFrame(loop);
}

startButton.addEventListener("click", iniciarCamera);

calibrarButton.addEventListener("click", () => {
  if (!cameraAtiva) return status("Primeiro toque em ABRIR CÂMERA.");

  copos = [];
  alvoCopoId = null;
  trackerReady = false;
  modo = "copos";
  status("Toque no centro do COPO 1.");
});

pedrinhaButton.addEventListener("click", () => {
  if (!cameraAtiva) return status("Primeiro abra a câmera.");
  if (copos.length !== 3) return status("Primeiro calibre os 3 copos.");

  modo = "alvo";
  status("Toque no COPO que deve ficar com a marca PEDRINHA. Ela ficará presa à identidade dele.");
});

limparButton.addEventListener("click", () => {
  copos = [];
  alvoCopoId = null;
  modo = "parado";
  trackerReady = false;
  status("Marcações limpas.");
});

canvas.addEventListener("pointerdown", e => {
  if (!cameraAtiva || !video.videoWidth) return;

  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * W / r.width;
  const y = (e.clientY - r.top) * H / r.height;

  if (modo === "copos") {
    const id = copos.length + 1;
    copos.push({
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      lost: 0,
      conf: 1,
      template: null,
      initialTemplate: null,
      signature: null
    });

    status(
      copos.length === 3
        ? "🔥 Copos 1, 2 e 3 calibrados. Agora escolha o copo da pedrinha."
        : `Copo ${id} marcado. Agora toque no copo ${id + 1}.`
    );

    if (copos.length === 3) modo = "parado";
  } else if (modo === "alvo") {
    let best = null;
    let bestD = Infinity;

    for (const c of copos) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }

    if (!best || bestD > MAX_MARKER_DISTANCE) {
      status("Toque dentro de um dos 3 copos para fixar a PEDRINHA nele.");
      return;
    }

    alvoCopoId = best.id;
    modo = "parado";
    status(`🔥 PEDRINHA FIXADA NO COPO ${best.id}. A marca acompanha somente esse copo.`);
  }
}, { passive: true });

window.addEventListener("resize", ajustarCanvas);
prepararVideo();
status("Pronto. Toque em ABRIR CÂMERA.");
      
