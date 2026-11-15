import colorsys
import json
import math
import os
import uuid
from pathlib import Path

from flask import (Flask, abort, flash, jsonify, redirect, render_template,
                   request, url_for)
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "cambia-esta-clave-en-produccion"),
    # Archivo de configuración con el título, ubicación y descripción de cada imagen
    CONFIG_FILE=BASE_DIR / "config" / "imagenes.json",
    # Carpeta donde se guardan las imágenes que suben los usuarios
    UPLOAD_FOLDER=BASE_DIR / "static" / "Imagenes",
    MAX_CONTENT_LENGTH=10 * 1024 * 1024,  # 10 MB por imagen
)

EXTENSIONES_PERMITIDAS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}


# ---------------------------------------------------------------------------
# Archivo de configuración
# ---------------------------------------------------------------------------
def leer_config():
    """Devuelve la lista de imágenes guardadas en el archivo de configuración."""
    ruta = Path(app.config["CONFIG_FILE"])
    if not ruta.exists():
        return []
    with ruta.open(encoding="utf-8") as f:
        return json.load(f)


def guardar_config(imagenes):
    """Escribe la lista completa (primero a un temporal para no corromper el archivo)."""
    ruta = Path(app.config["CONFIG_FILE"])
    ruta.parent.mkdir(parents=True, exist_ok=True)
    temporal = ruta.with_suffix(".tmp")
    with temporal.open("w", encoding="utf-8") as f:
        json.dump(imagenes, f, ensure_ascii=False, indent=2)
    os.replace(temporal, ruta)


def buscar_imagen(imagen_id):
    return next((i for i in leer_config() if i["id"] == imagen_id), None)


def con_url(imagen):
    """Agrega la URL pública de la imagen para usarla en el navegador."""
    return {**imagen, "url": url_for("static", filename=f"Imagenes/{imagen['archivo']}")}


# ---------------------------------------------------------------------------
# Sonificación con la escala pentatónica
# ---------------------------------------------------------------------------
# Escala pentatónica mayor: C, D, E, G, A (Do, Re, Mi, Sol, La), en semitonos desde la tónica.
ESCALA_PENTATONICA = [0, 2, 4, 7, 9]
NOMBRES_NOTAS = {0: "C", 2: "D", 4: "E", 7: "G", 9: "A"}
FRECUENCIA_DO3 = 130.81
OCTAVAS = 3
DURACION_NOTA = 0.25          # segundos por nota
DURACION_NOTA_TEXTURA = 0.5   # con ritmo por textura, para que las notas lisas sean largas
TEXTURA_REFERENCIA = 0.08     # densidad de bordes a partir de la cual una zona se considera "con detalle"

# La imagen se analiza sobre una rejilla reducida de 96 x 64 píxeles
REJILLA_ANCHO, REJILLA_ALTO = 96, 64

MODOS = ("columnas", "latitudes", "radar", "espiral", "espectrograma",
         "acordes_columnas", "acordes_latitudes")

# Modos de acordes: cada franja se divide en 4 áreas que suenan al mismo tiempo.
# Octava inicial de cada área (una octava por área): 1 = C3-C4, 2 y 3 = C4-C5, 4 = C5-C6
RANGOS_AREAS = [3, 4, 4, 5]
AREAS = len(RANGOS_AREAS)


def notas_pentatonicas():
    """Lista de (nombre, frecuencia) de la escala pentatónica, de grave a agudo."""
    notas = []
    for octava in range(OCTAVAS):
        for semitono in ESCALA_PENTATONICA:
            frecuencia = FRECUENCIA_DO3 * 2 ** ((octava * 12 + semitono) / 12)
            notas.append((f"{NOMBRES_NOTAS[semitono]}{octava + 3}", frecuencia))
    notas.append((f"C{OCTAVAS + 3}", FRECUENCIA_DO3 * 2 ** OCTAVAS))
    return notas


def notas_de_octava(octava):
    """Las 6 notas pentatónicas de una octava, incluido el C de arriba (p. ej. C4 D4 E4 G4 A4 C5)."""
    notas = []
    for semitono in ESCALA_PENTATONICA + [12]:
        frecuencia = FRECUENCIA_DO3 * 2 ** (((octava - 3) * 12 + semitono) / 12)
        nombre = f"C{octava + 1}" if semitono == 12 else f"{NOMBRES_NOTAS[semitono]}{octava}"
        notas.append((nombre, frecuencia))
    return notas


