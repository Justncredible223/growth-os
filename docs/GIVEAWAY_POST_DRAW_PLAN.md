# Giveaway post-draw plan ("Win a year of Fillbook Elite")

Written 2026-10-15. Code: `backend/src/giveaway/giveawayPlan.ts`, run by the `giveaway_plan` step of
`api/daily-pipeline.ts` (core group, once a day, 6:00 AM Arizona). Each milestone becomes one notification
(type `giveaway_plan`) with a checklist and, where a public post helps, a ready draft. **Nothing is posted or emailed for
the owner**; the entry and draw data live in the Fillbook site's database, which Growth OS cannot read, so every reminder is
unconditional ("ignore if done").

## The facts that drive it (official rules, fillbookhq.com/giveaway)

| Fact | Value |
|---|---|
| Opens | Oct 11 2026 12:00 AM EDT |
| Closes | Nov 30 2026 11:59 PM EST (9:59 PM Arizona) |
| Draw | One winner at random, **within 7 days after close** (by Dec 7 11:59 PM EST), cryptographically secure RNG |
| Eligibility | 18+, no purchase necessary, one entry per person |
| To keep the prize | Winner must **still follow @FillbookHQ on X** when drawn; otherwise forfeited and a new winner is drawn the same way |
| Claim | Winner replies to the notification email **within 7 days**, or the prize is forfeited and redrawn |
| Naming the winner | First name and country only, **with their permission** |
| Entrant email | Used to run the giveaway and contact the winner; on the newsletter **only if they ticked the box** |
| Prize for an existing customer | The 12 free months are applied to their account |

## Timeline

| Date (Arizona 6:00 AM) | Milestone | What it carries |
|---|---|---|
| Nov 16 | two-weeks | No post needed; check the pinned post matches the rules |
| Nov 23 | last-week | One reminder post, drafted |
| Nov 30 | last-day | Closes tonight 9:59 PM Arizona; optional post, churn warning |
| Dec 1 | closed | **Draw today.** Full checklist and a no-winner closing post |
| Dec 5 | draw-deadline | Two days to the rules' deadline |
| Dec 9 | afterglow | Winner post (with permission), a one-time "trial" follow-on, what to measure |
| Dec 12 | claim-window | Winner replied? If not, forfeit and redraw |

Countdown reminders expire at the close and the deadline reminder at the deadline, so a missed daily run can never send
"closes tonight" the morning after. Any milestone more than 3 days late is skipped rather than sent as if current.

## Draw checklist (also in the Dec 1 notification)

1. Admin > Giveaway on the Fillbook site; Draw is only available once the giveaway has closed.
2. Draw once; note the entry count.
3. Open `x.com/<winner's handle>` signed in as @FillbookHQ and confirm it says "Follows you". If not: mark Forfeited with a
   note and redraw.
4. Email the winner; ask if they agree to be named (first name and country).
5. When they reply, mark Claimed.
6. Do not send other entrants anything promotional unless `marketing_opt_in` is true.

## Retention: what to expect and how to read it

The giveaway is follow-gated. People who followed only to enter tend to leave afterwards; that is not a content problem and
it cannot be prevented, only understood. The daily follower snapshot (`x_follower_snapshots`) and the Monday X weekly review
(`weeklyDigest.ts`) show the change. Compare the two weeks after Dec 1 with the two weeks before Oct 11 and with the entry
count. The only lever that helps is the feed itself (worth following, one keepable thing a post), which is what the
retention tuning of 2026-10-15 targets.

## What is not here

- No emailing, no posting, no automatic anything. Growth OS stays read-and-draft.
- No entrant tracking in this repo (the data is in the Fillbook database; a cross-repo read would need its own decision).
- If the owner moves the dates, change the constants at the top of `giveawayPlan.ts` and the table above; tests pin them
  to the rules page.
