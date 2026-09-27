"""Turn caption cues or ASR words into sentence-sized segments for TTS.

Everything is reduced to a flat list of timed words first, then regrouped.
This fixes the two big problems with raw captions:
  * YouTube auto-captions have no punctuation and split mid-sentence.
  * Manual captions split sentences across cues at arbitrary points.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

NOISE = re.compile(r"\[(?:music|applause|laughter|inaudible|silence|noise)[^\]]*\]|>>|♪", re.I)
ABBREVIATIONS = {"e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "dr.", "approx.", "fig.", "no."}


@dataclass
class Word:
    start: float
    end: float
    text: str


def clean(text: str) -> str:
    text = NOISE.sub(" ", text.replace("\n", " "))
    return re.sub(r"\s+", " ", text).strip()


def cues_to_words(cues: list[dict]) -> list[Word]:
    """Spread each cue's words across its time span, weighted by length."""
    words: list[Word] = []
    for cue in sorted(cues, key=lambda c: float(c["start"])):
        text = clean(str(cue.get("text", "")))
        if not text:
            continue
        start, end = float(cue["start"]), float(cue["end"])
        if end <= start:
            end = start + 0.3 * max(1, len(text.split()))
        tokens = text.split()
        weights = [len(t) + 1 for t in tokens]
        total, t = sum(weights), start
        for tok, w in zip(tokens, weights):
            dur = (end - start) * w / total
            words.append(Word(t, t + dur, tok))
            t += dur
    return dedupe_rollover(words)


def dedupe_rollover(words: list[Word]) -> list[Word]:
    """Drop words repeated by overlapping 'roll-up' caption cues."""
    out: list[Word] = []
    for w in words:
        if out and w.text == out[-1].text and w.start < out[-1].end + 0.05:
            continue
        out.append(w)
    return out


def _ends_sentence(tok: str) -> bool:
    low = tok.lower()
    if low in ABBREVIATIONS:
        return False
    return bool(re.search(r"[.!?][\"')\]]*$", tok))


def words_to_segments(
    words: list[Word],
    pause_break: float = 0.7,
    soft_max_words: int = 28,
    hard_max_words: int = 40,
) -> list[dict]:
    segments: list[dict] = []
    cur: list[Word] = []

    def flush():
        if cur:
            segments.append({
                "start": round(cur[0].start, 3),
                "end": round(cur[-1].end, 3),
                "text": " ".join(w.text for w in cur),
            })
            cur.clear()

    for i, w in enumerate(words):
        if not w.text.strip():
            continue
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (nxt.start - w.end) if nxt else 0
        n = len(cur)
        if (
            (_ends_sentence(w.text) and n >= 3)
            or (gap >= pause_break and n >= 4)
            or (n >= soft_max_words and w.text.endswith((",", ";", ":")))
            or n >= hard_max_words
        ):
            flush()
    flush()
    return merge_tiny(segments)


def merge_tiny(segments: list[dict], min_words: int = 3, max_gap: float = 1.0) -> list[dict]:
    """Fold fragments like 'Okay.' into the neighbouring segment."""
    out: list[dict] = []
    for seg in segments:
        if out and len(seg["text"].split()) < min_words and seg["start"] - out[-1]["end"] <= max_gap:
            out[-1]["text"] += " " + seg["text"]
            out[-1]["end"] = seg["end"]
        else:
            out.append(dict(seg))
    return out
