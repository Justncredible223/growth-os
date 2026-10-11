#!/usr/bin/env python3
"""
Generates a voiceover with edge-tts and captures real per-word timing.

edge-tts's own CLI only exposes --write-subtitles, which is sentence-level
(SRT) timing -- not enough to drive word-by-word "active word" highlighted
captions (the TikTok/CapCut look). The underlying edge_tts Python library
streams WordBoundary events with the offset/duration of each individual
word as it's synthesized, so this script calls that library directly
instead of shelling out to the edge-tts CLI, and writes those word-level
timings to a JSON file alongside the audio.

Invoked as a subprocess from voiceover.ts (Node), not imported -- keeps the
Node/Python boundary at a single process call, same shape as every other
external tool in this pipeline (ffmpeg, ffprobe).
"""
import argparse
import asyncio
import json
import sys

import edge_tts

# edge-tts reports offsets/durations in 100-nanosecond units.
TICKS_PER_SECOND = 10_000_000


async def synthesize(voice: str, text: str, media_path: str, words_path: str, rate: str = "+0%", pitch: str = "+0Hz") -> None:
    # edge-tts 7.x defaults to sentence-level "SentenceBoundary" metadata --
    # must explicitly request "WordBoundary" to get per-word offset/duration.
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    words = []
    with open(media_path, "wb") as audio_file:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_file.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                word_text = chunk["text"].strip()
                if not word_text:
                    continue
                words.append(
                    {
                        "text": word_text,
                        "startSeconds": chunk["offset"] / TICKS_PER_SECOND,
                        "endSeconds": (chunk["offset"] + chunk["duration"]) / TICKS_PER_SECOND,
                    }
                )

    if not words:
        print("edge-tts produced no WordBoundary events", file=sys.stderr)
        sys.exit(1)

    with open(words_path, "w", encoding="utf-8") as f:
        json.dump(words, f)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--pitch", default="+0Hz", help='pitch relative to the voice default, e.g. "+4Hz" or "-6Hz"')
    parser.add_argument("--rate", default="+0%", help='speaking rate relative to the voice default, e.g. "+8%%" or "-5%%"')
    parser.add_argument("--file", required=True, help="path to a text file containing the script")
    parser.add_argument("--out-media", required=True, help="output .mp3 path")
    parser.add_argument("--out-words", required=True, help="output word-timing .json path")
    args = parser.parse_args()

    with open(args.file, "r", encoding="utf-8") as f:
        text = f.read()

    asyncio.run(synthesize(args.voice, text, args.out_media, args.out_words, args.rate, args.pitch))


if __name__ == "__main__":
    main()