def calidez(color):
    """
    Qué tan cálido o frío es un color, de -1 (frío) a +1 (cálido), según su matiz:
    naranja = +1, rojo y amarillo ≈ +0.9, verde ≈ 0, violeta ≈ -0.5, azul/cian = -1.
    Los colores poco saturados (grises, negro, blanco) se acercan a 0 (neutro).
    """
    r, g, b = (c / 255 for c in color)
    matiz, saturacion, _ = colorsys.rgb_to_hsv(r, g, b)
    valor = math.cos(math.radians(matiz * 360 - 30))
    return valor * min(saturacion / 0.3, 1.0)


def luminancia(color):
    r, g, b = color
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255


def abrir_imagen(ruta_imagen):
    with Image.open(ruta_imagen) as img:
        return ImageOps.exif_transpose(img).convert("RGB")


def rejilla(img):
    """
    Reduce la imagen a la rejilla de análisis. Devuelve, por cada píxel de la rejilla:
      - su color promedio (r, g, b)
      - su densidad de bordes (0-255): cuánto detalle/textura hay en esa zona
    """
    tamano = (REJILLA_ANCHO, REJILLA_ALTO)
    colores = list(img.resize(tamano, Image.Resampling.BOX).getdata())
    bordes = (img.convert("L")
              .resize((258, 258), Image.Resampling.BILINEAR)
              .filter(ImageFilter.FIND_EDGES)
              .crop((1, 1, 257, 257))          # quita el marco que el filtro marca como borde
              .resize(tamano, Image.Resampling.BOX))
    return colores, list(bordes.getdata())


# --- Recorridos: cada uno define en qué orden se visitan las zonas de la rejilla ---
def indice(x, y):
    return y * REJILLA_ANCHO + x


def recorrido_columnas(columnas=48):
    """De izquierda a derecha (el recorrido original)."""
    ancho = REJILLA_ANCHO // columnas
    for c in range(columnas):
        xs = range(c * ancho, (c + 1) * ancho)
        yield ([indice(x, y) for y in range(REJILLA_ALTO) for x in xs],
               {"forma": "rect", "x": c * ancho / REJILLA_ANCHO, "y": 0,
                "w": ancho / REJILLA_ANCHO, "h": 1})


def recorrido_latitudes(filas=32):
    """De arriba abajo, franja por franja, como recorrer las latitudes."""
    alto = REJILLA_ALTO // filas
    for f in range(filas):
        ys = range(f * alto, (f + 1) * alto)
        yield ([indice(x, y) for y in ys for x in range(REJILLA_ANCHO)],
               {"forma": "rect", "x": 0, "y": f * alto / REJILLA_ALTO,
                "w": 1, "h": alto / REJILLA_ALTO})


def recorrido_radar(anillos=24):
    """Anillos del centro hacia afuera (elipses que se ajustan a la forma de la imagen)."""
    radio_max = math.sqrt(2)  # distancia normalizada del centro a una esquina
    grupos = [[] for _ in range(anillos)]
    for y in range(REJILLA_ALTO):
        for x in range(REJILLA_ANCHO):
            dx = ((x + 0.5) / REJILLA_ANCHO - 0.5) * 2
            dy = ((y + 0.5) / REJILLA_ALTO - 0.5) * 2
            k = min(int(math.hypot(dx, dy) / radio_max * anillos), anillos - 1)
            grupos[k].append(indice(x, y))
    for k, indices in enumerate(grupos):
        if indices:
            yield (indices, {"forma": "anillo", "r0": k * radio_max / anillos,
                             "r1": (k + 1) * radio_max / anillos})


def orden_espiral(columnas, filas):
    """Celdas (x, y) en espiral, empezando en el centro y saliendo hacia las orillas."""
    x, y = (columnas - 1) // 2, (filas - 1) // 2
    orden = [(x, y)]
    dx, dy, paso = 1, 0, 1
    while len(orden) < columnas * filas:
        for _ in range(2):
            for _ in range(paso):
                x, y = x + dx, y + dy
                if 0 <= x < columnas and 0 <= y < filas:
                    orden.append((x, y))
            dx, dy = -dy, dx  # gira 90°
        paso += 1
    return orden


def recorrido_espiral(celdas=8):
    """Zonas de 8 x 8 visitadas en espiral desde el centro."""
    ancho, alto = REJILLA_ANCHO // celdas, REJILLA_ALTO // celdas
    for cx, cy in orden_espiral(celdas, celdas):
        yield ([indice(x, y)
                for y in range(cy * alto, (cy + 1) * alto)
                for x in range(cx * ancho, (cx + 1) * ancho)],
               {"forma": "rect", "x": cx / celdas, "y": cy / celdas,
                "w": 1 / celdas, "h": 1 / celdas})


