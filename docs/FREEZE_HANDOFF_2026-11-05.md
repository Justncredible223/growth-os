# Growth OS freeze handoff (written 2026-11-04, for the switch from Claude Max to Claude Pro on 2026-11-05)

**START HERE.** From 2026-11-05 Claude usage is much smaller. Nothing in Growth OS needs a Claude subscription to keep running: the
scheduled jobs run on Vercel and GitHub Actions and spend **Anthropic API credits and X API reads**, which are billed separately from
the Claude plan. Sessions from here should be short: fixes and checks only, no new features, nothing half-built.
Naming rule: the business is **Fillbook**; `fillbookhq.com` is only the address; `@FillbookHQ` only as the literal handle.
Safety rule that never changes: Growth OS never posts, replies, likes, follows or DMs (`docs/EXTERNAL_WRITE_FIREWALL.md`). The owner posts
everything by hand.

## 1. What runs by itself (no Claude session needed)
Vercel crons (`backend/vercel.json`, UTC): `daily-pipeline?group=core` 13:00; `daily-pipeline?group=x_feed_post` 14:00 (drafts Today's X Post);
`growth-pulse` 15:00 (with partnerships), 20:00 and 01:00 (inbound mentions, video reconciliation, YouTube comments, results).
A daily video refill drafts one concept per Arizona day (one new request a day, `src/video/dailyLimit.ts`); renders run in GitHub Actions
(`video-render.yml`, `campaign-run.yml`) after the owner approves the draft in the app's Approvals tab.
Prospecting: Search now and the scheduled search stop at a daily budget of $0.50 and a monthly cap of $40
(`prospectingEligibility.ts`); the creator watchlist is 50 seed creators (`prospectingWatchlist.ts`).

## 2. Switches
- **Pause everything:** the Settings pause in the app (`system_settings.paused`). Manual campaign runs refuse while paused ("unpause it in
  Settings") and the YouTube comment job skips; confirm in the app after pausing that the daily pipeline and growth-pulse also stop.
- **Prospecting spend:** lower `MONTHLY_PROSPECTING_BUDGET_USD` / the daily limit in `prospectingEligibility.ts` (needs a PR and deploy).
- Video requests are already limited to one a day; nothing renders without the owner's approval.

## 3. Owner-only actions (Claude must not do these)
- Merge every PR. Approve or reject video drafts in Approvals. Post and pin on X, TikTok, Instagram and YouTube (Marketing session uploads
  YouTube Shorts only when told to). Spend money, sign up for services, send messages to real people.

## 4. State on 2026-11-04
- Merged: #266 to #283 (prospecting watchlist and drafting rules, Day 16/17/25/29 voice-line corrections, X post image brief + posting window +
  Wednesday reference post, brand wording, pinned-comment wording for illustration videos).
- Videos: Day 15 and Day 18 are rendered and posted. **Day 16 (explain-12, "A good win rate can hide a losing setup")**: its corrected
  voice part is in the repo and the draft was requested (request e730b80a) but, as far as the API shows, not rendered: the owner needs to
  approve it in Approvals (or re-request it after midnight Arizona). Day 17 text is unchanged and verified. Days 25 and 29 have corrected
  lines and new part-8 recordings.
- Phone app: the Fold has the build from master after #280 (Home shows the full X post note). Rebuild only if `android/` changes:
  `JAVA_HOME=C:/Users/Justin/.jdks/jbr-21.0.11`, `cd android && ./gradlew.bat assembleDebug`, then `adb install -r`.
- X post images: **not generated**. Each draft carries a text Image brief; the owner makes the picture and attaches it by hand. The team
  (ChatGPT, Gemini, Claude) agreed to wait until after the freeze before building any image renderer, with a number check and owner approval.
- Prospecting: the reply drafter may offer a Fillbook-naming option (option C) only when a view fits, capped at 1 in 5 of the last 12 posted
  replies. Review it with real numbers at the planned 2026-11-21 review.
- Pilot 1 ("Green month. Losing setup.") has stale comments in `pilots.ts` ("worst first" no longer matches the app); do not re-render it.

## 5. Known issues
- A few backend tests can flake under the full-suite load (`requireAppAuth` "lets the automation token read video-status",
  `run-campaign` retired-draft test); they pass alone. A test that depends on the real date (draft-anyway queue) was fixed in #280.
- Posted Shorts cannot be edited; check a plan's wording against the live app before rendering (the Reports "By setup" list is best-first,
  tagged habits are worst-first).
- Not verified: the Anthropic cost of one rendered video. Check the cost table in the app before assuming a figure.

## 6. How to work on Pro (cheap and safe)
1. Branch from `origin/master`; run `cd backend && npx tsc --noEmit && npx vitest run` before pushing (about 2700 tests).
2. One bundled PR per batch (GitHub Actions cost); the owner merges.
3. Voice fixes: change the text (`src/shortform/*.ts`, `docs/VOICE_SCRIPTS.md`), re-record only the affected part with the same ElevenLabs
   settings (Jessica Anne Bogart, Eleven v4, speed 1.12, stability 50, similarity 89), match 44.1 kHz mono 128 kbps, put it in
   `backend/scripts/video-factory/assets/voice/<planId>-<n>.mp3`. Lines are 7 words or fewer and must pass the claims guard.
4. After the freeze, the post-freeze list: image renderer for X posts (template-first, number check, owner approval), review of prospecting
   option C, and the viewing of results at the 2026-11-21 review.
