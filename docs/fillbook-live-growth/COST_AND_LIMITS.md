# Cost drivers and limits

| Driver | Value | Basis |
|---|---|---|
| Model line, Sonnet, warm cache | about $0.0077 | measured 2026-10-10 |
| Model line, Haiku | about $0.0025 | measured |
| Cold cache line | $0.038 (Sonnet), $0.0128 (Haiku) | measured |
| Daily model budget | $3 default; economy at 60%, cheapest at 85% | configured |
| Engaged hour | about $0.90 | estimate from the above, assumes a line about every 30 s |
| Quiet hour (answer-only, one viewer) | cents | estimate: only replies are drafted |
| Voice (edge-tts) | $0 | free service, runs on the laptop |
| YouTube Data API chat polling | 5 units per poll; 5 s active, 8 s quiet | quota default 10,000 units/day: about 4 h of quiet polling or 2.8 h fully active; assumption: default quota not raised |
| Hosting | existing Vercel and Supabase | no new service added |
| Recording | local disk, about 1 GB per hour at OBS defaults | assumption: depends on OBS settings; retention is manual |

Controls in place: daily budget, cost modes, fast model for routine segments, bounded retries and backoff, answer-only after the opening, pause and emergency stop. Not in place: spend alert notification (the number shows in the control panel and report), configurable operating hours (the app switch is the control).
