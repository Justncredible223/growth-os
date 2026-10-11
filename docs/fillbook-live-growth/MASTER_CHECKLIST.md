# Master checklist (status as of 2026-10-11; branch feat/live-show-and-reply-speed, nothing pushed or merged)

Legend: V verified, I implemented not verified live, P partial, B blocked, N not implemented, A needs approval

| Item | Status | Notes |
|---|---|---|
| Host persona, guardrails, no advice, no giveaway talk | V | tests pass (205) |
| Answer-only after opening on YouTube | I | unit test; not seen live |
| Chat move commands instant, not answered | I | unit tests; not seen live |
| Phone-safe layout above YouTube chat overlay | V | confirmed on user's phone screenshot 11:55 |
| Comment acknowledged before answer (show comment + thinking + filler) | I | branch only; needs worker restart and live check |
| First-sentence TTS split (speak sooner) | I | worker + stage; unit test for the split only, not heard live |
| Strict scope: futures trading + Fillbook only | I | persona rule 15; not exercised on a live model call yet |
| Fillbook feature knowledge block (verified facts only) | I | persona block from manifest facts; owner should read it once |
| Idle visuals: simulated chart (labeled) that Tilt reacts to; silent feature cards with captions | I | stage JS syntax-checked only, not viewed live |
| Show rundown config (no code change) | N | |
| Operator controls: pause/mute/skip/emergency stop | P | duo console has some; solo has app switch only |
| UTM-tagged stream link + attribution check | N | A for any production change |
| Recording + clip queue | N | A for any public publishing |
| Merge/deploy of branch | A | not done |
