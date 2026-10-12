"""
Backup voice for the Live Host: Piper (a free offline neural voice, tried first) and then Windows' built-in SAPI voices (fully offline, never rejected by a network service).

Used by tts_server.py only when the free Microsoft neural voice (edge-tts) refuses a request, so a stream never goes
silent. It is flatter than the neural voice and its word timings are ESTIMATED from the audio length (SAPI gives none
through this path), which is what the stage's captions need and nothing more.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import wave

# Male-sounding edge voices map to David, anything else to Zira.
_MALE = re.compile(r"(Andrew|Guy|Davis|Christopher|Eric|Roger|Steffan|Brian|Ryan|Thomas|Tony|Jason|Ethan)", re.I)


PIPER_DIR = os.environ.get("TILT_PIPER_DIR", os.path.join(os.path.expanduser("~"), ".piper-voices"))
PIPER_MALE = os.environ.get("TILT_PIPER_MALE", "en_US-hfc_male-medium")
PIPER_FEMALE = os.environ.get("TILT_PIPER_FEMALE", "en_US-amy-medium")


def _piper_model(edge_voice: str) -> str:
    return os.path.join(PIPER_DIR, (PIPER_MALE if _MALE.search(edge_voice or "") else PIPER_FEMALE) + ".onnx")


KOKORO_DIR = os.environ.get("TILT_KOKORO_DIR", os.path.join(os.path.expanduser("~"), ".kokoro"))
KOKORO_MALE = os.environ.get("TILT_KOKORO_MALE", "am_adam")
KOKORO_FEMALE = os.environ.get("TILT_KOKORO_FEMALE", "af_heart")
# Kokoro is the most natural of the offline voices but slower (about 1.5x real time on this laptop): used for lines up
# to this many words, which covers chat answers (capped at 40) and the sentence-by-sentence pieces of longer lines.
KOKORO_MAX_WORDS = int(os.environ.get("TILT_KOKORO_MAX_WORDS", "48"))
_KOKORO = None
_KOKORO_LOCK = threading.Lock()


def _load_kokoro():
    global _KOKORO
    with _KOKORO_LOCK:
        if _KOKORO is None:
            from kokoro_onnx import Kokoro  # noqa: PLC0415 - lazy: the helper must start without it

            model = os.path.join(KOKORO_DIR, "kokoro-v1.0.int8.onnx")
            voices = os.path.join(KOKORO_DIR, "voices-v1.0.bin")
            if not (os.path.exists(model) and os.path.exists(voices)):
                raise FileNotFoundError("kokoro model files are not installed")
            _KOKORO = Kokoro(model, voices)
        return _KOKORO


def _kokoro_wav(edge_voice: str, text: str, wav_file: str, edge_rate: str) -> bool:
    import soundfile  # noqa: PLC0415

    kokoro = _load_kokoro()
    match = re.match(r"([+-]?\d+)%", edge_rate or "")
    pct = int(match.group(1)) if match else 0
    voice = KOKORO_MALE if _MALE.search(edge_voice or "") else KOKORO_FEMALE
    samples, rate = kokoro.create(text, voice=voice, speed=max(0.8, min(1.3, 1.05 + pct / 100.0)), lang="en-us")
    soundfile.write(wav_file, samples, rate)
    return os.path.exists(wav_file) and os.path.getsize(wav_file) > 1000


_PIPER_VOICES: dict = {}
_PIPER_LOCK = threading.Lock()


def _load_piper(model_path: str):
    """The voice stays loaded in this long-lived helper: loading takes about 10 seconds, a line about 2."""
    with _PIPER_LOCK:
        voice = _PIPER_VOICES.get(model_path)
        if voice is None:
            from piper import PiperVoice  # imported lazily: the helper must start even if piper is not installed

            voice = PiperVoice.load(model_path)
            _PIPER_VOICES[model_path] = voice
        return voice


def warm_piper() -> None:
    """Loads the backup voices ahead of the first line. Never raises."""
    try:
        _load_kokoro()
    except Exception:  # noqa: BLE001
        pass
    for edge_voice in ("en-US-AndrewNeural", "en-US-JennyNeural"):
        model = _piper_model(edge_voice)
        if os.path.exists(model):
            try:
                _load_piper(model)
            except Exception:  # noqa: BLE001
                pass


def _piper_length_scale(edge_rate: str) -> float:
    """edge-tts "+8%" means faster; piper's length scale is the inverse (smaller is faster)."""
    match = re.match(r"([+-]?\d+)%", edge_rate or "")
    pct = int(match.group(1)) if match else 0
    return max(0.7, min(1.4, 1.0 - pct / 100.0))


