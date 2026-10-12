"""
Official Azure Speech voice (the same Andrew neural voice the stream started with), used first in the voice chain.

- Key and region come from AZURE_SPEECH_KEY / AZURE_SPEECH_REGION (environment or backend/.env.local); never logged.
- A monthly character counter keeps the free F0 tier from ever being exceeded: once this month's count plus the next
  line would pass AZURE_SPEECH_MONTHLY_CHARS (default 450000 of the 500000 free), Azure is skipped and the offline
  voices (Kokoro, Piper, Windows) take over. The count lives in ~/.fillbook-tts/azure_usage.json and resets monthly.
- Word timings are estimated from the audio length (same method as the offline voices).
"""
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
from xml.sax.saxutils import escape

USAGE_DIR = os.path.join(os.path.expanduser("~"), ".fillbook-tts")
USAGE_FILE = os.path.join(USAGE_DIR, "azure_usage.json")
DEFAULT_MONTHLY_LIMIT = 450_000
_ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env.local")
_env_cache: dict = {}


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if not _env_cache:
        try:
            with open(_ENV_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
                    if m:
                        _env_cache[m.group(1)] = m.group(2).strip().strip('"').strip("'")
        except OSError:
            pass
        _env_cache.setdefault("_loaded", "1")
    return _env_cache.get(name, "")


def configured() -> bool:
    return bool(_env("AZURE_SPEECH_KEY") and _env("AZURE_SPEECH_REGION"))


def _month() -> str:
    return time.strftime("%Y-%m")


def _read_usage() -> dict:
    try:
        with open(USAGE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("month") == _month():
            return data
    except (OSError, ValueError):
        pass
    return {"month": _month(), "chars": 0}


def _write_usage(data: dict) -> None:
    os.makedirs(USAGE_DIR, exist_ok=True)
    with open(USAGE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


def monthly_limit() -> int:
    try:
        return int(_env("AZURE_SPEECH_MONTHLY_CHARS") or DEFAULT_MONTHLY_LIMIT)
    except ValueError:
        return DEFAULT_MONTHLY_LIMIT


def chars_used() -> int:
    return int(_read_usage().get("chars", 0))


def can_use(text: str) -> bool:
    return configured() and chars_used() + len(text) <= monthly_limit()


def synthesize_azure(voice: str, text: str, media_path: str, words_path: str, rate: str = "+0%", pitch: str = "+0Hz") -> None:
    """Raises on any failure so the caller falls through to the offline voices. Counts characters only on success."""
    if not can_use(text):
        raise RuntimeError("azure monthly character budget reached or key missing")
    region = _env("AZURE_SPEECH_REGION")
    ssml = (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
        f'<voice name="{escape(voice)}"><prosody rate="{escape(rate)}" pitch="{escape(pitch)}">{escape(text)}</prosody></voice>'
        "</speak>"
    )
    request = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": _env("AZURE_SPEECH_KEY"),
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "fillbook-live-host",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310 - fixed https host
        audio = response.read()
    if len(audio) < 1000:
        raise RuntimeError("azure returned no audio")
    with open(media_path, "wb") as f:
        f.write(audio)

    ffprobe = shutil.which("ffprobe") or "ffprobe"
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", media_path],
        capture_output=True, text=True, timeout=30,
    )
    duration = float(out.stdout.strip())
    words = [w for w in re.split(r"\s+", text.strip()) if w]
    weights = [len(w) + 1 for w in words]
    total = float(sum(weights)) or 1.0
    cursor = 0.0
    timings = []
    for word, weight in zip(words, weights):
        span = duration * weight / total
        timings.append({"text": word, "startSeconds": cursor, "endSeconds": cursor + span})
        cursor += span
    with open(words_path, "w", encoding="utf-8") as f:
        json.dump(timings, f)

    usage = _read_usage()
    usage["chars"] = int(usage.get("chars", 0)) + len(text)
    _write_usage(usage)
