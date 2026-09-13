"use strict";

/* PedrinhaTracker Web — V6
 * Rastreamento por pontos + aparência + movimento, com associação conjunta dos 3 copos.
 * A PEDRINHA permanece vinculada ao ID do copo escolhido; não reconstrói posição oculta.
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

const MAX_PROCESS_PIXELS = 120000;
const PROCESS_MS = 50;
const SAMPLE_STEP = 4;
const FEATURE_STEP = 6;
const POINT_RADIUS = 3;
const POINT_SEARCH = 18;
const MIN_POINT_SCORE = 0.72;
const MAX_LOST = 22;
const MIN_TRACK_SEPARATION = 24;
const MAX_MARKER_DISTANCE = 100;
const MAX_CANDIDATES = 5;

let W = 240, H = 430;
let ROI_W = 38, ROI_H = 76;
let SEARCH_RADIUS = 58;
let MAX_JUMP = 58;

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

function status(t) { statusEl.textContent = t; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
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

  ROI_H = clamp(Math.round(H * 0.18), 54, 92);
  ROI_W = clamp(Math.round(W * 0.16), 30, 54);
  SEARCH_RADIUS = clamp(Math.round(Math.min(W, H) * 0.20), 44, 78);
  MAX_JUMP = clamp(Math.round(Math.min(W, H) * 0.20), 42, 64);

  sampleCanvas.width = W;
  sampleCanvas.height = H;
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

function gray(frame, x, y) {
  x = clamp(Math.round(x), 0, W - 1);
  y = clamp(Math.round(y), 0, H - 1);
  const i = (y * W + x) * 4;
  const d = frame.data;
  return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
}

function patchVector(frame, cx, cy, radius = POINT_RADIUS) {
  const out = [];
  let sum = 0;
  let n = 0;
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const v = gray(frame, cx + x, cy + y);
      out.push(v); sum += v; n++;
    }
  }
  const mean = sum / n;
  let ss = 0;
  for (const v of out) { const q = v - mean; ss += q * q; }
  const sd = Math.sqrt(Math.max(16, ss / n));
  return out.map(v => (v - mean) / sd);
}

function patchDistance(frame, cx, cy, templ, radius = POINT_RADIUS) {
  if (!templ) return 999;
  const p = patchVector(frame, cx, cy, radius);
  let e = 0;
  for (let i = 0; i < p.length; i++) {
    const d = p[i] - templ[i];
    e += d * d;
  }
  return e / p.length;
}

function localTexture(frame, x, y) {
  let s = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      s += Math.abs(gray(frame, x + dx + 1, y + dy) - gray(frame, x + dx - 1, y + dy));
      s += Math.abs(gray(frame, x + dx, y + dy + 1) - gray(frame, x + dx, y + dy - 1));
    }
  }
  return s;
}

function makeFeatures(frame, cx, cy) {
  const pts = [];
  const x0 = Math.round(cx - ROI_W * 0.43);
  const x1 = Math.round(cx + ROI_W * 0.43);
  const y0 = Math.round(cy - ROI_H * 0.43);
  const y1 = Math.round(cy + ROI_H * 0.43);
  const candidates = [];

  for (let y = y0; y <= y1; y += FEATURE_STEP) {
    for (let x = x0; x <= x1; x += FEATURE_STEP) {
      if (x < POINT_RADIUS + 1 || y < POINT_RADIUS + 1 || x >= W - POINT_RADIUS - 1 || y >= H - POINT_RADIUS - 1) continue;
      candidates.push({ x, y, texture: localTexture(frame, x, y) });
    }
  }

  candidates.sort((a, b) => b.texture - a.texture);
  for (const p of candidates) {
    let tooClose = false;
    for (const q of pts) if (Math.hypot(p.x - q.x, p.y - q.y) < FEATURE_STEP * 1.7) { tooClose = true; break; }
    if (!tooClose) {
      pts.push({ x: p.x, y: p.y, ref: patchVector(frame, p.x, p.y), weight: 1 });
      if (pts.length >= 16) break;
    }
  }
  return pts;
}

function trackFeature(frame, p, predictedX, predictedY) {
  let best = null;
  const baseX = p.x + (predictedX - p.cx);
  const baseY = p.y + (predictedY - p.cy);
  for (let dy = -POINT_SEARCH; dy <= POINT_SEARCH; dy += 2) {
    for (let dx = -POINT_SEARCH; dx <= POINT_SEARCH; dx += 2) {
      const x = Math.round(baseX + dx), y = Math.round(baseY + dy);
      if (x < POINT_RADIUS + 1 || y < POINT_RADIUS + 1 || x >= W - POINT_RADIUS - 1 || y >= H - POINT_RADIUS - 1) continue;
      const d = patchDistance(frame, x, y, p.ref);
      if (!best || d < best.score) best = { x, y, score: d };
    }
  }
  return best;
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function estimateMotion(frame, c) {
  if (!c.features?.length) return { x: c.x + c.vx, y: c.y + c.vy, quality: 0 };
  const predictedX = clamp(c.x + c.vx, ROI_W / 2 + 2, W - ROI_W / 2 - 2);
  const predictedY = clamp(c.y + c.vy, ROI_H / 2 + 2, H - ROI_H / 2 - 2);
  const moves = [];

  for (const p of c.features) {
    p.cx = c.x; p.cy = c.y;
    const q = trackFeature(frame, p, predictedX, predictedY);
    if (!q || q.score > MIN_POINT_SCORE) continue;
    moves.push({ dx: q.x - p.x, dy: q.y - p.y, score: q.score, x: q.x, y: q.y });
  }

  if (moves.length < 4) return { x: predictedX, y: predictedY, quality: moves.length / Math.max(1, c.features.length), moves: [] };

  const dxs = moves.map(m => m.dx), dys = moves.map(m => m.dy);
  const mdx = median(dxs), mdy = median(dys);
  const inliers = moves.filter(m => Math.hypot(m.dx - mdx, m.dy - mdy) <= 7);
  const dx = median(inliers.map(m => m.dx));
  const dy = median(inliers.map(m => m.dy));
  return {
    x: clamp(c.x + dx, ROI_W / 2 + 2, W - ROI_W / 2 - 2),
    y: clamp(c.y + dy, ROI_H / 2 + 2, H - ROI_H / 2 - 2),
    quality: inliers.length / Math.max(1, c.features.length),
    moves: inliers
  };
}

function roiScore(frame, cx, cy, templ) {
  if (!templ) return 999;
  let sum = 0, sum2 = 0, n = 0;
  const vals = [];
  for (let y = -Math.round(ROI_H * .42); y <= Math.round(ROI_H * .42); y += SAMPLE_STEP) {
    for (let x = -Math.round(ROI_W * .42); x <= Math.round(ROI_W * .42); x += SAMPLE_STEP) {
      const v = gray(frame, cx + x, cy + y);
      vals.push(v); sum += v; sum2 += v * v; n++;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(16, sum2 / n - mean * mean));
  let e = 0;
  for (let i = 0; i < vals.length; i++) {
    const z = (vals[i] - mean) / sd;
    const d = z - templ[i];
    e += d * d;
  }
  return e / n;
}

function roiTemplate(frame, cx, cy) {
  const vals = [];
  let sum = 0;
  for (let y = -Math.round(ROI_H * .42); y <= Math.round(ROI_H * .42); y += SAMPLE_STEP) {
    for (let x = -Math.round(ROI_W * .42); x <= Math.round(ROI_W * .42); x += SAMPLE_STEP) {
      const v = gray(frame, cx + x, cy + y); vals.push(v); sum += v;
    }
  }
  const mean = sum / vals.length;
  let ss = 0;
  for (const v of vals) ss += (v - mean) * (v - mean);
  const sd = Math.sqrt(Math.max(16, ss / vals.length));
  return vals.map(v => (v - mean) / sd);
}

function candidatePositions(frame, c, motion) {
  const px = motion.x, py = motion.y;
  const radius = clamp(SEARCH_RADIUS + c.lost * 2, 44, 88);
  const list = [];
  const step = 5;
  for (let y = Math.round(py - radius); y <= Math.round(py + radius); y += step) {
    for (let x = Math.round(px - radius); x <= Math.round(px + radius); x += step) {
      if (x < ROI_W / 2 + 2 || y < ROI_H / 2 + 2 || x > W - ROI_W / 2 - 2 || y > H - ROI_H / 2 - 2) continue;
      const d = Math.hypot(x - px, y - py);
      if (d > radius) continue;
      const rs = roiScore(frame, x, y, c.roiTemplate);
      if (rs > 5.8) continue;
      const move = Math.hypot(x - c.x, y - c.y);
      if (move > MAX_JUMP + c.lost * 5) continue;
      const score = rs + d * 0.022 + move * 0.010 - motion.quality * 0.65;
      list.push({ x, y, score, rs });
    }
  }
  list.sort((a, b) => a.score - b.score);
  const out = [];
  for (const q of list) {
    if (out.every(p => Math.hypot(p.x - q.x, p.y - q.y) >= 9)) out.push(q);
    if (out.length >= MAX_CANDIDATES) break;
  }
  if (!out.length) out.push({ x: px, y: py, score: 9 + (1 - motion.quality) * 2, rs: 9 });
  return out;
}

function assignment(candidates) {
  const perms = [
    [0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]
  ];
  let best = null;
  for (const p of perms) {
    const a = candidates[0][p[0]], b = candidates[1][p[1]], c = candidates[2][p[2]];
    if (!a || !b || !c) continue;
    const d1 = Math.hypot(a.x-b.x,a.y-b.y);
    const d2 = Math.hypot(a.x-c.x,a.y-c.y);
    const d3 = Math.hypot(b.x-c.x,b.y-c.y);
    if (Math.min(d1,d2,d3) < MIN_TRACK_SEPARATION) continue;
    const score = a.score + b.score + c.score;
    if (!best || score < best.score) best = { score, results:[a,b,c] };
  }
  return best;
}

function initTrack(c, frame) {
  c.roiTemplate = roiTemplate(frame, c.x, c.y);
  c.features = makeFeatures(frame, c.x, c.y);
  c.vx = 0; c.vy = 0; c.lost = 0; c.conf = 1;
}

function initTracker(frame) {
  copos.forEach(c => initTrack(c, frame));
  trackerReady = true;
}

function atualizar(frame) {
  if (!trackerReady) { initTracker(frame); return; }

  const motions = copos.map(c => estimateMotion(frame, c));
  const candidates = copos.map((c, i) => candidatePositions(frame, c, motions[i]));
  const chosen = assignment(candidates);

  for (let i = 0; i < copos.length; i++) {
    const c = copos[i];
    const m = motions[i];
    const q = chosen?.results[i] || null;

    if (!q) {
      c.lost++;
      c.conf = Math.max(0, c.conf - 0.055);
      c.x = m.x; c.y = m.y;
      c.vx *= 0.88; c.vy *= 0.88;
      continue;
    }

    const jump = Math.hypot(q.x - c.x, q.y - c.y);
    const allowed = MAX_JUMP + Math.min(c.lost, 6) * 6;
    if (jump > allowed) {
      c.lost++;
      c.conf = Math.max(0, c.conf - 0.10);
      c.x = m.x; c.y = m.y;
      c.vx *= 0.88; c.vy *= 0.88;
      continue;
    }

    const alpha = c.lost ? 0.72 : 0.58;
    const nx = c.x * (1-alpha) + q.x * alpha;
    const ny = c.y * (1-alpha) + q.y * alpha;
    const dx = nx - c.x, dy = ny - c.y;
    c.vx = c.vx * 0.35 + dx * 0.65;
    c.vy = c.vy * 0.35 + dy * 0.65;
    c.x = nx; c.y = ny;
    c.lost = 0;
    c.conf = Math.min(1, c.conf + 0.08 * Math.max(.35, m.quality));

    // Atualiza pontos somente com os inliers, mantendo a referência espacial do copo.
    if (m.moves?.length >= 4) {
      for (const mv of m.moves) {
        const nearest = c.features.reduce((best, p) => {
          const d = Math.hypot((p.x + (c.x - m.x)) - mv.x, (p.y + (c.y - m.y)) - mv.y);
          return !best || d < best.d ? { p, d } : best;
        }, null);
        if (nearest && nearest.d < 12) {
          nearest.p.x = mv.x;
          nearest.p.y = mv.y;
        }
      }
    }

    // Reamostra poucos pontos periodicamente para recuperar textura perdida.
    if (c.lost === 0 && (Math.floor(performance.now() / 500) % 4 === c.id % 4)) {
      c.features = makeFeatures(frame, c.x, c.y);
    }

    // Adaptação muito lenta da aparência, evitando drift.
    const fresh = roiTemplate(frame, c.x, c.y);
    for (let k = 0; k < c.roiTemplate.length; k++) {
      c.roiTemplate[k] = c.roiTemplate[k] * 0.992 + fresh[k] * 0.008;
    }
  }
}

function desenhar() {
  if (!cameraAtiva) return;
  ajustarCanvas();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const sx = canvas.width / W, sy = canvas.height / H;
  const lw = Math.max(3, canvas.width / 250);

  for (const c of copos) {
    const x = c.x*sx, y = c.y*sy;
    const w = ROI_W*1.35*sx, h = ROI_H*1.35*sy;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = lw;
    ctx.strokeRect(x-w/2,y-h/2,w,h);
    ctx.fillStyle = "#fff";
    ctx.font = `900 ${Math.max(24,canvas.width/30)}px Arial`;
    ctx.fillText(String(c.id),x-10,y-h/2-8);

    if (c.id === alvoCopoId) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(5,canvas.width/180);
      ctx.beginPath(); ctx.arc(x,y,Math.max(20,Math.min(canvas.width,canvas.height)/13),0,Math.PI*2); ctx.stroke();
      ctx.fillStyle="#fff";
      ctx.font=`900 ${Math.max(14,canvas.width/52)}px Arial`;
      ctx.fillText("PEDRINHA",x-Math.max(46,canvas.width/24),y-Math.max(26,canvas.height/32));
    }

    const barW=Math.max(38,canvas.width/9);
    ctx.fillStyle="rgba(255,255,255,.35)"; ctx.fillRect(x-barW/2,y+h/2+8,barW,4);
    ctx.fillStyle="#fff"; ctx.fillRect(x-barW/2,y+h/2+8,barW*c.conf,4);
  }
}

function loop(now) {
  if (cameraAtiva && !processando && now-lastProcessTime>=PROCESS_MS && copos.length===3) {
    processando=true; lastProcessTime=now;
    const frame=capturarFrame(); if(frame) atualizar(frame);
    processando=false;
  }
  desenhar();
  rafId=requestAnimationFrame(loop);
}

async function iniciarCamera() {
  status("Solicitando acesso à câmera..."); prepararVideo();
  if(!navigator.mediaDevices?.getUserMedia){ status("Este Safari não disponibiliza a câmera para esta página."); return; }
  if(stream) stream.getTracks().forEach(t=>t.stop());
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}}});
  } catch(e1) {
    try { stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false}); }
    catch(e2){ status(e2.name==="NotAllowedError"?"A câmera foi bloqueada. Permita a câmera para este site.":"Não consegui acessar a câmera."); return; }
  }
  video.srcObject=stream; prepararVideo();
  await new Promise(resolve=>{ if(video.readyState>=1) resolve(); else video.onloadedmetadata=resolve; });
  ajustarDimensoesProcessamento(); ajustarCanvas();
  try{await video.play();}catch(e){}
  cameraAtiva=true; trackerReady=false;
  status("🔥 CÂMERA ATIVA! Calibre os 3 copos.");
  if(!rafId) rafId=requestAnimationFrame(loop);
}

startButton.addEventListener("click",iniciarCamera);
calibrarButton.addEventListener("click",()=>{
  if(!cameraAtiva)return status("Primeiro toque em ABRIR CÂMERA.");
  copos=[]; alvoCopoId=null; trackerReady=false; modo="copos";
  status("Toque no centro do COPO 1.");
});
pedrinhaButton.addEventListener("click",()=>{
  if(!cameraAtiva)return status("Primeiro abra a câmera.");
  if(copos.length!==3)return status("Primeiro calibre os 3 copos.");
  modo="alvo"; status("Toque no COPO que deve ficar com a marca PEDRINHA. Ela ficará presa à identidade dele.");
});
limparButton.addEventListener("click",()=>{
  copos=[]; alvoCopoId=null; modo="parado"; trackerReady=false; status("Marcações limpas.");
});

canvas.addEventListener("pointerdown",e=>{
  if(!cameraAtiva||!video.videoWidth)return;
  const r=canvas.getBoundingClientRect();
  const x=(e.clientX-r.left)*W/r.width, y=(e.clientY-r.top)*H/r.height;
  if(modo==="copos"){
    const id=copos.length+1;
    copos.push({id,x,y,vx:0,vy:0,lost:0,conf:1,roiTemplate:null,features:[]});
    status(copos.length===3?"🔥 Copos 1, 2 e 3 calibrados. Agora escolha o copo da pedrinha.":`Copo ${id} marcado. Agora toque no copo ${id+1}.`);
    if(copos.length===3)modo="parado";
  }else if(modo==="alvo"){
    let best=null,bestD=Infinity;
    for(const c of copos){const d=Math.hypot(c.x-x,c.y-y);if(d<bestD){bestD=d;best=c;}}
    if(!best||bestD>MAX_MARKER_DISTANCE)return status("Toque dentro de um dos 3 copos para fixar a PEDRINHA nele.");
    alvoCopoId=best.id; modo="parado";
    status(`🔥 PEDRINHA FIXADA NO COPO ${best.id}. A marca acompanha somente esse copo.`);
  }
},{passive:true});

window.addEventListener("resize",ajustarCanvas);
prepararVideo(); status("Pronto. Toque em ABRIR CÂMERA.");
  
