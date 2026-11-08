# Chart-moment series (TikTok / Shorts), decided by the team 2026-11-08

**Decision (whole team: ChatGPT, Gemini, HQ, Marketing, App; owner delegated):** build a series of very short chart videos whose
job is to be watched to the end, with Fillbook as a small closing card. The owner posts by hand. Nothing here posts, sends or spends.

## Why

Organic TikTok views (TikTok Studio, read 2026-11-08): the chart/strategy videos get 280-619 views; the product and data-card videos
get 86-160; the Edge Score explainer got 111. The paid ~9K videos are left out of every comparison. Every team member gave the same
reason: viewers scroll for a chart moment with a payoff, in the niche's own words, and a product card looks like an ad in the first
second. Marketing's organic numbers say a hook-first opening about doubled the share who watched to the end (3.1% to 7.1%).

## The format (one variable changed at a time)

- 12 to 15 seconds, three cards: **hook** (4.5 s: first-frame text is a question or a cut-off outcome, chart already moving), **payoff**
  (4.5 s: the chart finishes, one plain line), **question + end card** (4.5 s: one question to the viewer, then a labeled
  sample-data Fillbook card, no "sign up").
- The first frame must already carry the tension. The payoff lands within 2 seconds of the hook ending.
- Drawn illustrations only (the existing chart scenarios), labeled "Illustration, not a recommendation". No market, ticker, date or price.
- Never: a result, an earnings claim, "this setup works", a real person's or account's result, a firm's rule as fact unless that firm's
  rulebook was checked (only Earn2Trade has been re-verified), any advice or signal.
- Product shows up as the last 2 seconds, a short caption mention and a pinned comment. Pinned comment template (always sample data):
  "Illustration, not a recommendation. Fillbook is a journal: log your own trades and check them against your own rules."
- One post a day at most. Series name on every video so viewers expect the next one.

## First seven concepts (hook max 7 words and 34 characters; same chart art, so no new drawing work)

| # | Chart scenario | Hook (first frame) | Payoff line | Closing question |
|---|---|---|---|---|
| 1 | orbBreak | Closed outside the range. Then? | It ran. A close, not a wick, was the trigger. | Would your plan have taken it? |
| 2 | orbFake | Broke the high. Then it didn't. | The close came back inside. The stop did its job. | Where was your stop? |
| 3 | vwapPullback | Pulled back to VWAP. Held? | It held. Then the first push. | Did you wait for the hold? |
| 4 | vwapChop | VWAP crossed 8 times. Trend? | No trend. Eight crosses is chop. | Do you trade the chop? |
| 5 | breakRetest | The retest held. Or did it? | It held on a close, not a dip. | A close or a dip? |
| 6 | breakFail | The retest failed. Where's your stop? | A close back under ended it. Small loss. | Was your stop set before? |
| 7 | demandSupply | Back at the zone. Hold or fail? | First return held. Later returns often fail. | First return or fifth? |

## Phase 2 (rule moments, same format, needs a short mock card, labeled sample data)

HQ's angles, kept as hooks for a second batch: "I was $40 from the daily limit." (near-miss, sample data), "Trailing drawdown
moves. Most traders miss when." (ends with "check your firm's rulebook"), "Which candle blew this account? Comment yours."
(a past chart, labeled, no advice).

## Voice and cost

Short videos need about 30 spoken words each. They are recorded in ElevenLabs by Marketing only after the owner's explicit credits OK
and Site Work's page-facts check. Narration lines are one sentence each, as in the strategy videos, so one take can be cut at pauses.

## How we judge it (Marketing pulls the numbers; Metricool or TikTok Studio; counts only)

Per video, log: hook, first-frame text, length, **organic** average watch time, **share watched fully at 24 hours**, shares, saves,
new followers. Run each hook three times with a different opening before judging (small sample). Win = a video beats 619 views, or beats
the account's own average watch time by 20% at 24 hours. Likes are not the measure. Keep paid views out of every comparison.

## Build order

1. Team review of this brief (owner approves the concepts before anything renders).
2. `buildStrategyShort` in the video factory: three cards from one scenario, own plan id, own recorded parts.
3. Concepts 1 to 3 recorded and rendered; the owner approves each file and caption; Marketing schedules by the posting policy.
4. After two weeks of numbers, keep, change or drop the format.
