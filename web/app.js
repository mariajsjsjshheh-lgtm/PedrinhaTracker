"use strict";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const statusEl = document.getElementById("status");

const startButton = document.getElementById("start");
const calibrarButton = document.getElementById("calibrar");
const pedrinhaButton = document.getElementById("pedrinha");
const limparButton = document.getElementById("limpar");

let stream = null;

let cameraAtiva = false;

let modo = "parado";

let copos = [];

let alvo = null;

let desenhoIniciado = false;


/*
========================================================
STATUS
========================================================
*/

function status(texto) {
  statusEl.textContent = texto;
}


/*
========================================================
CONFIGURAÇÃO DO VIDEO PARA IPHONE / SAFARI
========================================================
*/

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


/*
========================================================
TAMANHO DO CANVAS
========================================================
*/

function ajustarCanvas() {

  if (!video.videoWidth || !video.videoHeight) {
    return;
  }

  if (
    canvas.width !== video.videoWidth ||
    canvas.height !== video.videoHeight
  ) {

    canvas.width = video.videoWidth;

    canvas.height = video.videoHeight;

  }

}


/*
========================================================
DESENHO
========================================================
*/

function desenhar() {

  if (!cameraAtiva) {
    return;
  }

  ajustarCanvas();

  ctx.clearRect(
    0,
    0,
    canvas.width,
    canvas.height
  );


  /*
  ------------------------------------------------------
  COPOS
  ------------------------------------------------------
  */

  for (const copo of copos) {

    ctx.strokeStyle = "#ffffff";

    ctx.lineWidth =
      Math.max(
        3,
        canvas.width / 220
      );

    ctx.strokeRect(
      copo.x - 45,
      copo.y - 70,
      90,
      140
    );


    ctx.fillStyle = "#ffffff";

    ctx.font =
      "bold 28px Arial";

    ctx.fillText(
      String(copo.id),
      copo.x - 10,
      copo.y - 82
    );

  }


  /*
  ------------------------------------------------------
  PEDRINHA
  ------------------------------------------------------
  */

  if (alvo) {

    ctx.strokeStyle = "#ffffff";

    ctx.lineWidth =
      Math.max(
        5,
        canvas.width / 180
      );


    ctx.beginPath();

    ctx.arc(
      alvo.x,
      alvo.y,
      22,
      0,
      Math.PI * 2
    );

    ctx.stroke();


    ctx.fillStyle = "#ffffff";

    ctx.font =
      "bold 18px Arial";

    ctx.fillText(
      "PEDRINHA",
      alvo.x - 48,
      alvo.y - 30
    );

  }


  requestAnimationFrame(desenhar);

}


/*
========================================================
TENTAR DAR PLAY
========================================================
*/

async function tocarVideo() {

  prepararVideo();

  try {

    const resultado =
      video.play();

    if (
      resultado &&
      typeof resultado.then === "function"
    ) {

      await resultado;

    }

    return true;

  } catch (erro) {

    console.error(
      "Falha no video.play():",
      erro
    );

    return false;

  }

}


/*
========================================================
ABRIR CÂMERA
========================================================
*/

