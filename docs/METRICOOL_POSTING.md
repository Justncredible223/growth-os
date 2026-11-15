# Posting a finished video to TikTok and YouTube Shorts through Metricool

Team decision: Claude and ChatGPT, 2026-11-14. It builds on the Metricool posting policy Justin approved on 2026-11-08.

Growth OS never posts. It builds a **Metricool package** for each finished render. The Marketing session queues that package with the official Metricool connector, but only after Justin approves that exact package.

## Rules that do not change
- **Platforms:** TikTok and YouTube Shorts only, through the official Metricool connector (brand 7769013). No scripted use of the Metricool web app or of either social account.
- **Volume:** at most 20 platform publications a month, counted per network, and at most one a day across both. Before queueing, count what is already published and scheduled.
- **Approval:** copying a package is **not** approval. Justin approves by writing `approve <packageId> for <date and time, Arizona>`. That approval covers that exact file (SHA256), both captions, both platforms and that date. Any change to any of them voids it.
- **Autopublish is off** (`METRICOOL_AUTO_PUBLISH = false` in `backend/src/video/metricoolPackage.ts`). Metricool notifies Justin's phone, and he completes the post. Turning autopublish on takes its own PR and Justin's yes, after the first TikTok and the first YouTube Short are both verified end to end.

## Steps
1. **Render.** Justin approves a script in the app. The video renders and appears as Ready in Video Status.
2. **Copy.** In Video Status, Justin taps **Copy Metricool package** and pastes the text to the Marketing session.
   - The text holds the package id, the file's SHA256, a media link valid for 24 hours, the rule checks, and one Metricool `info` for each network.
   - If it says `CHECKS FAILED`, stop.
3. **Approve.** Justin writes `approve mp-xxxxxxxx for <date/time>`.
4. **Queue.** The Marketing session:
   - checks the month's count with `getScheduledPosts` plus the published posts;
   - adds `publicationDate` (`{dateTime, timezone: "America/Phoenix"}`) to each `info`;
   - calls `createScheduledPost` once for TikTok and once for YouTube, changing nothing else in the `info`.
5. **Read back.** Read both posts back with `getScheduledPosts`:
   - the flags must match;
   - the media must now be a Metricool copy, not the signed Supabase link.

   If a post still points at the signed link, or anything differs from the package, **stop**. Don't retry or edit. Ask Justin, giving the expected and the observed values.
6. **Log.** Record the queued posts in the outside-action log on the two-PC board. Once a post is live, check its public page read-only, then save its link in the app (Video Status, Posted link).

## Before the first real post
Do one controlled test: one Justin-approved render, TikTok with autopublish off, YouTube supervised. It checks:
- the quota count;
- the platform flags;
- that Metricool copies the media;
- the read-back;
- that nothing publishes by accident.

Until that test passes, step 4 stays on hold.

## What the package sets
- **TikTok:**
  - `privacyOption PUBLIC_TO_EVERYONE`
  - comments, duets and stitches on
  - `commercialContentOwnBrand true`, `commercialContentThirdParty false`
  - `isAigc true` (the voice is ElevenLabs)
  - text = the TikTok caption plus at most 5 hashtags
- **YouTube:**
  - `type short`, `privacy public`
  - `madeForKids false`, `isAiGeneratedContent true`
  - category EDUCATION
  - title = the stored YouTube title (at most 100 characters)
  - text = the stored description
  - tags = at most 5 hashtags
- **Both:** no first comment, no shortener, no custom cover. A custom cover is silently ignored on a personal TikTok account anyway.
