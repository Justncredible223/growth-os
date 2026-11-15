# X picture style test: real Fillbook screen vs drawn card

Decided 2026-11-15 by ChatGPT and the App session, at the owner's request. Product screenshots might bring more sign-ups
than the drawn card, but that is a guess, so the two styles alternate and get compared. Neither replaces the other until the data says so.

## How a post gets its picture
- **Screen style:** shows one real Fillbook card from the public `/sample` page. That page holds only made-up trades and never a customer's or the owner's data. The card always carries the SAMPLE DATA label.
- **Drawn style:** the existing card (`xPostImageCard.ts`).
- **Who is eligible for a screen:** only posts with no figure of their own, so the screen's made-up numbers can never contradict the post. Also excluded: the intraday-vs-end-of-day comparison card, and topics with no fitting screen (payout, consistency).
- **Which style an eligible post gets:** a hash of the post text decides (`styleArmForText`). Even means screen, odd means drawn. Because it depends only on the text, anyone can re-score the test later from the posted text alone.
- **Screens per topic:** drawdown uses the buffer tile, loss limit the loss-room tile, sizing the max-size tile. Edge Score uses the Edge Score card, journal uses Your Leaks, and everything else uses Account health.
- **Off switch:** `X_POST_SCREEN_CARDS=off` gives every post the drawn card.
- **Labelling:** the receipt under Today's X Post and the post history both say which style a post got.

## Retaking the screens (whenever the Fillbook dashboard's look changes)
```bash
cd <fillbook checkout>/frontend && npx vite --port 5199
cd backend && node scripts/x-screens/capture.mjs http://localhost:5199
```
The live site blocks headless browsers, so the capture runs against a local copy of the site. Rebuild the app afterwards; the screens ship inside it (`android/app/src/main/assets/xscreens`).

## Reading the result
- **Balance:** `GET /api/summary?resource=x-feed-post-history` returns `pictureTest`, the posted posts since 2026-11-16 by topic and style. `unbalancedTopics` lists any topic whose split is lopsided. Check it before reading any result.
- **Metric:** attributed trials per 1,000 organic X impressions.
- **Attribution:** working for new WEB sign-ups since 2026-11-15 06:44 UTC (Site Work PR #1325: the first touch is saved at sign-up and the claim prefers it; Setup verified one tagged profile read-only). Count only profiles created after that time. Installed Android/PWA copies still on an old cached bundle lose the tag until they update, and earlier profiles stay unknown (no back-fill). Ask Site Work to confirm the first real X-attributed profile, and declare no winner until enough attributed trials exist in each style.
- **Edited posts:** the style is worked out from the posted text. If the owner edits a draft before posting, the posted text may fall in a different style than the picture he attached. Edits are rare, so this is accepted.