async function iniciarCamera() {

  /*
  IMPORTANTE:
  ESTA FUNÇÃO É CHAMADA DIRETAMENTE
  PELO TOQUE DO USUÁRIO.
  */

  status(
    "Solicitando acesso à câmera..."
  );


  prepararVideo();


  /*
  ------------------------------------------------------
  VERIFICAÇÃO DO NAVEGADOR
  ------------------------------------------------------
  */

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {

    status(
      "Este Safari não disponibiliza a câmera para esta página."
    );

    return;

  }


  /*
  ------------------------------------------------------
  FECHAR STREAM ANTERIOR
  ------------------------------------------------------
  */

  if (stream) {

    for (
      const track of stream.getTracks()
    ) {

      track.stop();

    }

  }


  /*
  ------------------------------------------------------
  CONFIGURAÇÃO DA CÂMERA
  ------------------------------------------------------
  */

  let constraints = {

    audio: false,

    video: {

      facingMode: {
        ideal: "environment"
      }

    }

  };


  try {

    /*
    PRIMEIRA TENTATIVA:
    câmera traseira
    */

    stream =
      await navigator.mediaDevices.getUserMedia(
        constraints
      );

  } catch (erro1) {

    console.error(
      "Primeira tentativa:",
      erro1
    );


    /*
    SEGUNDA TENTATIVA:
    câmera genérica
    */

    try {

      stream =
        await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });

    } catch (erro2) {

      console.error(
        "Segunda tentativa:",
        erro2
      );


      let mensagem =
        "Não consegui acessar a câmera.";


      if (
        erro2.name === "NotAllowedError"
      ) {

        mensagem =
          "A câmera foi bloqueada. No Safari, permita a câmera para este site.";

      } else if (
        erro2.name === "NotFoundError"
      ) {

        mensagem =
          "Nenhuma câmera foi encontrada.";

      } else if (
        erro2.name === "NotReadableError"
      ) {

        mensagem =
          "A câmera está sendo usada por outro aplicativo.";

      } else if (
        erro2.name === "SecurityError"
      ) {

        mensagem =
          "O Safari bloqueou a câmera por segurança. Abra o endereço HTTPS no Safari.";

      }


      status(mensagem);

      return;

    }

  }


  /*
  ------------------------------------------------------
  COLOCAR STREAM NO VIDEO
  ------------------------------------------------------
  */

  video.srcObject = stream;

  video.muted = true;

  video.autoplay = true;

  video.playsInline = true;


  /*
  ------------------------------------------------------
  ESPERAR METADADOS
  ------------------------------------------------------
  */

  await new Promise(
    (resolve) => {

      if (
        video.readyState >= 1
      ) {

        resolve();

        return;

      }


      video.onloadedmetadata =
        () => {

          resolve();

        };

    }
  );


  /*
  ------------------------------------------------------
  TENTAR PLAY
  ------------------------------------------------------
  */

  const tocou =
    await tocarVideo();


  if (!tocou) {

    status(
      "A câmera foi encontrada, mas o Safari não iniciou o vídeo. Toque novamente em ABRIR CÂMERA."
    );

    return;

  }


  /*
  ------------------------------------------------------
  SUCESSO
  ------------------------------------------------------
  */

  cameraAtiva = true;

  status(
    "🔥 CÂMERA ATIVA! Agora toque em CALIBRAR COPOS."
  );


  /*
  ------------------------------------------------------
  COMEÇAR DESENHO
  ------------------------------------------------------
  */

  if (!desenhoIniciado) {

    desenhoIniciado = true;

    desenhar();

  }

}


/*
========================================================
CLIQUE DO BOTÃO DA CÂMERA
========================================================
*/

startButton.addEventListener(
  "click",
  iniciarCamera
);


/*
========================================================
CALIBRAR COPOS
========================================================
*/

calibrarButton.addEventListener(
  "click",
  function () {

    if (!cameraAtiva) {

      status(
        "Primeiro toque em ABRIR CÂMERA."
      );

      return;

    }


    copos = [];

    alvo = null;

    modo = "copos";


    status(
      "Toque no centro do COPO 1."
    );

  }
);


/*
========================================================
SELECIONAR PEDRINHA
========================================================
*/

pedrinhaButton.addEventListener(
  "click",
  function () {

    if (!cameraAtiva) {

      status(
        "Primeiro abra a câmera."
      );

      return;

    }


    modo = "alvo";


    status(
      "Toque exatamente na PEDRINHA."
    );

  }
);


/*
========================================================
LIMPAR
========================================================
*/

limparButton.addEventListener(
  "click",
  function () {

    copos = [];

    alvo = null;

    modo = "parado";


    status(
      "Marcações limpas."
    );

  }
);


/*
========================================================
TOQUE NO CANVAS
========================================================
*/

canvas.addEventListener(
  "pointerdown",
  function (event) {

    if (!cameraAtiva) {
      return;
    }


    if (
      !video.videoWidth ||
      !video.videoHeight
    ) {

      return;

    }


    const rect =
      canvas.getBoundingClientRect();


    const x =
      (
        event.clientX -
        rect.left
      ) *
      canvas.width /
      rect.width;


    const y =
      (
        event.clientY -
        rect.top
      ) *
      canvas.height /
      rect.height;


    /*
    ----------------------------------------------------
    COPOS
    ----------------------------------------------------
    */

    if (modo === "copos") {

      const numero =
        copos.length + 1;


      copos.push({

        id: numero,

        x: x,

        y: y

      });


      if (
        copos.length === 3
      ) {

        modo = "parado";


        status(
          "🔥 Copos 1, 2 e 3 calibrados. Agora selecione a pedrinha."
        );

      } else {

        status(
          "Copo " +
          numero +
          " marcado. Agora toque no copo " +
          (numero + 1) +
          "."
        );

      }

      return;

    }


    /*
    ----------------------------------------------------
    PEDRINHA
    ----------------------------------------------------
    */

    if (modo === "alvo") {

      alvo = {

        x: x,

        y: y

      };


      modo = "parado";


      status(
        "🔥 PEDRINHA SELECIONADA!"
      );

    }

  },
  {
    passive: true
  }
);


/*
========================================================
RESIZE
========================================================
*/

window.addEventListener(
  "resize",
  ajustarCanvas
);


/*
========================================================
INICIALIZAÇÃO
========================================================
*/

prepararVideo();

status(
  "Pronto. Toque em ABRIR CÂMERA."
);
