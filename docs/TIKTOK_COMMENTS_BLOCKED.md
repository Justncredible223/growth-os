# TikTok comment monitoring — investigated and blocked (2026-09-17)

Justin asked for TikTok comment monitoring to match the YouTube inbound
ingestion built alongside the "I posted this — add the link" feature
(`inboundYoutubeIngestion.ts`, `youtubeAdapter.ts`) — TikTok is currently
Fillbook's most-viewed social platform, so it's the natural next target.
This is a structural blocker, not a "not yet built" gap: **do not attempt
this again without TikTok's access policy changing first.** Same shape of
finding as `docs/REDDIT_INTEGRATION.md`'s Reddit blocker before that
integration was removed outright.

## What was investigated

TikTok has exactly one documented endpoint that returns comments on a
video: `/v2/research/video/comment/list/`. It lives entirely under
TikTok's **Research API** ("Research Tools" / "Research & Insights" in
TikTok's own developer docs), not the general-purpose Display API or
Content Posting API that a normal business app uses.

TikTok's own Research Tools eligibility terms (verified directly against
`developers.tiktok.com/products/research-api` and TikTok's Research API
Terms of Service, 2026-09-17):

- Eligibility is limited to **qualifying academic institutions** (US,
  EEA, UK, Switzerland) and **EU-registered non-profits** doing
  public-interest, non-commercial research, plus a narrower Brazilian
  academic/non-profit carve-out for youth-safety research.
- Stated explicitly in TikTok's own materials: **"Creators, advertisers,
  and commercial users are not eligible for Research Tools access."**
- Even for eligible applicants, approval is a manual review taking about
  30 days.

Fillbook Growth OS is a commercial growth tool for a commercial product.
It fails the eligibility test on its face — this isn't a form to fill out
more carefully or an approval queue to wait in, it's a category
exclusion.

**The other angle checked and also closed:** TikTok's Content Posting API
does offer comment-management capabilities to business accounts, but only
for videos that same app *uploaded* through the Content Posting API in
the first place. Fillbook Growth OS deliberately never posts to TikTok
itself — the owner always downloads the rendered video and posts it
manually through TikTok's own app (see `docs/EXTERNAL_WRITE_FIREWALL.md`
for why that boundary exists). Since the video was never posted via the
API, there is no API-side comment thread for this app to manage even if
the account qualified for that capability.

## What this means concretely

- No `tiktokAdapter.ts` / `inboundTiktokIngestion.ts` should be built to
  mirror the YouTube pattern — there is no legitimate endpoint for it to
  call.
- The TikTok link the owner pastes into "I posted this — add the link"
  (`VideoStatusScreen.kt`, `setPublishedUrl`) is saved for the owner's own
  record only. Unlike the YouTube URL, nothing currently reads it back or
  polls it — there is nothing legitimate it *could* poll.
- TikTok engagement (comments, DMs) has no automated path into the
  Inbound queue today. The owner has to check TikTok's own app directly
  for that account's most-viewed channel — a real, acknowledged gap in
  coverage, not an oversight.

## What would change this

Revisit only if one of these actually happens:

1. TikTok opens a general-purpose (non-Research-Tools) comment-read
   endpoint to ordinary business/developer apps, not just qualifying
   academic/non-profit researchers.
2. Fillbook Growth OS starts posting to TikTok *through* the Content
   Posting API itself (a real change to the "owner always posts
   manually" design in `docs/EXTERNAL_WRITE_FIREWALL.md`, not something
   to decide unilaterally) — which would make that same API's comment-
   management capability apply to those posts.
3. A third-party TikTok scraping/data API is deliberately chosen as an
   explicit, owner-approved exception to reading data only through
   official platform APIs — not attempted here since it wasn't asked for
   and carries its own ToS/reliability risk that deserves its own
   decision, not a default fallback.

None of these were pursued further this pass.

## Update 2026-10-09: option 3 was chosen for LIVE chat only

The owner explicitly approved an unofficial reader for one narrow purpose:
reading the chat of Fillbook's own TikTok LIVE so the Live Host can answer
it (see the TikTok section of `docs/LIVE_HOST.md`). This is the
owner-approved exception described in option 3 above. It is read-only, off
by default, and lives entirely in `backend/scripts/live-host/tiktokChat.ts`
on the streaming PC.

Everything else in this document still stands. Comments on TikTok videos
are still not ingested, there is still no `tiktokAdapter.ts`, and nothing
here reads TikTok data on the server.

