"""Local companion server for the Accent Re-dub extension.

Run:  python app.py            (Kokoro voices)
      REDUB_TTS=mock python app.py   (beeps, no model download - for testing sync)
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import sources
from segmenter import cues_to_words, words_to_segments
from tts import VOICES, KokoroTTS, MockTTS, apply_pronunciations, to_wav

PORT = int(os.environ.get("REDUB_PORT", "8765"))
WHISPER_MODEL = os.environ.get("REDUB_WHISPER_MODEL", "small.en")
CACHE = sources.CACHE

app = FastAPI(title="Accent Re-dub")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_tts = None
_tts_lock = threading.Lock()  # Kokoro isn't thread-safe; synthesize one clip at a time


def tts():
    global _tts
    if _tts is None:
        _tts = MockTTS() if os.environ.get("REDUB_TTS") == "mock" else KokoroTTS()
    return _tts


# ---------- transcript jobs (can take minutes when Whisper runs) ----------

class JobRequest(BaseModel):
    url: str
    cues: list[dict] | None = None          # captions the extension read from the page
    mode: str = "auto"                      # auto | captions | whisper
    whisper_model: str | None = None


JOBS: dict[str, dict] = {}


def _cache_path(req: JobRequest):
    key = hashlib.sha1(f"{req.url}|{req.mode}".encode()).hexdigest()[:16]
    return CACHE / "transcripts" / f"{key}.json"


def _run_job(job_id: str, req: JobRequest):
    job = JOBS[job_id]

    def progress(p: float, msg: str):
        job.update(progress=round(p, 3), message=msg)

    try:
        path = _cache_path(req)
        if path.exists() and not req.cues:
            job.update(json.loads(path.read_text()), status="done", progress=1, message="Loaded from cache")
            return

        segments, source = None, None
        if req.mode in ("auto", "captions"):
            if req.cues:
                segments, source = words_to_segments(cues_to_words(req.cues)), "page captions"
            else:
                try:
                    segments, source = sources.fetch_captions(req.url, progress), "captions"
                except Exception as e:  # site not supported by yt-dlp, etc.
                    if req.mode == "captions":
                        raise
                    progress(0.05, f"No captions ({type(e).__name__}); falling back to Whisper")
        if not segments:
            if req.mode == "captions":
                raise RuntimeError("No English captions found")
            audio = sources.download_audio(req.url, progress)
            segments = sources.transcribe(audio, req.whisper_model or WHISPER_MODEL, progress)
            source = "whisper"

        result = {"source": source, "segments": segments}
        if not req.cues:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(result))
        job.update(result, status="done", progress=1, message=f"{len(segments)} segments from {source}")
    except Exception as e:
        job.update(status="error", message=f"{type(e).__name__}: {e}")


@app.post("/jobs")
def create_job(req: JobRequest):
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"id": job_id, "status": "running", "progress": 0, "message": "Starting", "created": time.time()}
    threading.Thread(target=_run_job, args=(job_id, req), daemon=True).start()
    return JOBS[job_id]


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "Unknown job")
    return JOBS[job_id]


# ---------- speech ----------

class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.post("/tts")
def synthesize(req: TTSRequest):
    text = apply_pronunciations(req.text)
    key = hashlib.sha1(f"{tts().name}|{req.voice}|{req.speed}|{text}".encode()).hexdigest()
    path = CACHE / "tts" / f"{key}.wav"
    if path.exists():
        wav = path.read_bytes()
    else:
        with _tts_lock:
            audio, sr = tts().synth(text, req.voice, req.speed)
        wav = to_wav(audio, sr)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(wav)
    duration = (len(wav) - 44) / 2 / 24000
    return {"audio_b64": base64.b64encode(wav).decode(), "duration": round(duration, 3)}


@app.get("/voices")
def voices():
    return {"backend": tts().name, "voices": VOICES}


@app.get("/health")
def health():
    return {"ok": True, "tts": os.environ.get("REDUB_TTS", "kokoro"), "whisper_model": WHISPER_MODEL}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("REDUB_HOST", "127.0.0.1"), port=PORT)
