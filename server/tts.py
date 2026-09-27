"""Text-to-speech backends. Each returns (float32 mono samples, sample_rate)."""
from __future__ import annotations

import io
import json
import re
import wave
from pathlib import Path

import numpy as np

# Kokoro voice ids start with a language/accent prefix: a=American, b=British.
VOICES = [
    {"id": "af_heart", "accent": "American", "label": "Heart (F)"},
    {"id": "af_bella", "accent": "American", "label": "Bella (F)"},
    {"id": "af_nicole", "accent": "American", "label": "Nicole (F)"},
    {"id": "am_michael", "accent": "American", "label": "Michael (M)"},
    {"id": "am_fenrir", "accent": "American", "label": "Fenrir (M)"},
    {"id": "am_puck", "accent": "American", "label": "Puck (M)"},
    {"id": "bf_emma", "accent": "British", "label": "Emma (F)"},
    {"id": "bf_isabella", "accent": "British", "label": "Isabella (F)"},
    {"id": "bm_george", "accent": "British", "label": "George (M)"},
    {"id": "bm_fable", "accent": "British", "label": "Fable (M)"},
    {"id": "bm_lewis", "accent": "British", "label": "Lewis (M)"},
]

PRON_FILE = Path(__file__).parent / "pronunciations.json"


def apply_pronunciations(text: str) -> str:
    """Swap tech terms TTS tends to mangle ('kubectl' -> 'cube control')."""
    if not PRON_FILE.exists():
        return text
    table = {k: v for k, v in json.loads(PRON_FILE.read_text()).items() if not k.startswith("_")}
    for term, spoken in sorted(table.items(), key=lambda kv: -len(kv[0])):  # longest first
        text = re.sub(rf"(?<![\w.]){re.escape(term)}(?![\w])", spoken, text)
    return text


class KokoroTTS:
    name = "kokoro"
    sample_rate = 24000

    def __init__(self):
        from kokoro import KPipeline  # imported lazily so the mock works without it

        self._KPipeline = KPipeline
        self._pipes: dict = {}

    def synth(self, text: str, voice: str, speed: float = 1.0):
        lang = voice[0]
        if lang not in self._pipes:
            self._pipes[lang] = self._KPipeline(lang_code=lang)
        chunks = [a.numpy() if hasattr(a, "numpy") else np.asarray(a)
                  for _, _, a in self._pipes[lang](text, voice=voice, speed=speed) if a is not None]
        audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
        return audio.astype(np.float32), self.sample_rate


class MockTTS:
    """Beeps instead of speech. Lets you test sync without downloading models."""

    name = "mock"
    sample_rate = 24000

    def synth(self, text: str, voice: str, speed: float = 1.0):
        n_words = max(1, len(text.split()))
        per_word = 0.32 / speed
        t = np.arange(int(self.sample_rate * per_word)) / self.sample_rate
        pitch = 330 if voice.startswith("a") else 440
        beep = 0.2 * np.sin(2 * np.pi * pitch * t) * np.hanning(len(t))
        gap = np.zeros(int(self.sample_rate * 0.05))
        audio = np.concatenate([np.concatenate([beep, gap]) for _ in range(n_words)])
        return audio.astype(np.float32), self.sample_rate


def to_wav(audio: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()
