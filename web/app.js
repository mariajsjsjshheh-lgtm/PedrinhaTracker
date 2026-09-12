"use strict";

const video=document.getElementById("video");
const canvas=document.getElementById("canvas");
const ctx=canvas.getContext("2d");
const statusEl=document.getElementById("status");
const startButton=document.getElementById("start");
const calibrarButton=document.getElementById("calibrar");
const pedrinhaButton=document.getElementById("pedrinha");
const limparButton=document.getElementById("limpar");

let stream=null,cameraAtiva=false,modo="parado",copos=[],alvo=null,rafId=0,processando=false,lastProcessTime=0,trackerReady=false;

const W=320,H=240,PROCESS_MS=60,RADIUS=58,STRIDE=4,PW=34,PH=50,STEP=2,SMOOTH=.72,LOST_LIMIT=8;
const tc=document.createElement("canvas"); tc.width=W;tc.height=H;
const tx=tc.getContext("2d",{willReadFrequently:true});

function status(t){statusEl.textContent=t}
function prepararVideo(){video.muted=true;video.autoplay=true;video.playsInline=true;video.setAttribute("playsinline","");video.setAttribute("webkit-playsinline","");video.setAttribute("autoplay","");video.setAttribute("muted","");video.setAttribute("disablepictureinpicture","");video.setAttribute("disableremoteplayback","")}
function ajustarCanvas(){if(video.videoWidth){canvas.width=video.videoWidth;canvas.height=video.videoHeight}}

function frame(){
  if(!video.videoWidth)return null;
  tx.drawImage(video,0,0,W,H);
  return tx.getImageData(0,0,W,H);
}
function gray(d,x,y){
  const i=(y*W+x)*4;
  return d.data[i]*.299+d.data[i+1]*.587+d.data[i+2]*.114;
}
function template(d,cx,cy){
  const a=[],x0=Math.round(cx-PW/2),y0=Math.round(cy-PH/2);
  for(let y=0;y<PH;y+=STEP)for(let x=0;x<PW;x+=STEP){
    const xx=Math.max(1,Math.min(W-2,x0+x)),yy=Math.max(1,Math.min(H-2,y0+y));
    a.push(gray(d,xx,yy));
  }
  let sum=0;for(const v of a)sum+=v;const mean=sum/a.length;
  let ss=0;for(const v of a){const q=v-mean;ss+=q*q}
  const sd=Math.sqrt(Math.max(1,ss/a.length));
  return a.map(v=>(v-mean)/sd);
}
function score(d,cx,cy,t){
  const x0=Math.round(cx-PW/2),y0=Math.round(cy-PH/2);
  const raw=[];let sum=0;
  for(let y=0;y<PH;y+=STEP)for(let x=0;x<PW;x+=STEP){
    const xx=Math.max(1,Math.min(W-2,x0+x)),yy=Math.max(1,Math.min(H-2,y0+y));
    const v=gray(d,xx,yy);raw.push(v);sum+=v;
  }
  const mean=sum/raw.length;let ss=0;for(const v of raw){const q=v-mean;ss+=q*q}
  const sd=Math.sqrt(Math.max(1,ss/raw.length));
  let e=0;
  for(let k=0;k<raw.length;k++){const q=(raw[k]-mean)/sd-t[k];e+=q*q}
  return e/raw.length;
}
function best(c,d){
  let best=null;const r=Math.min(RADIUS+c.lost*10,95);
  for(let y=Math.max(PH/2+2,Math.round(c.y-r));y<=Math.min(H-PH/2-2,Math.round(c.y+r));y+=STRIDE){
    for(let x=Math.max(PW/2+2,Math.round(c.x-r));x<=Math.min(W-PW/2-2,Math.round(c.x+r));x+=STRIDE){
      const dx=x-c.x,dy=y-c.y;if(dx*dx+dy*dy>r*r)continue;
      const s=score(d,x,y,c.template);if(!best||s<best.s)best={x,y,s};
    }
  }
  return best;
}
function ball(d,c){
  let b=null,r=Math.min(70+c.lost*10,110);
  for(let y=Math.max(2,Math.round(c.y-r));y<=Math.min(H-3,Math.round(c.y+r));y+=3)
    for(let x=Math.max(2,Math.round(c.x-r));x<=Math.min(W-3,Math.round(c.x+r));x+=3){
      const i=(y*W+x)*4,R=d.data[i],G=d.data[i+1],B=d.data[i+2];
      const red=Math.max(0,R-Math.max(G,B)),sat=Math.max(R,G,B)-Math.min(R,G,B);
      if(red<55||sat<60||R<90)continue;
      const dist=Math.hypot(x-c.x,y-c.y),s=red*1.5+sat*.35-dist*1.1;
      if(!b||s>b.s)b={x,y,s};
    }
  return b;
}

