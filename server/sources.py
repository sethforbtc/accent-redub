"""Where the words come from.

Approach 1: existing captions (sent by the extension, or pulled with yt-dlp).
Approach 2: local speech recognition with faster-whisper on downloaded audio.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

from segmenter import Word, clean, cues_to_words, dedupe_rollover, words_to_segments

Progress = Callable[[float, str], None]
CACHE = Path(os.environ.get("REDUB_CACHE", Path(__file__).parent / "cache"))
ENGLISH = ["en", "en-US", "en-GB", "en-orig"]


def _ydl_opts(**extra) -> dict:
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    browser = os.environ.get("REDUB_COOKIES_BROWSER")  # e.g. "chrome" for signed-in course sites
    if browser:
        opts["cookiesfrombrowser"] = (browser,)
    opts.update(extra)
    return opts


# ---------- approach 1: captions ----------

def parse_json3(data: dict) -> list[Word]:
    """YouTube json3 captions. Auto-captions carry per-word offsets."""
    words: list[Word] = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        base = ev.get("tStartMs", 0) / 1000
        dur = ev.get("dDurationMs", 0) / 1000
        timed = [s for s in segs if clean(s.get("utf8", ""))]
        if not timed:
            continue
        if len(timed) > 1 and any("tOffsetMs" in s for s in timed):
            for i, s in enumerate(timed):
                st = base + s.get("tOffsetMs", 0) / 1000
                nx = base + timed[i + 1].get("tOffsetMs", 0) / 1000 if i + 1 < len(timed) else base + dur
                for tok in clean(s["utf8"]).split():
                    words.append(Word(st, max(nx, st + 0.1), tok))
        else:
            text = " ".join(clean(s["utf8"]) for s in timed)
            words.extend(cues_to_words([{"start": base, "end": base + dur, "text": text}]))
    words.sort(key=lambda w: w.start)
    return dedupe_rollover(words)


def fetch_captions(url: str, progress: Progress) -> list[dict] | None:
    import yt_dlp

    progress(0.05, "Looking for captions")
    with yt_dlp.YoutubeDL(_ydl_opts(skip_download=True)) as ydl:
        info = ydl.extract_info(url, download=False)
        # Prefer human-written captions, then auto-generated ones.
        for pool in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
            for lang in ENGLISH:
                tracks = pool.get(lang) or []
                j3 = next((t for t in tracks if t.get("ext") == "json3"), None)
                if not j3:
                    continue
                progress(0.3, f"Downloading {lang} captions")
                raw = ydl.urlopen(j3["url"]).read().decode("utf-8")
                words = parse_json3(json.loads(raw))
                if words:
                    return words_to_segments(words)
    return None


# ---------- approach 2: speech recognition ----------

_whisper_models: dict = {}


def _whisper(model_name: str):
    if model_name not in _whisper_models:
        from faster_whisper import WhisperModel

        device = os.environ.get("REDUB_WHISPER_DEVICE", "auto")
        compute = "int8" if device in ("cpu", "auto") else "float16"
        _whisper_models[model_name] = WhisperModel(model_name, device=device, compute_type=compute)
    return _whisper_models[model_name]


def download_audio(url: str, progress: Progress) -> Path:
    import yt_dlp

    out_dir = CACHE / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if d.get("status") == "downloading" and d.get("total_bytes"):
            progress(0.05 + 0.15 * d["downloaded_bytes"] / d["total_bytes"], "Downloading audio")

    opts = _ydl_opts(format="bestaudio/best", outtmpl=str(out_dir / "%(id)s.%(ext)s"), progress_hooks=[hook])
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return Path(ydl.prepare_filename(info))


def transcribe(audio: Path, model_name: str, progress: Progress) -> list[dict]:
    progress(0.2, f"Loading Whisper ({model_name})")
    model = _whisper(model_name)
    segments, info = model.transcribe(
        str(audio), language="en", word_timestamps=True, vad_filter=True, beam_size=5
    )
    words: list[Word] = []
    for seg in segments:  # generator: transcription happens as we iterate
        for w in seg.words or []:
            words.append(Word(w.start, w.end, w.word.strip()))
        if info.duration:
            pct = seg.end / info.duration
            progress(0.2 + 0.78 * pct, f"Transcribing {pct:.0%}")
    return words_to_segments(words)