RECORRIDOS = {
    "columnas": recorrido_columnas,
    "latitudes": recorrido_latitudes,
    "radar": recorrido_radar,
    "espiral": recorrido_espiral,
}


# --- Recorridos de acordes: cada paso es una franja dividida en 4 áreas ---
def recorrido_columnas_acordes(columnas=48):
    """Columnas de izquierda a derecha; cada columna en 4 áreas, el área 1 es la de abajo."""
    ancho = REJILLA_ANCHO // columnas
    alto = REJILLA_ALTO // AREAS
    for c in range(columnas):
        xs = range(c * ancho, (c + 1) * ancho)
        areas, subregiones = [], []
        for k in range(AREAS):
            y0 = REJILLA_ALTO - (k + 1) * alto          # k = 0 -> abajo
            areas.append([indice(x, y) for y in range(y0, y0 + alto) for x in xs])
            subregiones.append({"forma": "rect", "x": c * ancho / REJILLA_ANCHO,
                                "y": y0 / REJILLA_ALTO, "w": ancho / REJILLA_ANCHO,
                                "h": alto / REJILLA_ALTO})
        yield (areas,
               {"forma": "rect", "x": c * ancho / REJILLA_ANCHO, "y": 0,
                "w": ancho / REJILLA_ANCHO, "h": 1},
               subregiones)


def recorrido_latitudes_acordes(filas=32):
    """Franjas horizontales de abajo hacia arriba; cada franja en 4 áreas, el área 1 es la izquierda."""
    alto = REJILLA_ALTO // filas
    ancho = REJILLA_ANCHO // AREAS
    for f in reversed(range(filas)):                    # empieza en la franja de abajo
        ys = range(f * alto, (f + 1) * alto)
        areas, subregiones = [], []
        for k in range(AREAS):
            x0 = k * ancho                              # k = 0 -> izquierda
            areas.append([indice(x, y) for y in ys for x in range(x0, x0 + ancho)])
            subregiones.append({"forma": "rect", "x": x0 / REJILLA_ANCHO,
                                "y": f * alto / REJILLA_ALTO, "w": ancho / REJILLA_ANCHO,
                                "h": alto / REJILLA_ALTO})
        yield (areas,
               {"forma": "rect", "x": 0, "y": f * alto / REJILLA_ALTO,
                "w": 1, "h": alto / REJILLA_ALTO},
               subregiones)


RECORRIDOS_ACORDES = {
    "acordes_columnas": recorrido_columnas_acordes,
    "acordes_latitudes": recorrido_latitudes_acordes,
}


def resumir_zona(indices, colores, bordes):
    """Color promedio, textura promedio y posición izquierda/derecha de una zona."""
    n = len(indices)
    r = sum(colores[i][0] for i in indices) / n
    g = sum(colores[i][1] for i in indices) / n
    b = sum(colores[i][2] for i in indices) / n
    # Centroide horizontal ponderado por brillo: dónde "pesa" más la zona
    pesos = [luminancia(colores[i]) + 0.05 for i in indices]
    cx = sum(p * ((i % REJILLA_ANCHO) + 0.5) / REJILLA_ANCHO
             for p, i in zip(pesos, indices)) / sum(pesos)
    return {
        "color": (round(r), round(g), round(b)),
        "textura": sum(bordes[i] for i in indices) / n / 255,
        "pan": max(-1.0, min(1.0, 2 * cx - 1)),  # -1 izquierda, +1 derecha
    }


def zonas_a_notas(zonas, textura):
    """
    Convierte cada zona en una nota de la escala pentatónica:
      - brillo      -> altura (más claro = más agudo)
      - saturación  -> volumen (colores intensos = más fuerte)
      - posición    -> paneo izquierda/derecha
      - textura     -> ritmo (opcional): detalle = notas rápidas + percusión, liso = nota larga
    """
    escala = notas_pentatonicas()
    brillos = [luminancia(z["color"]) for z in zonas]
    # Estira el contraste para que la melodía use todo el rango de la escala
    minimo, maximo = min(brillos), max(brillos)
    rango = maximo - minimo if maximo - minimo > 0.05 else 1.0

    # La textura se mide contra la zona con más detalle de la imagen, con un mínimo
    # (TEXTURA_REFERENCIA) para que una imagen casi lisa no suene como si tuviera detalle.
    referencia = max(max(z["textura"] for z in zonas), TEXTURA_REFERENCIA)

    pasos = []
    for zona, brillo in zip(zonas, brillos):
        r, g, b = zona["color"]
        _, saturacion, _ = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        nombre, frecuencia = escala[round((brillo - minimo) / rango * (len(escala) - 1))]
        paso = {
            "nota": nombre,
            "frecuencia": round(frecuencia, 2),
            "volumen": round(0.35 + 0.65 * saturacion, 2),
            "color": f"#{r:02x}{g:02x}{b:02x}",
            "pan": round(zona["pan"], 2),
            "region": zona["region"],
        }
        if textura:
            paso.update(ritmo_por_textura(zona["textura"] / referencia))
        pasos.append(paso)
    return pasos