function iniciarTracking(d){
  for(const c of copos){c.template=template(d,c.x,c.y);c.lost=0}
  if(alvo)alvo.lost=0;
  trackerReady=true;
}
function atualizar(d){
  if(!trackerReady){iniciarTracking(d);return}
  const ms=copos.map(c=>best(c,d)),used=[];
  ms.map((m,i)=>({m,i})).sort((a,b)=>(a.m?.s??1e9)-(b.m?.s??1e9)).forEach(o=>{
    const c=copos[o.i],m=o.m;
    if(!m||m.s>7){c.lost++;return}
    const collision=used.some(j=>Math.hypot(m.x-copos[j].x,m.y-copos[j].y)<34);
    if(collision){c.lost++;return}
    const jump=Math.hypot(m.x-c.x,m.y-c.y);
    if(jump>76&&c.lost===0){c.lost++;return}
    used.push(o.i);
    const a=c.lost?0.58:SMOOTH;
    c.x=c.x*(1-a)+m.x*a;c.y=c.y*(1-a)+m.y*a;c.lost=0;
    const fresh=template(d,c.x,c.y);
    c.template=c.template.map((v,k)=>v*.95+fresh[k]*.05);
  });
  if(alvo){
    const b=ball(d,alvo);
    if(b&&b.s>80&& (Math.hypot(b.x-alvo.x,b.y-alvo.y)<95||alvo.lost>2)){
      alvo.x=alvo.x*.45+b.x*.55;alvo.y=alvo.y*.45+b.y*.55;alvo.lost=0;
    }else alvo.lost++;
  }
}
function desenhar(){
  if(!cameraAtiva)return;
  ajustarCanvas();ctx.clearRect(0,0,canvas.width,canvas.height);
  const sx=canvas.width/W,sy=canvas.height/H;
  for(const c of copos){
    const x=c.x*sx,y=c.y*sy,w=62*sx,h=92*sy;
    ctx.strokeStyle="#fff";ctx.lineWidth=Math.max(3,canvas.width/220);ctx.strokeRect(x-w/2,y-h/2,w,h);
    ctx.fillStyle="#fff";ctx.font=`bold ${Math.max(24,canvas.width/28)}px Arial`;ctx.fillText(String(c.id),x-9,y-h/2-8);
  }
  if(alvo){
    const x=alvo.x*sx,y=alvo.y*sy;
    ctx.strokeStyle="#fff";ctx.lineWidth=Math.max(5,canvas.width/180);ctx.beginPath();ctx.arc(x,y,Math.max(18,canvas.width/42),0,Math.PI*2);ctx.stroke();
    ctx.fillStyle="#fff";ctx.font=`bold ${Math.max(16,canvas.width/46)}px Arial`;ctx.fillText("PEDRINHA",x-Math.max(42,canvas.width/22),y-Math.max(24,canvas.width/30));
  }
}
function loop(now){
  if(cameraAtiva&&!processando&&(now-lastProcessTime>=PROCESS_MS)&&copos.length===3){
    processando=true;lastProcessTime=now;
    const d=frame();if(d)atualizar(d);
    processando=false;
  }
  desenhar();rafId=requestAnimationFrame(loop);
}
async function iniciarCamera(){
  status("Solicitando acesso à câmera...");prepararVideo();
  if(!navigator.mediaDevices?.getUserMedia){status("Este Safari não disponibiliza a câmera para esta página.");return}
  if(stream)stream.getTracks().forEach(t=>t.stop());
  try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}}})}
  catch(e1){try{stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false})}catch(e2){status(e2.name==="NotAllowedError"?"A câmera foi bloqueada. Permita a câmera para este site.":"Não consegui acessar a câmera.");return}}
  video.srcObject=stream;prepararVideo();
  await new Promise(r=>{if(video.readyState>=1)r();else video.onloadedmetadata=r});
  try{await video.play()}catch(e){}
  cameraAtiva=true;trackerReady=false;status("🔥 CÂMERA ATIVA! Calibre os 3 copos.");
  if(!rafId)rafId=requestAnimationFrame(loop);
}
startButton.addEventListener("click",iniciarCamera);
calibrarButton.addEventListener("click",()=>{if(!cameraAtiva)return status("Primeiro toque em ABRIR CÂMERA.");copos=[];alvo=null;trackerReady=false;modo="copos";status("Toque no centro do COPO 1.")});
pedrinhaButton.addEventListener("click",()=>{if(!cameraAtiva)return status("Primeiro abra a câmera.");if(copos.length!==3)return status("Primeiro calibre os 3 copos.");modo="alvo";status("Toque exatamente na PEDRINHA.")});
limparButton.addEventListener("click",()=>{copos=[];alvo=null;modo="parado";trackerReady=false;status("Marcações limpas.")});
canvas.addEventListener("pointerdown",e=>{
  if(!cameraAtiva||!video.videoWidth)return;
  const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)*W/r.width,y=(e.clientY-r.top)*H/r.height;
  if(modo==="copos"){const id=copos.length+1;copos.push({id,x,y,lost:0,template:null});status(copos.length===3?"🔥 Copos 1, 2 e 3 calibrados. Agora selecione a pedrinha.":`Copo ${id} marcado. Agora toque no copo ${id+1}.`);if(copos.length===3)modo="parado"}
  else if(modo==="alvo"){alvo={x,y,lost:0};modo="parado";status("🔥 PEDRINHA SELECIONADA! Rastreamento automático ativado.")}
},{passive:true});
window.addEventListener("resize",ajustarCanvas);prepararVideo();status("Pronto. Toque em ABRIR CÂMERA.");