def _sapi_voice(edge_voice: str) -> str:
    return "Microsoft David Desktop" if _MALE.search(edge_voice or "") else "Microsoft Zira Desktop"


def _sapi_rate(edge_rate: str) -> int:
    """edge-tts rates are like "+4%" or "-8%"; SAPI is -10..10 where 0 is the default pace (a bit slow)."""
    match = re.match(r"([+-]?\d+)%", edge_rate or "")
    pct = int(match.group(1)) if match else 0
    return max(-10, min(10, 2 + round(pct / 8)))


def _duration_seconds(path: str) -> float:
    ffprobe = shutil.which("ffprobe") or "ffprobe"
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
    return float(out.stdout.strip())


def synthesize_windows(edge_voice: str, text: str, media_path: str, words_path: str, edge_rate: str = "+0%") -> None:
    work = tempfile.mkdtemp(prefix="tilt-voice-")
    try:
        text_file = os.path.join(work, "text.txt")
        wav_file = os.path.join(work, "voice.wav")
        with open(text_file, "w", encoding="utf-8") as f:
            f.write(text)
        wrote_wav = False
        if len(text.split()) <= KOKORO_MAX_WORDS:
            try:
                wrote_wav = _kokoro_wav(edge_voice, text, wav_file, edge_rate)
            except Exception:  # noqa: BLE001 - fall through to Piper
                wrote_wav = False
        model = _piper_model(edge_voice)
        if not wrote_wav and os.path.exists(model):
            try:
                from piper.config import SynthesisConfig  # noqa: PLC0415

                voice = _load_piper(model)
                with wave.open(wav_file, "wb") as wf:
                    voice.synthesize_wav(text, wf, SynthesisConfig(length_scale=_piper_length_scale(edge_rate)))
                wrote_wav = os.path.exists(wav_file) and os.path.getsize(wav_file) > 1000
            except Exception:  # noqa: BLE001 - fall through to the Windows voice
                wrote_wav = False
        script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SelectVoice('{_sapi_voice(edge_voice)}'); "
            f"$s.Rate = {_sapi_rate(edge_rate)}; "
            f"$s.SetOutputToWaveFile('{wav_file}'); "
            f"$s.Speak([System.IO.File]::ReadAllText('{text_file}')); "
            "$s.Dispose()"
        )
        if not wrote_wav:
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], check=True, capture_output=True, timeout=60)
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            subprocess.run([ffmpeg, "-y", "-v", "error", "-i", wav_file, "-codec:a", "libmp3lame", "-q:a", "4", media_path], check=True, capture_output=True, timeout=60)
            duration = _duration_seconds(media_path)
        else:
            shutil.copyfile(wav_file, media_path)
            duration = _duration_seconds(wav_file)

        words = [w for w in re.split(r"\s+", text.strip()) if w]
        weights = [len(w) + 1 for w in words]
        total = float(sum(weights)) or 1.0
        cursor = 0.0
        out = []
        for word, weight in zip(words, weights):
            span = duration * weight / total
            out.append({"text": word, "startSeconds": cursor, "endSeconds": cursor + span})
            cursor += span
        with open(words_path, "w", encoding="utf-8") as f:
            json.dump(out, f)
    finally:
        shutil.rmtree(work, ignore_errors=True)
