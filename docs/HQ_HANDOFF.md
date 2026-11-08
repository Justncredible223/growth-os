# Fillbook HQ handoff (POST /api/hq-handoff)

HQ's social agent sends at most one X draft a day; it lands in Approvals and the owner posts it by hand. Nothing here posts, follows, likes or DMs.

- **Default off.** Answers 404 until `HQ_HANDOFF_TOKEN` (32+ characters) is set on the growth-os Vercel project. Kill switch: set `HQ_HANDOFF=off`.
- **Served from `api/approvals.ts`** via a `vercel.json` rewrite (`/api/hq-handoff` to `/api/approvals?resource=hq-handoff`), because the Hobby plan caps functions at 12.
- **Request:** `Authorization: Bearer <token>`, JSON `{hqDraftId, role:"social", platform:"x", contentType:"x_post", text, compliance:{verdict, revisionCount}, desk:{decision:"ready", reason}, imageBrief: string<=240 | null}`.
- **Responses:** 201 stored (`assetId`), 200 repeat of the same draft (`duplicate`), 400 bad body, 401 bad token, 404 off, 409 same id with different text, 422 text refused (link, unverified claim, false giveaway claim, em dash), 429 more than 10 in 10 minutes.
- **Storage:** an `x_feed_post` asset at `ready_for_owner` (campaign `in_review`), version 1 body = text, `content_versions.metadata` = `{source:"hq_handoff", hqDraftId, verdict, revisionCount, deskReason, imageBrief}`. No migration.
- **Approvals** shows HQ's verdict, desk reason and picture idea as information (never authorization) and the same picture card as Today's X Post. Copy & Share hands the text to X; the owner attaches the picture by hand.
