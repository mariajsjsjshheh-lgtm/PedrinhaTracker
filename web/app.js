const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const status = document.getElementById("status");

let stream = null;
let modo = "parado";
let copos = [];
let alvo = null;
let ativo = false;

function mensagem(texto) {
  status.textContent = texto;
}

function ajustarCanvas() {
  if (video.videoWidth > 0) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

function desenhar() {
  if (!ativo) return;

  ajustarCanvas();

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const copo of copos) {
    ctx.strokeStyle = "white";
    ctx.lineWidth = Math.max(3, canvas.width / 220);

    ctx.strokeRect(
      copo.x - 45,
      copo.y - 70,
      90,
      140
    );

    ctx.fillStyle = "white";
    ctx.font = "bold 28px Arial";

    ctx.fillText(
      String(copo.id),
      copo.x - 10,
      copo.y - 82
    );
  }

  if (alvo) {
    ctx.strokeStyle = "white";
    ctx.lineWidth = Math.max(5, canvas.width / 180);

    ctx.beginPath();

    ctx.arc(
      alvo.x,
      alvo.y,
      22,
      0,
      Math.PI * 2
    );

    ctx.stroke();

    ctx.fillStyle = "white";
    ctx.font = "bold 18px Arial";

    ctx.fillText(
      "PEDRINHA",
      alvo.x - 48,
      alvo.y - 30
    );
  }

  requestAnimationFrame(desenhar);
}

async function iniciarCamera() {
  try {
    if (!navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia) {

      mensagem(
        "Este navegador não permite acesso à câmera."
      );

      return;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: {
          ideal: "environment"
        }
      },
      audio: false
    });

    video.srcObject = stream;

    await video.play();

    ativo = true;

    mensagem(
      "Câmera ativa. Toque em 'Calibrar copos'."
    );

    desenhar();

  } catch (erro) {
    console.error(erro);

    mensagem(
      "Não consegui acessar a câmera. Verifique a permissão do Safari."
    );
  }
}

canvas.addEventListener(
  "pointerdown",
  function(event) {

    if (!video.videoWidth) return;

    const rect = canvas.getBoundingClientRect();

    const x =
      (event.clientX - rect.left) *
      canvas.width /
      rect.width;

    const y =
      (event.clientY - rect.top) *
      canvas.height /
      rect.height;

    if (modo === "copos") {

      copos.push({
        id: copos.length + 1,
        x: x,
        y: y
      });

      if (copos.length === 3) {

        modo = "parado";

        mensagem(
          "Copos 1, 2 e 3 calibrados. Agora selecione a pedrinha."
        );

      } else {

        mensagem(
          "Copo " +
          copos.length +
          " marcado. Toque no copo " +
          (copos.length + 1) +
          "."
        );
      }

    } else if (modo === "alvo") {

      alvo = {
        x: x,
        y: y
      };

      modo = "parado";

      mensagem(
        "Pedrinha selecionada. Marcador branco ativado."
      );
    }
  }
);

document
  .getElementById("start")
  .onclick = iniciarCamera;

document
  .getElementById("calibrar")
  .onclick = function() {

    if (!ativo) {
      mensagem("Inicie a câmera primeiro.");
      return;
    }

    copos = [];
    alvo = null;
    modo = "copos";

    mensagem(
      "Toque no centro do copo 1."
    );
  };

document
  .getElementById("pedrinha")
  .onclick = function() {

    if (!ativo) {
      mensagem("Inicie a câmera primeiro.");
      return;
    }

    modo = "alvo";

    mensagem(
      "Toque exatamente na pedrinha."
    );
  };

document
  .getElementById("limpar")
  .onclick = function() {

    copos = [];
    alvo = null;
    modo = "parado";

    mensagem(
      "Marcações limpas."
    );
  };
