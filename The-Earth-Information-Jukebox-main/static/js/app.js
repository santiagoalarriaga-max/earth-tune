// Earth Sonification Jukebox
// Las imágenes (título, ubicación, descripción) vienen de config/imagenes.json,
// que Flask inyecta en la página. app.py analiza cada imagen según el modo elegido
// (ruta /api/sonificar/<id>?modo=...&textura=...) y aquí se toca con Web Audio.

const imagenes = JSON.parse(document.getElementById("imagenes-data").textContent);

// Opciones de sonido elegidas por el usuario (por defecto, el recorrido original)
const opciones = { modo: "columnas", textura: false, estereo: false };

// Modos de reproducción, en el orden de los atajos 1-5
const MODOS = {
  columnas: {
    nombre: "Columns, left to right",
    guia: "Each column of the image, from left to right, is a note of the pentatonic scale (C, D, E, G, A). Bright areas sound high and dark areas sound low; intense colors sound louder.",
  },
  latitudes: {
    nombre: "Top to bottom, by latitude",
    guia: "The image is played from top to bottom, band by band, as if moving down through the planet's latitudes. Each band is a pentatonic note: bright bands sound high and dark bands sound low; intense colors sound louder.",
  },
  radar: {
    nombre: "Radar, from the center outward",
    guia: "The sound starts at the center of the image and expands in rings toward the edges, like a radar. Each ring is a pentatonic note: bright rings sound high and dark rings sound low.",
  },
  espiral: {
    nombre: "Spiral from the center",
    guia: "The image is divided into 64 zones played in a spiral, from the center out to the edges. Each zone is a pentatonic note: bright zones sound high and dark zones sound low.",
  },
  espectrograma: {
    nombre: "Spectrogram, exact frequencies",
    guia: "The image is played as a spectrogram, from left to right: each row is an exact frequency, high at the top and low at the bottom. Bright areas sound and dark areas stay silent. It sounds less musical but is more faithful to the image.",
  },
  acordes_columnas: {
    nombre: "Chords by column, left to right",
    guia: "The image is played column by column from left to right. Each column is split into 4 areas that sound together as a pentatonic chord: area 1 at the bottom (C3 to C4), areas 2 and 3 in the middle (C4 to C5) and area 4 at the top (C5 to C6). Warm colors such as red, orange and yellow play the lowest note of each area and cool colors such as blue and cyan the highest; grays play the middle. Dark areas are almost silent and bright areas are loud.",
  },
  acordes_latitudes: {
    nombre: "Chords by latitude, bottom to top",
    guia: "The image is played in horizontal bands from bottom to top, like moving up through the latitudes. Each band is split into 4 areas from left to right that sound together as a pentatonic chord: area 1 on the left (C3 to C4), areas 2 and 3 in the middle (C4 to C5) and area 4 on the right (C5 to C6). Warm colors play the lowest note of each area and cool colors the highest; grays play the middle. Dark areas are almost silent and bright areas are loud.",
  },
};

// Sonidos de los botones (carpeta static/Sonidos). Si alguno no carga, se usa un tono sintético.
const SONIDOS_UI = {
  play: "ui-play.wav",
  siguiente: "ui-next.wav.wav",
  anterior: "ui-prev.wav.wav",
  contraste: "ui-modo-contraste.wav",
  normal: "ui-modo-normal.wav",
  vozOff: "ui-voz-off.wav",
};
const baseSonidos = document.getElementById("jukebox").dataset.sonidos;
const audiosUI = {};
for (const [nombre, archivo] of Object.entries(SONIDOS_UI)) {
  const audio = new Audio(baseSonidos + encodeURIComponent(archivo));
  audio.preload = "auto";
  audiosUI[nombre] = audio;
}

let currentIndex = 0;
let voiceEnabled = true;

// Estado de la reproducción
let sonido = null;        // respuesta de /api/sonificar: { tipo, duracion_nota, pasos, ... }
let posicion = 0;         // índice del paso que sigue
let isPlaying = false;
let stepTimer = null;
let cargaActual = 0;      // para ignorar respuestas viejas si el usuario cambia rápido
const cacheSonidos = new Map();

let audioCtx, salida, analyser, dataArray, bufferRuido;
let espectro = null;      // osciladores del modo espectrograma mientras suena