def ritmo_por_textura(t):
    """Textura relativa (0 = lisa, 1 = la zona más detallada) -> golpes por paso y percusión."""
    return {
        "textura": round(t, 2),
        "golpes": 1 if t < 1 / 3 else 2 if t < 2 / 3 else 4,
        "percusion": t >= 2 / 3,
    }


def zonas_a_acordes(pasos_areas, colores, bordes, textura):
    """
    Cada paso es una franja con 4 áreas que suenan juntas (un acorde pentatónico):
      - color cálido/frío -> altura dentro del rango del área (más cálido = más grave)
      - brillo            -> volumen (las zonas oscuras casi no suenan)
      - posición          -> paneo izquierda/derecha de cada nota
      - textura           -> ritmo del acorde completo (opcional)
    """
    rangos = [notas_de_octava(octava) for octava in RANGOS_AREAS]
    franjas = []
    for areas, region, subregiones in pasos_areas:
        zonas = [resumir_zona(indices, colores, bordes) for indices in areas]
        franja_textura = sum(z["textura"] for z in zonas) / len(zonas)
        franjas.append((zonas, region, subregiones, franja_textura))

    referencia = max(max(f[3] for f in franjas), TEXTURA_REFERENCIA)

    pasos = []
    for zonas, region, subregiones, franja_textura in franjas:
        notas = []
        for k, zona in enumerate(zonas):
            escala = rangos[k]
            frialdad = (1 - calidez(zona["color"])) / 2           # 0 = muy cálido, 1 = muy frío
            nombre, frecuencia = escala[round(frialdad * (len(escala) - 1))]
            r, g, b = zona["color"]
            notas.append({
                "area": k + 1,
                "nota": nombre,
                "frecuencia": round(frecuencia, 2),
                "volumen": round(0.1 + 0.9 * luminancia(zona["color"]), 2),
                "color": f"#{r:02x}{g:02x}{b:02x}",
                "pan": round(zona["pan"], 2),
            })
        paso = {"notas": notas, "region": region, "subregiones": subregiones}
        if textura:
            paso.update(ritmo_por_textura(franja_textura / referencia))
        pasos.append(paso)
    return pasos


def espectrograma(img, columnas=96, filas=48, f_min=110.0, f_max=3520.0):
    """
    La imagen como espectrograma: de izquierda a derecha, cada fila es una frecuencia
    exacta (escala logarítmica, arriba agudo y abajo grave) y su brillo es el volumen.
    """
    gris = list(img.convert("L").resize((columnas, filas), Image.Resampling.BOX).getdata())
    # frecuencias[k]: k = 0 es la fila de abajo (la más grave)
    frecuencias = [f_min * (f_max / f_min) ** (k / (filas - 1)) for k in range(filas)]
    pasos = []
    for x in range(columnas):
        valores = [gris[(filas - 1 - k) * columnas + x] / 255 for k in range(filas)]
        dominante = max(range(filas), key=lambda k: valores[k])
        pasos.append({
            "valores": [round(v, 3) for v in valores],
            "dominante": round(frecuencias[dominante]),
            "pan": round(2 * (x + 0.5) / columnas - 1, 2),
            "region": {"forma": "rect", "x": x / columnas, "y": 0, "w": 1 / columnas, "h": 1},
        })
    return {
        "tipo": "espectrograma",
        "modo": "espectrograma",
        "duracion_nota": 0.125,
        "frecuencias": [round(f, 2) for f in frecuencias],
        "pasos": pasos,
    }


