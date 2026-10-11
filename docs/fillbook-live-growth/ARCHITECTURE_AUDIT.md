# Architecture audit: Tilt live host (2026-10-11)

Source of truth: `backend/src/liveHost/*`, `backend/scripts/live-host/*`, `docs/LIVE_HOST.md`. Repo `Justncredible223/growth-os`.

## How a line gets on air
1. Laptop worker (`worker.ts`) ticks the Vercel API (`/api/approvals?resource=live-host`) every 1.5 s with TikTok chat, host prompts and status.
2. Server `runLiveHostTick` (`liveHostHandlers.ts`): reads YouTube chat (YouTube Data API, polled every 5 s while chat is active, 8 s quiet), stores messages in Supabase, picks reply or segment, calls Anthropic (Sonnet default, Haiku for fast tier), runs guardrails and variety checks, returns one utterance.
3. Worker voices it with edge-tts (warm Python helper), serves it to the OBS Browser Source (`stage/index.html`) over SSE, confirms it spoken.
4. OBS (WebSocket) is started and stopped by the owner switch in the Growth OS app.

## Findings (evidence from the 2026-10-10 first live)
- Reply latency ~20 s: chat poll (5-10 s) + draft (2-4 s) + TTS (3-6 s, whole line synthesized before playing) + YouTube viewer delay (10-20 s, normal latency).
- He filled empty rooms: idle segments ran for 3 minutes after any chat message, every 30 s. Fixed on branch: YouTube is answer-only after a 2-minute opening.
- Chat commands ("dance", "moonwalk") were answered by the model ("I can't dance"). Fixed: pure move requests play on stage and are not answered.
- Vertical 1080x1920 stage: YouTube phone app overlays chat over y>=~1370 and a fan badge at top-left. Layout moved above that (`body.safe-youtube`).
- Worker processes survive TaskStop on Windows (supervisor children); stopping needs the process tree killed. Operator stop is the app switch; there is no hard "emergency stop" in the host console.
- Background chart behind Tilt is decorative, unlabeled. It must not be read as market data.

## Not verified
- Recording / clipping pipeline for live replays (nothing exists for live; `video-factory` is separate).
- UTM attribution from the stream link to signups (site has activation funnel from #384; stream link is not tagged).
- Live-chat moderation beyond the guardrail screen.
