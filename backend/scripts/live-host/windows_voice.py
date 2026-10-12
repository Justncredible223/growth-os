"""
Backup voice for the Live Host: Windows' built-in SAPI voices (fully offline, never rejected by a network service).

Used by tts_server.py only when the free Microsoft neural voice (edge-tts) refuses a request, so a stream never goes
silent. It is flatter than the neural voice and its word timings are ESTIMATED from the audio length (SAPI gives none
through this path), which is what the stage's captions need and nothing more.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile

# Male-sounding edge voices map to David, anything else to Zira.
_MALE = re.compile(r"(Andrew|Guy|Davis|Christopher|Eric|Roger|Steffan|Brian|Ryan|Thomas|Tony|Jason|Ethan)", re.I)


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
        script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SelectVoice('{_sapi_voice(edge_voice)}'); "
            f"$s.Rate = {_sapi_rate(edge_rate)}; "
            f"$s.SetOutputToWaveFile('{wav_file}'); "
            f"$s.Speak([System.IO.File]::ReadAllText('{text_file}')); "
            "$s.Dispose()"
        )
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
