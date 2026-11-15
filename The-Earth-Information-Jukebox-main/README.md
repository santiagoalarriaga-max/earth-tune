# Earth Sonification Jukebox

**Listening to the planet: Earth observation data turned into music.**

A project for the NASA Space Apps Challenge 2026 · Challenge: The Earth Information Jukebox*

### The Idea
---
Information about the state of our planet (drought maps, temperature anomalies, time series, satellite imagery) is communicated almost exclusively through images, and that leaves many people out.

The Earth Sonification Jukebox turns Earth data visualizations into sound synchronized with the image. This opens a second channel of access to the information: the ear.
---

## Why does it matter?
- The World Health Organization estimates that at least 2.2 billion people worldwide live with some form of vision impairment or blindness.
- In Mexico, the 2020 Population and Housing Census counted 6,179,890 people with disabilities (4.9% of the population). According to INEGI (Mexico's national statistics institute), about 44% of them have difficulty seeing.
- For these people, most maps, charts and satellite images about climate and the environment are currently inaccessible.

### Background of sonification

NASA has already explored this path through its Universe of Sound program, which translates data from space telescopes into sound. A study published in 2024 in Frontiers in Communication surveyed 3,184 people, both sighted and blind or low-vision, and found:

- Significant gains in self-reported learning.
- Positive responses regarding enjoyment of the experience.
- That engaging multiple senses builds trust in scientific data, broadens access, and raises awareness of accessibility among both sighted audiences and people who are blind or have low vision.

### Other benefits
- Risk communication: a sound that grows more tense as a drought worsens or an anomaly increases can be understood without interpreting a chart or a color scale.
- Education: hearing decades of data in a few seconds leaves a more lasting impression than a table of numbers.
- Emotional connection: environmental change stops being an abstract number and becomes something you can perceive.

## What does the application do?

| Section | Description |
|---|---|
| **Home** (`/`) | Present the project and how to use it |
| **Upload image** (`/cargar-image`) | To add a new image in format (PNG, JPG, GIF, WEBP, BMP) and the size (max. 10 MB). |
| **Playlist** (`/playlist`) | The jukebox: Choose and image, then the way to "listen" the image and you can active the voice. |
| **About us** (`/about`) | Presentation of the team. |

### How to change the image to sound?
The server reduces each image to a 96 × 64 grid, measures the color, brightness and texture of each area, and turns them into notes of the major pentatonic scale (C, D, E, G, A). We chose this scale because it almost never sounds dissonant, so any image produces a pleasant melody.

**Seven playback modes:**

| # | Mode | Path through the image |
|---|---|---|
| 1 | Columns | Left to right |
| 2 | Latitudes | Top to bottom, strip by strip |
| 3 | Radar | Rings from the center outward |
| 4 | Spiral | Areas in a spiral from the center |
| 5 | Spectrogram | Each row is an exact frequency (top = high, bottom = low) and brightness is volume |
| 6 | Chords by column | Columns left to right, each split into 4 areas that play together |
| 7 | Chords by latitude | Strips bottom to top, each split into 4 areas that play together |

**What represent each sound?**

| Note mode (1–4) | Chord modes (6–7) |
|---|---|
| **Brightness:** lighter = higher | **Warm/cool color:** warmer = lower |
| **Saturation:** Intense colors = louder | **Brightness -> volumen:** dark areas barely audible |
| **Position:** (optional) | **Each area → its own octave** (C3 to C6) |
| **Texture/rythm** (optional): areas with details = fast notes and percussion; smooth areas = long notes | **Texture/rythm:** of the whole chord (optional) |

### Accesibility

The jukebox can be used entirely with the keyboard alone and includes:
- Voice guide (the browser's speech synthesis) that describes the image, the mode and how to listen to it.
- Screen reader announcements through an aria-live region.
- High-contrast view that hides purely visual elements and enlarges text.
- Interface sounds that confirm each action (play, change image, change view).

| Key | Action |
|---|---|
| `Espacio` | Play / pause |
| `←` `→` | Previous / next Image |
| `1`–`7` | Choose playback mode |
| `R` | Next mode |
| `G` | Repete the listening guide |
| `T` | Activate/Desactivate texture |
| `E` | Active/Desactivate right/left sound|
| `V` | Activate/Desactivate sound |
| `B` | Hide/show sound bars |
| `M` | Normal/ high-contrast view |

## Included images

The playlist included 5 global NASA visualization

1. GEOS-FP Near-Surface Humidity
2. GEOS-FP Near-Surface Temperature
3. Near Surface Ozone (O₃)
4. GEOS-FP Precipitation and Clouds
5. Global Sea Surface Currents and Temperature

<!-- Agregar aquí el enlace a la fuente original de cada visualización (NASA SVS / Earth Information Center). -->

## Instalation and usage

Requirements: **Python 3.10 or superior**.

```bash
# 1. Clonar el repositorio
git clone https://github.com/axealbert/The-Earth-Information-Jukebox.git
cd The-Earth-Information-Jukebox

# 2. Crear y activar un entorno virtual
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# 3. Instalar dependencias (Flask y Pillow)
pip install -r requirements.txt

# 4. Ejecutar
python app.py
```

Open **http://127.0.0.1:5000** in your browser. Headphones are recommended for the best experience.

### ADDING IMAGES

- From the app: go to Upload image, fill in the form, and the image will appear in the playlist.
- Manually: copy the image to static/Imagenes/ and add its entry (id, titulo, ubicacion, descripcion, archivo) to config/imagenes.json.

To show the team photo on About us, save it as static/equipo/equipo.jpg (.jpeg, .png and .webp also work).

## Project Architecture

```
The-Earth-Information-Jukebox/
├── app.py                  # Flask server: routes, image upload and sonification
├── requirements.txt        # Dependencies (Flask, Pillow)
├── config/
│   └── imagenes.json       # Title, location, description and file of each image
├── static/
│   ├── Imagenes/           # Playlist visualizations
│   ├── Sonidos/            # Interface sounds
│   └── js/app.js           # Player: audio (Web Audio API), voice, keyboard and visualizer
└── templates/              # HTML pages (Jinja2 + Bootstrap 5)
    ├── base.html
    ├── index.html
    ├── Jukebox.html
    ├── cargar_imagen.html
    └── about.html
```

Tech stack: Python · Flask · Pillow · JavaScript · Web Audio API · Web Speech API · Bootstrap 5

## Sonifying an image

The impact grows when sonification is grounded in a specific place and problem, rather than staying at global averages:

- Sonify variables such as precipitation, soil moisture or vegetation indices for a watershed or farming region, so people can hear how a drought developed year after year.
- Real users: farmers, watershed agencies, civil protection, schools and community radio stations.
- Lightweight formats: export audio clips that can be shared through messaging apps or radio in places with poor connectivity or no large screens.
- Audible drought alerts for farming regions and versions in Indigenous languages.

> *“We make water and climate data audible, so no one is left out of the information that affects their lives and livelihoods.”*

## Design principles

- Scientific honesty: every sound has an explicit meaning that the app explains on screen and by voice. Nothing is a decorative effect.
- Real accessibility: full keyboard navigation, screen reader support and a lightweight interface.
- Design with people, not just for them: the Universe of Sound team stresses that their work is done in partnership with the blind and low-vision community. We plan to test the prototype with users and incorporate their feedback.

## Team

Salvador Bernal · Santiago Arriaga · Eugenio Ramírez · Alejandro Áviles · Axel Alberto · Petr Skorev

## References

1. World Health Organization (2019). World report on vision. https://www.who.int/news/item/08-10-2019-who-launches-first-world-report-on-vision
2. CNDH (2022). Violencia contra personas con discapacidad [Violence against people with disabilities] (2020 Census data). https://www.cndh.org.mx/sites/default/files/documentos/2022-02/Violencia_Personas_Discapacidad_1.pdf
3. Milenio. Ceguera, una condición que discrimina y excluye [Blindness, a condition that discriminates and excludes] (INEGI data). https://www.milenio.com/ciencia-y-salud/ceguera-una-condicion-que-discrimina-y-excluye
4. Arcand, K. K. et al. (2024). A Universe of Sound: processing NASA data into sonifications to explore participant response. Frontiers in Communication. https://www.frontiersin.org/journals/communication/articles/10.3389/fcomm.2024.1288896/text
5. EurekAlert (2024). A Universe of Sound. https://www.eurekalert.org/news-releases/1038837

---

*Prototype developed during the NASA Space Apps Challenge 2026. Not an official NASA product. The visualizations used come from NASA.*