const selector = document.getElementById("selector-imagen");
const modoSel = document.getElementById("modo");
const optTextura = document.getElementById("opt-textura");
const optEstereo = document.getElementById("opt-estereo");
const btnPlay = document.getElementById("btn-play");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");
const btnMode = document.getElementById("btn-mode");
const btnBars = document.getElementById("btn-bars");
const btnVoice = document.getElementById("btn-voice");
const titleEl = document.getElementById("track-title");
const locationEl = document.getElementById("track-location");
const descriptionEl = document.getElementById("track-description");
const counterEl = document.getElementById("track-counter");
const legendEl = document.getElementById("track-legend");
const noteEl = document.getElementById("current-note");
const imgEl = document.getElementById("nasa-image");
const overlay = document.getElementById("recorrido-overlay");
const octx = overlay.getContext("2d");
const announcer = document.getElementById("live-announcer");
const seekBar = document.getElementById("seek-bar");
const timeDisplay = document.getElementById("time-display");
const canvas = document.getElementById("audio-visualizer");
const ctx = canvas.getContext("2d");

// ---------------------------------------------------------------------------
// Audio: todo pasa por un compresor (evita saturar) y el analizador (visualizador)
// ---------------------------------------------------------------------------
function initAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    salida = audioCtx.createDynamicsCompressor();
    salida.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Ruido blanco para la percusión del ritmo por textura
    bufferRuido = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
    const datos = bufferRuido.getChannelData(0);
    for (let i = 0; i < datos.length; i++) datos[i] = Math.random() * 2 - 1;

    drawWave();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

// Destino de un sonido: con paneo izquierda/derecha si la opción está activa
function crearDestino(pan) {
  if (opciones.estereo && audioCtx.createStereoPanner) {
    const panner = audioCtx.createStereoPanner();
    panner.pan.value = pan || 0;
    panner.connect(salida);
    return panner;
  }
  return salida;
}

function playEarcon(freq = 660) {
  initAudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.12);
}

// Toca el sonido de un botón; si el archivo no está disponible, usa el tono sintético
function playSonidoUI(nombre, freqRespaldo) {
  const audio = audiosUI[nombre];
  if (!audio || audio.error) {
    playEarcon(freqRespaldo);
    return;
  }
  audio.currentTime = 0;
  audio.play().catch(() => playEarcon(freqRespaldo));
}

