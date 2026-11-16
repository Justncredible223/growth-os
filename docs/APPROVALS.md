# Approvals: how it works now (2026-11-15)

Reviewed with ChatGPT on 2026-11-15, in three stages: P0 #336, P1 #337 and P2 #338.

## What lands here

Drafts waiting on the owner. A draft appears here when its campaign is `in_review` and its asset is at `ready_for_owner`. Sources:

- HQ X drafts (`api/hq-handoff`)
- the daily auto-draft
- video scripts
- Campaign Factory runs

Today's X Post and partnership pitches have their own screens.

## Intake (HQ)

A new HQ draft is refused with a 422 and the reason when it:

- carries a writer's note, such as a character count, a placeholder or "here's a draft";
- has markdown labels, a link, an unverified claim, a false giveaway claim or a dash problem;
- is too close to a draft already waiting or to a post from the last 30 days (word overlap of 0.6 or more).

If a handoff fails half way, HQ's retry finishes it.

## Deciding

- Approve or Reject moves a campaign only out of `in_review`, in one conditional update.
  - Repeating the same decision changes nothing.
  - The opposite decision returns 409.
  - A missing draft returns 404.
- A card whose text contains a writer's note holds Approve and Copy until it is fixed or rejected.
- **Edit** saves the owner's text as the next content version (`owner_edit`). Rules:
  - The AI's text stays as the earlier version.
  - Only waiting drafts can be edited.
  - An edited X post must pass the same deterministic checks as an HQ draft.
- **Accepted limitation (ChatGPT 2026-11-15):** an owner's edit is not re-reviewed by AI. The deterministic checks run on it, and the owner still approves it by hand.

## The queue

- Oldest first. Each card shows its source and how long it has waited.
- HQ drafts are titled with their first line.
- A card that says nearly the same as other waiting drafts gets a warning.
- Drafts waiting 7 days or more are flagged. "Reject old drafts" rejects them with the reason "Too old", after a confirm. Nothing is ever deleted or rejected automatically.
- When the waiting drafts reach the auto-draft cap (3), the tab says the daily auto-draft is paused. The cap itself is unchanged.

## After approval

- **Approval is not publication.** "Approved, not posted" lists approved text drafts from the last 30 days with no confirmed post.
- **Mark posted** asks "Did you post this?", takes an optional link, and records it in `content_publications`.
- **Read-only list:** loading the Approvals list writes nothing to the database.

## Next (ChatGPT)

Measure the approved-to-posted rate and the backlog age before adding features.