def sonificar(ruta_imagen, modo="columnas", textura=False):
    img = abrir_imagen(ruta_imagen)
    if modo == "espectrograma":
        return espectrograma(img)

    colores, bordes = rejilla(img)
    duracion = DURACION_NOTA_TEXTURA if textura else DURACION_NOTA

    if modo in RECORRIDOS_ACORDES:
        return {
            "tipo": "acordes",
            "modo": modo,
            "escala": "Major pentatonic (C, D, E, G, A), 4 areas: C3-C4, C4-C5, C4-C5, C5-C6",
            "textura": textura,
            "duracion_nota": duracion,
            "pasos": zonas_a_acordes(RECORRIDOS_ACORDES[modo](), colores, bordes, textura),
        }

    zonas = [{**resumir_zona(indices, colores, bordes), "region": region}
             for indices, region in RECORRIDOS[modo]()]
    return {
        "tipo": "notas",
        "modo": modo,
        "escala": "Major pentatonic (C, D, E, G, A)",
        "textura": textura,
        "duracion_nota": duracion,
        "pasos": zonas_a_notas(zonas, textura),
    }


# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------
@app.route("/")
def Inicio():
    return render_template("index.html")


@app.route("/about")
def about():
    # La foto del equipo se pone en static/equipo/ con el nombre "equipo" (jpg, jpeg, png o webp)
    carpeta = BASE_DIR / "static" / "equipo"
    foto = next((f"equipo/equipo.{ext}" for ext in ("jpg", "jpeg", "png", "webp")
                 if (carpeta / f"equipo.{ext}").exists()), None)
    return render_template("about.html",
                           foto_equipo=url_for("static", filename=foto) if foto else None)


@app.route("/playlist")
def playlist():
    imagenes = [con_url(i) for i in leer_config()]
    return render_template("Jukebox.html", imagenes=imagenes,
                           seleccionada=request.args.get("imagen"))


@app.route("/api/sonificar/<imagen_id>")
def api_sonificar(imagen_id):
    imagen = buscar_imagen(imagen_id)
    if imagen is None:
        abort(404)
    ruta = Path(app.config["UPLOAD_FOLDER"]) / imagen["archivo"]
    if not ruta.exists():
        abort(404)
    modo = request.args.get("modo", "columnas")
    if modo not in MODOS:
        abort(400)
    textura = request.args.get("textura") == "1"
    return jsonify(sonificar(ruta, modo, textura))


@app.route("/cargar-imagen", methods=["GET", "POST"])
def cargar_imagen():
    datos = {"titulo": "", "ubicacion": "", "descripcion": ""}
    errores = {}

    if request.method == "POST":
        datos = {campo: request.form.get(campo, "").strip() for campo in datos}
        archivo = request.files.get("imagen")

        if not datos["titulo"]:
            errores["titulo"] = "Enter a title."
        elif any(i["titulo"].lower() == datos["titulo"].lower() for i in leer_config()):
            errores["titulo"] = "An image with that title already exists."
        if not datos["ubicacion"]:
            errores["ubicacion"] = "Enter the location."
        if not datos["descripcion"]:
            errores["descripcion"] = "Enter a description."

        extension = ""
        if not archivo or not archivo.filename:
            errores["imagen"] = "Select an image from your computer."
        else:
            extension = archivo.filename.rsplit(".", 1)[-1].lower() if "." in archivo.filename else ""
            if extension not in EXTENSIONES_PERMITIDAS:
                errores["imagen"] = "Format not allowed. Use PNG, JPG, GIF, WEBP or BMP."
            else:
                try:
                    with Image.open(archivo.stream) as img:
                        img.verify()
                    archivo.stream.seek(0)
                except (UnidentifiedImageError, OSError):
                    errores["imagen"] = "The file is not a valid image."

        if not errores:
            imagen_id = uuid.uuid4().hex[:8]
            nombre_seguro = secure_filename(archivo.filename.rsplit(".", 1)[0]) or "imagen"
            nombre_archivo = f"{imagen_id}_{nombre_seguro}.{extension}"
            carpeta = Path(app.config["UPLOAD_FOLDER"])
            carpeta.mkdir(parents=True, exist_ok=True)
            archivo.save(carpeta / nombre_archivo)

            imagenes = leer_config()
            imagenes.append({"id": imagen_id, **datos, "archivo": nombre_archivo})
            guardar_config(imagenes)

            flash(f"“{datos['titulo']}” was added to the playlist.", "success")
            return redirect(url_for("playlist", imagen=imagen_id))

    return render_template("cargar_imagen.html", datos=datos, errores=errores)


@app.errorhandler(413)
def archivo_muy_grande(_error):
    flash("The image is too large (10 MB maximum).", "danger")
    return redirect(url_for("cargar_imagen"))


if __name__ == "__main__":
    app.run(debug=True)