// Toca un paso: una nota larga, o varias rápidas (y percusión) si la zona tiene textura
function playNote(paso, duracion) {
  const golpes = paso.golpes || 1;
  const sub = duracion / golpes;
  const destino = crearDestino(paso.pan);
  const pico = (golpes > 1 ? 0.2 : 0.25) * paso.volumen;

  for (let i = 0; i < golpes; i++) {
    const t = audioCtx.currentTime + i * sub;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(paso.frecuencia, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(pico, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(pico * 0.6, t + sub * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + sub * 0.95);
    osc.connect(gain);
    gain.connect(destino);
    osc.start(t);
    osc.stop(t + sub);

    if (paso.percusion) playPercusion(t, destino);
  }
}

// Golpe corto de ruido filtrado (como un hi-hat)
function playPercusion(t, destino) {
  const ruido = audioCtx.createBufferSource();
  ruido.buffer = bufferRuido;
  const filtro = audioCtx.createBiquadFilter();
  filtro.type = "highpass";
  filtro.frequency.value = 3000;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.18, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  ruido.connect(filtro);
  filtro.connect(gain);
  gain.connect(destino);
  ruido.start(t);
  ruido.stop(t + 0.07);
}

// ---------------------------------------------------------------------------
// Espectrograma: un oscilador por fila (frecuencia exacta); el brillo es el volumen
// ---------------------------------------------------------------------------
function iniciarEspectro() {
  detenerEspectro();
  const bus = audioCtx.createGain();
  bus.gain.value = 0.35 / Math.max(sonido.maxSuma, 1);
  let panner = null;
  if (opciones.estereo && audioCtx.createStereoPanner) {
    panner = audioCtx.createStereoPanner();
    bus.connect(panner);
    panner.connect(salida);
  } else {
    bus.connect(salida);
  }
  const oscs = [];
  const gains = sonido.frecuencias.map((f) => {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    g.gain.value = 0;
    osc.connect(g);
    g.connect(bus);
    osc.start();
    oscs.push(osc);
    return g;
  });
  espectro = { oscs, gains, bus, panner };
}

function aplicarColumna(paso) {
  const t = audioCtx.currentTime;
  paso.valores.forEach((v, k) => espectro.gains[k].gain.setTargetAtTime(v * v, t, 0.015));
  if (espectro.panner) espectro.panner.pan.setTargetAtTime(paso.pan, t, 0.05);
}

function detenerEspectro() {
  if (!espectro) return;
  const t = audioCtx.currentTime;
  espectro.bus.gain.setTargetAtTime(0, t, 0.02);
  espectro.oscs.forEach((osc) => osc.stop(t + 0.1));
  espectro = null;
}

// ---------------------------------------------------------------------------
// Voz guía y visualizador
// ---------------------------------------------------------------------------
function announce(text) {
  announcer.textContent = "";
  setTimeout(() => { announcer.textContent = text; }, 50);

  if (voiceEnabled && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }
}

function drawWave() {
  requestAnimationFrame(drawWave);
  if (!analyser || !isPlaying) return;

  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  analyser.getByteFrequencyData(dataArray);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const barWidth = (canvas.width / dataArray.length) * 1.5;
  let x = 0;

  for (let i = 0; i < dataArray.length; i++) {
    const barHeight = (dataArray[i] / 255) * canvas.height;
    ctx.fillStyle = i % 2 === 0 ? "#00F0FF" : "#FFB800";
    ctx.fillRect(x, canvas.height - barHeight, barWidth - 3, barHeight);
    x += barWidth;
  }
}

// Marca sobre la imagen la zona que está sonando
function dibujarRecorrido() {
  const w = overlay.clientWidth;
  const h = overlay.clientHeight;
  overlay.width = w;
  overlay.height = h;
  octx.clearRect(0, 0, w, h);
  if (!sonido || !(isPlaying || posicion > 0)) return;

  const paso = sonido.pasos[Math.max(posicion - 1, 0)];
  const region = paso && paso.region;
  if (!region) return;

  const acento = getComputedStyle(document.body).getPropertyValue("--ej-accent").trim() || "#4fc3f7";
  octx.fillStyle = acento;
  octx.strokeStyle = acento;
  octx.lineWidth = 2;

  // Modos de acordes: cada una de las 4 áreas se ilumina según el volumen de su nota
  if (paso.subregiones) {
    paso.subregiones.forEach((s, k) => {
      octx.globalAlpha = 0.1 + 0.5 * paso.notas[k].volumen;
      octx.fillRect(s.x * w, s.y * h, s.w * w, s.h * h);
    });
    octx.globalAlpha = 1;
    octx.lineWidth = 1;
    paso.subregiones.forEach((s) => octx.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h));
    return;
  }

  octx.beginPath();
  if (region.forma === "anillo") {
    octx.ellipse(w / 2, h / 2, region.r1 * w / 2, region.r1 * h / 2, 0, 0, Math.PI * 2);
    octx.ellipse(w / 2, h / 2, region.r0 * w / 2, region.r0 * h / 2, 0, 0, Math.PI * 2);
  } else {
    octx.rect(region.x * w, region.y * h, region.w * w, region.h * h);
  }
  octx.globalAlpha = 0.3;
  octx.fill("evenodd");
  octx.globalAlpha = 1;
  octx.stroke();
}

// ---------------------------------------------------------------------------
// Reproducción paso a paso
// ---------------------------------------------------------------------------
function step() {
  if (posicion >= sonido.pasos.length) {
    pauseCurrentTrack();
    posicion = 0;
    updateProgress();
    return;
  }
  const paso = sonido.pasos[posicion];
  if (sonido.tipo === "espectrograma") {
    aplicarColumna(paso);
    noteEl.textContent = `${paso.dominante} Hz`;
  } else if (sonido.tipo === "acordes") {
    // 4 notas al mismo tiempo; volumen a la mitad para que el acorde no sature,
    // y la percusión (si hay textura) solo una vez por acorde
    paso.notas.forEach((nota, k) => playNote({
      ...nota,
      volumen: nota.volumen * 0.5,
      golpes: paso.golpes,
      percusion: k === 0 && paso.percusion,
    }, sonido.duracion_nota));
    const acorde = paso.notas.map((n) => n.nota).join(" · ");
    noteEl.textContent = paso.golpes > 1 ? `${acorde} ×${paso.golpes}` : acorde;
  } else {
    playNote(paso, sonido.duracion_nota);
    noteEl.textContent = paso.golpes > 1 ? `${paso.nota} ×${paso.golpes}` : paso.nota;
  }
  posicion++;
  updateProgress();
}

function updateProgress() {
  const total = sonido ? sonido.pasos.length : 0;
  const dur = sonido ? sonido.duracion_nota : 0;
  seekBar.value = total ? (posicion / total) * 100 : 0;
  timeDisplay.textContent = `${formatTime(posicion * dur)} / ${formatTime(total * dur)}`;
  dibujarRecorrido();
}

function stopTimer() {
  clearInterval(stepTimer);
  stepTimer = null;
}

async function obtenerSonido(id) {
  const textura = opciones.textura && opciones.modo !== "espectrograma";
  const clave = `${id}|${opciones.modo}|${textura ? 1 : 0}`;
  if (!cacheSonidos.has(clave)) {
    const url = `/api/sonificar/${encodeURIComponent(id)}?modo=${opciones.modo}&textura=${textura ? 1 : 0}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const datos = await resp.json();
    if (datos.tipo === "espectrograma") {
      // Volumen general: se ajusta a la columna con más energía para no saturar
      datos.maxSuma = Math.max(...datos.pasos.map((p) => p.valores.reduce((s, v) => s + v * v, 0)));
    }
    cacheSonidos.set(clave, datos);
  }
  return cacheSonidos.get(clave);
}

// Pide el sonido de la imagen actual con las opciones actuales
async function cargarSonido(autoPlay = false) {
  pauseCurrentTrack();
  const carga = ++cargaActual;
  sonido = null;
  posicion = 0;
  noteEl.textContent = "—";
  updateProgress();
  btnPlay.disabled = true;
  btnPlay.textContent = "Loading…";

  try {
    const datos = await obtenerSonido(imagenes[currentIndex].id);
    if (carga !== cargaActual) return; // el usuario ya cambió de imagen u opción
    sonido = datos;
    btnPlay.disabled = false;
    updatePlayState(false);
    updateProgress();
    if (autoPlay) playCurrentTrack();
  } catch (e) {
    if (carga !== cargaActual) return;
    btnPlay.textContent = "No sound";
    announce("This image could not be turned into sound.");
  }
}

function loadTrack(index, autoPlay = false) {
  currentIndex = index;
  const imagen = imagenes[index];

  selector.value = imagen.id;
  counterEl.textContent = `IMAGE ${index + 1} OF ${imagenes.length}`;
  locationEl.textContent = `LOCATION: ${imagen.ubicacion}`;
  titleEl.textContent = imagen.titulo;
  descriptionEl.textContent = imagen.descripcion;
  imgEl.src = imagen.url;
  imgEl.alt = `${imagen.titulo}. ${imagen.descripcion}`;

  announce(`${imagen.titulo}. Location: ${imagen.ubicacion}. ${imagen.descripcion}`);
  cargarSonido(autoPlay);
}

function playCurrentTrack() {
  if (!sonido || isPlaying) return;
  initAudioContext();
  if (posicion >= sonido.pasos.length) posicion = 0;
  if (sonido.tipo === "espectrograma") iniciarEspectro();
  isPlaying = true;
  updatePlayState(true);
  step();
  stepTimer = setInterval(step, sonido.duracion_nota * 1000);
}

function pauseCurrentTrack() {
  stopTimer();
  detenerEspectro();
  isPlaying = false;
  updatePlayState(false);
}

function togglePlay() {
  if (!sonido) return;
  if (isPlaying) {
    playEarcon(520); // no hay sonido de pausa en la carpeta: tono sintético
    pauseCurrentTrack();
  } else {
    playSonidoUI("play", 520);
    playCurrentTrack();
  }
}

function updatePlayState(playing) {
  btnPlay.setAttribute("aria-pressed", playing);
  btnPlay.textContent = playing ? "Pause" : "Play";
}

// ---------------------------------------------------------------------------
// Opciones de sonido
// ---------------------------------------------------------------------------
function textoGuia() {
  let texto = MODOS[opciones.modo].guia;
  if (opciones.textura && opciones.modo !== "espectrograma") {
    texto += " Rhythm from texture: detailed areas play fast notes with percussion; smooth areas play long notes.";
  }
  if (opciones.estereo) {
    texto += " What is on the left of the image is heard on the left side, and what is on the right on the right side.";
  }
  return texto;
}

function actualizarLeyenda() {
  legendEl.textContent = textoGuia();
}

function cambiarModo(modo) {
  opciones.modo = modo;
  modoSel.value = modo;
  optTextura.disabled = modo === "espectrograma";
  actualizarLeyenda();
  announce(`Mode: ${MODOS[modo].nombre}. ${MODOS[modo].guia}`);
  cargarSonido(false);
}

function cambiarTextura(activa) {
  opciones.textura = activa;
  optTextura.checked = activa;
  actualizarLeyenda();
  announce(activa ? "Rhythm from texture on." : "Rhythm from texture off.");
  cargarSonido(false);
}

function cambiarEstereo(activo) {
  opciones.estereo = activo;
  optEstereo.checked = activo;
  actualizarLeyenda();
  announce(activo ? "Left and right sound on." : "Left and right sound off.");
  // El espectrograma arma su cadena de audio al empezar: se reinicia para aplicar el cambio
  if (isPlaying && sonido.tipo === "espectrograma") {
    iniciarEspectro();
  }
}

function toggleVisualMode() {
  const isFocus = document.body.classList.toggle("modo-enfoque");
  playSonidoUI(isFocus ? "contraste" : "normal", 780);
  btnMode.textContent = isFocus ? "View: High contrast (M)" : "View: Normal (M)";
  announce(isFocus ? "High-contrast view on." : "Normal view on.");
}

// Muestra u oculta la barra de sonido que aparece sobre la imagen
function toggleBarras() {
  const visibles = canvas.classList.toggle("d-none") === false;
  btnBars.setAttribute("aria-pressed", visibles);
  btnBars.textContent = visibles ? "Sound bars: On (B)" : "Sound bars: Off (B)";
  playEarcon(visibles ? 700 : 500);
  announce(visibles ? "Sound bars shown." : "Sound bars hidden.");
}

function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  btnVoice.setAttribute("aria-pressed", voiceEnabled);
  btnVoice.textContent = voiceEnabled ? "Voice: On (V)" : "Voice: Off (V)";
  if (voiceEnabled) {
    announce("Voice guide on.");
  } else {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    playSonidoUI("vozOff", 330);
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
btnPlay.addEventListener("click", togglePlay);
btnMode.addEventListener("click", toggleVisualMode);
btnVoice.addEventListener("click", toggleVoice);
btnBars.addEventListener("click", toggleBarras);

selector.addEventListener("change", () => {
  playEarcon(600);
  loadTrack(imagenes.findIndex((i) => i.id === selector.value), false);
});

modoSel.addEventListener("change", () => cambiarModo(modoSel.value));
optTextura.addEventListener("change", () => cambiarTextura(optTextura.checked));
optEstereo.addEventListener("change", () => cambiarEstereo(optEstereo.checked));

btnPrev.addEventListener("click", () => {
  playSonidoUI("anterior", 440);
  loadTrack((currentIndex - 1 + imagenes.length) % imagenes.length, true);
});

btnNext.addEventListener("click", () => {
  playSonidoUI("siguiente", 660);
  loadTrack((currentIndex + 1) % imagenes.length, true);
});

seekBar.addEventListener("input", () => {
  if (!sonido) return;
  posicion = Math.min(Math.round((seekBar.value / 100) * sonido.pasos.length), sonido.pasos.length - 1);
  updateProgress();
});

window.addEventListener("resize", dibujarRecorrido);

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // no robar Ctrl+R, etc.
  // No robar las teclas cuando el usuario está en una lista o en la barra de tiempo
  const campo = document.activeElement;
  const enCampo = campo.tagName === "SELECT" || campo.tagName === "TEXTAREA" ||
                  (campo.tagName === "INPUT" && campo.type !== "checkbox");
  if (enCampo) return;

  const tecla = e.key.toLowerCase();
  const listaModos = Object.keys(MODOS);
  const numero = Number(e.key);
  if (Number.isInteger(numero) && numero >= 1 && numero <= listaModos.length) {
    // 1-5: elegir directamente la forma de reproducir la imagen
    if (listaModos[numero - 1] !== opciones.modo) {
      playEarcon(600);
      cambiarModo(listaModos[numero - 1]);
    }
  } else if (e.key === "ArrowRight") {
    btnNext.click();
  } else if (e.key === "ArrowLeft") {
    btnPrev.click();
  } else if (e.code === "Space" && !["BUTTON", "INPUT"].includes(campo.tagName)) {
    e.preventDefault();
    togglePlay();
  } else if (tecla === "m") {
    toggleVisualMode();
  } else if (tecla === "v") {
    toggleVoice();
  } else if (tecla === "b") {
    toggleBarras();
  } else if (tecla === "g") {
    playEarcon(700);
    announce(textoGuia());
  } else if (tecla === "r") {
    playEarcon(600);
    cambiarModo(listaModos[(listaModos.indexOf(opciones.modo) + 1) % listaModos.length]);
  } else if (tecla === "t" && !optTextura.disabled) {
    playEarcon(600);
    cambiarTextura(!opciones.textura);
  } else if (tecla === "e") {
    playEarcon(600);
    cambiarEstereo(!opciones.estereo);
  }
});

// Carga la imagen indicada en ?imagen=<id> (por ejemplo, recién subida) o la primera
actualizarLeyenda();
const inicial = imagenes.findIndex((i) => i.id === selector.value);
loadTrack(inicial >= 0 ? inicial : 0, false);
