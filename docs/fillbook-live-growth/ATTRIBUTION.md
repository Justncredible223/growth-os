# Attribution and measurement

## Tracked links
Built by `backend/src/liveHost/liveHostLinks.ts` (`buildTrackedUrl`), canonical host `https://www.fillbookhq.com/`.

| Placement | utm_source | utm_medium | utm_campaign | utm_content |
|---|---|---|---|---|
| Live description | youtube | description | fillbook-live-YYYY-MM-DD | description |
| Pinned comment | youtube | comment | fillbook-live-YYYY-MM-DD | pinned-comment |
| Stream link / clip | youtube | video | fillbook-live-YYYY-MM-DD | live or short |

Deviation from the suggested `utm_medium=live` / `utm_campaign=fillbook_live`: the site's link tooling (`frontend/src/lib/campaignLinks.ts`) enforces slug-safe campaign names (no underscores) and a fixed medium list, and `analytics.ts` already buckets `utm_source=youtube`. Using the site's own convention keeps the admin growth tables correct.

The on-screen site card shows plain `fillbookhq.com` (readable; TikTok layout shows nothing). The tracked URL goes in the description and pinned comment.

## What is measured where
| Metric | Source | Status |
|---|---|---|
| Impressions, CTR, peak/average viewers, watch time, retention, returning viewers | YouTube Studio | Manual: not available to the Live Host (needs YouTube Analytics API OAuth scope, not set up) |
| Stream uptime, tick failures, lines spoken, chat messages, unique chatters, answered share, Fillbook mentions, spend | Live Host (`npm run live-host:report`) | Implemented, not verified against a real deployed run |
| Landing visits and source bucket | Site analytics (`analytics.ts` buckets `youtube`) | Existing; tracked-link visit not yet checked end to end |
| Signups | Site (account created with source youtube) | Existing |
| Activation | `activation_insight_delivered` (plan-independent) and `first_trade_logged` | Existing events; both can be read per user |

Views and clicks are never counted as acquisition. A person counts as acquired only when an account exists whose first-touch source is youtube and activated only when one of the events above fired.

## Smallest safe step for platform metrics
Create a read-only YouTube Analytics API OAuth consent for the channel (scope `yt-analytics.readonly`), store the refresh token as a secret the owner pastes, and add a report step that joins by video id. Not done: needs the owner's consent flow.
