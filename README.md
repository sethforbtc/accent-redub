# Accent Re-dub

Re-voice technical tutorial videos in the English accent that's easiest for **you** to follow.

Much of the best tutorial content comes from speakers whose accent you may not be used to. Decoding an unfamiliar accent takes real mental effort, and that's effort not spent on the material. Accent Re-dub mutes the original speaker and plays the same words in a clear American or British English voice, in sync with the video.

Everything runs **locally and for free**: no cloud APIs, no accounts, no usage costs.

## How it works

It has two parts that run on the same computer:

| Part | What it is | What it does |
|---|---|---|
| **Server** (`server/`) | A small Python program you leave running in a terminal window | Gets the transcript and generates the new voice |
| **Extension** (`extension/`) | A Chrome extension | Mutes the video and plays the new voice in sync |

**Where the words come from:**
1. **Captions:** YouTube captions (human-written first, then auto-generated), or captions built into other video players. These are fast, and the video starts in seconds.
2. **Whisper:** If there are no captions, the audio is downloaded and transcribed locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper). This is slower the first time, and results are cached.

Captions are rebuilt into full sentences before they're spoken. Auto-captions have no punctuation and break mid-sentence, so this step makes the voice sound natural. The voice comes from [Kokoro](https://github.com/hexgrad/kokoro), a small, high-quality text-to-speech model.

**Staying in sync:** Each sentence plays when the video reaches the point where the original speaker said it. If the new voice runs longer, it's sped up slightly to fit, and pitch stays natural. Pause, seek and playback-speed changes are followed automatically.

## Requirements

