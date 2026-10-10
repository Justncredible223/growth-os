#!/usr/bin/env python3
"""
A long-lived voice helper for the Live Host worker.

Starting Python and importing edge_tts takes several seconds on some PCs, and the worker used to pay that for
every spoken line. This process starts once, imports once, then answers requests for as long as the worker runs.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
  in:  {"id": "...", "voice": "...", "rate": "+4%", "textFile": "...", "mediaPath": "...", "wordsPath": "..."}
  out: {"id": "...", "ok": true}  or  {"id": "...", "ok": false, "error": "..."}
It prints {"ready": true} once edge_tts is imported, so the worker knows it is warm.

It reuses synthesize() from the video factory's edge_tts_words.py, so the voice and the word timings are
exactly what the one-shot script produces.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "video-factory"))
from edge_tts_words import synthesize  # noqa: E402


def reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


async def handle(request: dict) -> None:
    request_id = request.get("id")
    try:
        with open(request["textFile"], "r", encoding="utf-8") as handle_file:
            text = handle_file.read()
        await synthesize(request["voice"], text, request["mediaPath"], request["wordsPath"], request.get("rate", "+0%"))
        reply({"id": request_id, "ok": True})
    except SystemExit as exit_error:  # synthesize() exits when the service returned no word timings
        reply({"id": request_id, "ok": False, "error": f"no word timings (exit {exit_error.code})"})
    except Exception as error:  # noqa: BLE001 - one bad line must never kill the helper
        reply({"id": request_id, "ok": False, "error": str(error)[:300]})


async def main() -> None:
    loop = asyncio.get_running_loop()
    reply({"ready": True})
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        # Lines are spoken one at a time, but do not block reading the next request on a slow synthesis.
        asyncio.create_task(handle(request))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