- Windows, macOS or Linux
- Google Chrome, or another Chromium browser such as Edge or Brave
- Python **3.10, 3.11 or 3.12** (3.13 isn't supported by the voice model yet)
- About 3 GB of disk space for Python packages and models
- A GPU is optional. It only speeds up Whisper transcription.

## Installation

The examples below assume you put the project in `C:\accent-redub`. Use any folder you like, and adjust the paths to match.

### 1. Download the project

Click **Code → Download ZIP** on this page and unzip it, or clone it:
```
git clone https://github.com/<your-username>/accent-redub.git
```

The folder layout:
```
accent-redub\
├── extension\      ← loaded into Chrome (step 4)
└── server\         ← where you run the commands below
```

### 2. Install Python

Python installs like any other program, into its own system location, **not** into the project folder.

**Windows:** open **Command Prompt** (Start menu → type `cmd`) and run:
```
winget install -e --id Python.Python.3.12
```
Then **close Command Prompt and open a new one** so Windows picks up the install.

**macOS:** `brew install python@3.12`, or use the installer from [python.org](https://www.python.org/downloads/).

*Optional:* install [espeak-ng](https://github.com/espeak-ng/espeak-ng/releases). It helps the voice pronounce unusual words. On macOS: `brew install espeak-ng`.

### 3. Set up the server (one time)

This creates a private Python environment (a `.venv` folder) **inside `server\`**, so nothing is installed system-wide.

**Windows (use Command Prompt, not PowerShell).** PowerShell blocks the `activate` script by default.
```
cd C:\accent-redub\server
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

**macOS / Linux:**
```
cd ~/accent-redub/server
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

After `activate`, your prompt starts with `(.venv)`.

The `pip install` step takes **5–15 minutes**. It downloads large packages like PyTorch. The cursor may sit blinking for a long time. That's normal, so don't close the window. It's finished when you see `Successfully installed ...` and a fresh prompt.

### 4. Load the extension (one time)

1. In Chrome, go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the **`extension`** folder. Select that folder itself, not the project folder above it.
4. Click the puzzle-piece icon in the toolbar and pin **Accent Re-dub**.

## Daily use

**1. Start the server.** Open a terminal and run:

Windows:
```
cd C:\accent-redub\server
.venv\Scripts\activate
python app.py
```
macOS / Linux:
```
cd ~/accent-redub/server
source .venv/bin/activate
python app.py
```
Wait for `Uvicorn running on http://127.0.0.1:8765`, then **leave the window open** while you watch. Close it when you're done.

**2. Re-dub a video.** Open a video, click the Accent Re-dub icon, pick a voice, and click **Re-dub this video**. A badge on the video shows progress.

The very first time, the video waits on **"Buffering voice…"** for a few minutes while the voice model (about 330 MB) downloads. After that it starts in seconds.

### Popup settings

| Setting | What it does |
|---|---|
| **Voice** | American or British English, several male and female voices |
| **Transcript source** | Captions first with Whisper as backup (default), captions only, or always Whisper |
| **Max catch-up speed** | How much a sentence may be sped up to keep pace with the video |
| **Voice volume** | Volume of the new voice |
| **Show dubbed sentence** | Displays the sentence being spoken over the video |
| **Pause video while voice buffers** | Waits for the voice rather than letting it fall behind |

## Fixing tech-word pronunciation

Voices tend to mangle terms like `kubectl` or `PySpark`. Edit `server/pronunciations.json` to control how words are spoken:
```json
{
  "kubectl": "cube control",
  "SQL": "sequel"
}
```
Matches are whole-word and case-sensitive. Restart the server after editing. Delete any entry you'd say differently, such as `"SQL"` if you say "S-Q-L".

## Server options

The easiest way to change settings is a **`.env` file** in the `server` folder. It isn't uploaded to GitHub, so personal paths stay on your machine.

1. In `server`, copy `.env.example` to `.env`. On Windows: `copy .env.example .env`
2. Open it (`notepad .env`), remove the `#` in front of the lines you want, and edit the values.
3. Restart the server.

For example, to use a Whisper model you've already downloaded, rather than letting it download one:
```
REDUB_WHISPER_MODEL=C:\Models\faster-whisper-small
REDUB_WHISPER_DEVICE=cpu
REDUB_WHISPER_COMPUTE=int8
```
When `REDUB_WHISPER_MODEL` points to a folder, the model loads from that folder only and never goes online.

You can also set these as ordinary environment variables, which take priority over `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `REDUB_WHISPER_MODEL` | `small.en` | A model name (`base.en` is faster; `medium.en` or `large-v3` are more accurate), or the path to a model folder you downloaded |
| `REDUB_WHISPER_DEVICE` | `auto` | `cpu`, or `cuda` to use an NVIDIA GPU |
| `REDUB_WHISPER_COMPUTE` | `int8` on CPU, `float16` on GPU | Precision; `int8` is fastest on CPU |
| `REDUB_COOKIES_BROWSER` | *(none)* | e.g. `chrome`, which lets yt-dlp use your sign-in on course sites |
| `REDUB_PORT` | `8765` | Port the server listens on |
| `REDUB_HOST` | `127.0.0.1` | `0.0.0.0` to serve other machines on your network |
| `REDUB_TTS` | `kokoro` | `mock` plays beeps instead of speech, for testing without models |
| `REDUB_CACHE` | `server/cache` | Where transcripts, audio and voice clips are cached |

**Running the server on another machine** (for example, a home server with a GPU): start it there with `REDUB_HOST=0.0.0.0`, then open the extension popup → **Advanced → Server URL** and enter that machine's address, e.g. `http://192.168.1.50:8765`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Popup says **Local server offline** | The server window isn't running. Start it (see Daily use). |
| `'python' is not recognized` | Open a new Command Prompt after installing Python, or use `py -3.12` in place of `python`. |
| `activate` fails with a script error | You're in PowerShell. Use Command Prompt instead. |
| Stuck on **Buffering voice…** the first time | The voice model is downloading. Watch the server window for progress. |
| **No captions** / Whisper fails on a course site | The site may need your sign-in (set `REDUB_COOKIES_BROWSER`), or its video is DRM-protected. See limitations. |
| A word is pronounced wrong | Add it to `server/pronunciations.json`. |

## Limitations

- **Accents:** only **American and British English** are available so far, which is what Kokoro supports. Other accents (Australian, Indian, etc.) need a different voice model. `server/tts.py` has a small backend interface for adding one.
- **Delivery:** The speaker's emphasis and emotion aren't carried over. The voice reads the transcript evenly.
- **Protected streams:** DRM-protected course players that don't expose captions aren't supported yet. Capturing tab audio for live transcription is the planned fix.
- **One tab at a time:** Only one tab can be re-dubbed at once.
- **YouTube ads** aren't detected.

## Project layout

```
server/
  app.py               API: /jobs (transcripts), /tts (voice), /voices, /health
  settings.py          Loads your personal settings from .env
  .env.example         Template for .env
  sources.py           Caption download (yt-dlp) and transcription (faster-whisper)
  segmenter.py         Turns captions/words into clean sentences
  tts.py               Voice backends (Kokoro, mock) and pronunciation fixes
  pronunciations.json  Tech-term pronunciation list
  requirements.txt
extension/
  manifest.json        Chrome extension definition
  popup.html/.js       Settings and start/stop
  content.js           Finds the video, keeps the voice in sync, shows the badge
  offscreen.js         Fetches and plays voice clips
  background.js        Relays requests to the local server
  defaults.js          Default settings
```

## Acknowledgements

Built on [Kokoro](https://github.com/hexgrad/kokoro), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FastAPI](https://fastapi.tiangolo.com/).

## License

[MIT](LICENSE)
