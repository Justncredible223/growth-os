package com.fillbook.growthos.data

/**
 * Interface the UI depends on. FakeGrowthOsRepository (below) is the only
 * implementation right now, since the backend isn't deployed yet (see
 * docs/PROGRESS_LEDGER.md Phase 7). A future NetworkGrowthOsRepository
 * calling the deployed Vercel API is a drop-in replacement — no screen
 * code should need to change.
 */
interface GrowthOsRepository {
    suspend fun getHomeSummary(): HomeSummary
    suspend fun getHealth(): List<HealthItem>
    suspend fun getOpportunities(): List<Opportunity>
    /**
     * Manually runs one open opportunity through the same draft -> mechanical
     * gate -> deep review pipeline the automated (max 1/day) auto-draft
     * uses. Never publishes anything -- the furthest an asset can reach is
     * ready_for_owner, i.e. it shows up in Approvals for a human decision.
     * Costs real LLM tokens (one draft + up to nine review calls).
     */
    suspend fun runCampaignForOpportunity(opportunityId: String): CampaignRunResult
    /**
     * "Create Fillbook Video" (2026-09-08): requests a video_script draft
     * for EITHER a custom, owner-typed [topic] OR an existing [opportunityId]
     * -- exactly one of the two must be non-null, enforced server-side, not
     * just by convention here. Reuses the exact same pipeline as
     * [runCampaignForOpportunity] (review agents, grounding, budget/paused
     * gate, idempotency) -- the only difference is the resulting
     * campaign_asset is explicitly asset_type "video_script" and the
     * writer produces a real production package (hook/script/shot list/
     * YouTube+TikTok metadata) instead of a plain text post. The backend
     * rejects an off-topic [topic] (not futures/prop-firm/trading-
     * discipline) with a clear error BEFORE any LLM call, so this can
     * throw for a reason distinct from a network failure -- see
     * DraftRejectedException is NOT used here (that's for a content-
     * generation rejection after the LLM already ran); an off-topic/
     * duplicate/invalid request surfaces as a plain [NetworkException]
     * with a real message from the backend's own 400/409 body.
     */
    suspend fun requestVideoScript(motionConceptId: String): CampaignRunResult
    /**
     * The small, fixed catalog of concepts that have REAL verified
     * product-motion footage (backend's src/shortform/pilots.ts +
     * verified-manifest.json) -- shown in "Create Fillbook Video" as a
     * distinct third option from a custom topic (stock footage/
     * screenshots) or an existing opportunity, so the owner never assumes
     * an arbitrary topic will get a custom recording. Passing one of
     * these ids as [requestVideoScript]'s motionConceptId is the ONLY way
     * to get real motion -- the backend never infers it from topic text.
     */
    suspend fun getMotionConceptCatalog(): MotionConceptCatalog
    /**
     * Research Lab (2026-09-07): requests a private, internal research
     * report for EITHER a custom, owner-typed [topic] OR an existing
     * [opportunityId] -- exactly one of the two must be non-null, enforced
     * server-side, not just by convention here. Reuses the exact same
     * pipeline as [runCampaignForOpportunity]/[requestVideoScript]
     * (grounding, budget/paused gate, idempotency) -- the difference is
     * the resulting campaign_asset is asset_type "research", the writer
     * produces a ResearchReport instead of public-facing content, and the
     * nine-agent deep review is deliberately skipped (see
     * campaignPipeline.ts's own doc comment for why). The backend rejects
     * an off-topic [topic] with a clear error BEFORE any LLM call, same as
     * [requestVideoScript] -- an off-topic/duplicate/invalid request
     * surfaces as a plain [NetworkException] with a real message from the
     * backend's own 400/409 body.
     */
    suspend fun requestResearch(topic: String?, opportunityId: String?): CampaignRunResult
    /**
     * Every research record the owner has ever requested, most recent
     * first -- the durable source of truth for research status
     * (ready_for_review/approved/rejected/failed).
     */
    suspend fun listResearch(): List<ResearchRecord>
    /**
     * The lightweight path for a single-post engagement opportunity --
     * one real LLM call, never the multi-agent campaign pipeline. Nothing
     * is persisted server-side; the draft is only ever returned for the
     * owner to review before they copy it themselves.
     */
    suspend fun draftOpportunityReply(opportunityId: String): String
    suspend fun getApprovals(): List<ApprovalAsset>
    suspend fun getCreators(): List<Creator>
    suspend fun getCampaigns(): List<Campaign>
    suspend fun getCostSummary(): CostSummary
    /**
     * Records the human decision -- approve or reject -- for one
     * campaign asset. Never publishes anything; only changes what this
     * app displays. The owner still does the actual posting themselves.
     *
     * Returns the render outcome when an approved asset was a video script (queued, already running, or
     * refused with a reason such as the daily render limit), and null otherwise.
     */
    suspend fun decideApproval(campaignAssetId: String, approve: Boolean, reason: String? = null): VideoRenderOutcome?
    /** Wires CampaignFactory.handOffToOwner() -- EXTERNAL_DRAFT only, "opened the composer," never a publish. */
    suspend fun handOffAsset(campaignAssetId: String): HandOffResult

    /**
     * Forces a fresh attempt at Today's X Post -- used for the Home
     * screen's "Regenerate" action after a failed generation, or to
     * replace a post the owner explicitly dismissed. Bounded server-side
     * (see backend's MAX_ATTEMPTS_PER_DAY); never replaces a post that's
     * still genuinely ready/handed off/posted.
     */
    suspend fun regenerateTodayXPost(): TodayXPost
    /**
     * The owner's own explicit confirmation that a handed-off X feed post
     * actually went out on X -- a separate, later step than handoff
     * itself (see TodayXPost's kdoc). Never inferred. [postedText] is the
     * FINAL text as edited by the owner (not necessarily the original
     * draft) -- required so future originality checks compare against
     * what was actually posted, not a pre-edit draft.
     */
    suspend fun markTodayXPostPosted(campaignAssetId: String, postedText: String): TodayXPost
    /** Prior days' X feed post runs (never today's own) -- the Previous Drafts / history surface. */
    suspend fun getTodayXPostHistory(): List<XFeedPostHistoryEntry>

    /** Backs the Settings/System "Pause System" control -- actually stops auto-draft and manual campaign runs server-side, not just a display flag. */
    suspend fun setPaused(paused: Boolean)

    /** The active Inbound Engagement Queue -- everything not yet resolved (new/needs_response/draft_ready/follow_up/review_needed). */
    suspend fun getInboundQueue(): List<InboundEngagement>
    /** Command Center counts: needs response / follow-ups / repeat engagers / overdue. */
    suspend fun getInboundSummary(): InboundSummary
    /** Generates a reply draft via the LLM and moves the item to draft_ready -- never sends anything. */
    suspend fun draftInboundResponse(id: String): InboundEngagement
    /** The ONLY action that sets status=responded -- an explicit confirmation the owner actually replied on the platform themselves. */
    suspend fun markInboundResponded(id: String, note: String? = null, finalResponse: String? = null)
    suspend fun markInboundFollowUp(id: String)
    suspend fun closeInbound(id: String)
    /** Ignores the ingestion cursor and re-checks the recent window -- the "we found unanswered replies" recovery pass. */
    suspend fun runInboundBacklogRecovery()

    /** The active Prospecting queue -- OTHER people's public X posts worth replying to, ranked highest score first. Marks any still-"new" rows "shown" server-side, so a refresh never presents the same candidate as freshly found twice. [ProspectingQueueResult.diagnostics] is null only when the API response predates that field -- never fabricated client-side. */
    suspend fun getProspectingQueue(): ProspectingQueueResult
    /** Generates a reply draft via the LLM for one candidate -- never persisted as sent, never posted. Costs one real LLM call. */
    suspend fun draftProspectingReply(id: String): ProspectingCandidate
    /** Records that the owner tapped "Open on X" for this candidate -- timestamp only, no status change. */
    suspend fun openProspectingCandidate(id: String)
    /** The ONLY action that sets status=replied -- an explicit confirmation the owner actually posted on X themselves. Also records outreach so Inbound recognizes this author if they reply back later. */
    suspend fun markProspectingReplied(id: String, finalReply: String?, mentionsFillbook: Boolean?, usedLink: Boolean?): ProspectingCandidate
    suspend fun markProspectingSkipped(id: String, reason: String?)
    suspend fun markProspectingNotRelevant(id: String)
    suspend fun markProspectingAlreadyHandled(id: String)
    /** Owner-triggered, immediate Prospecting search -- searches a fresh, randomized topic slice right now instead of waiting for the next 08:00/13:00/18:00 scheduled slot. Same pause/monthly-budget/queue-capacity guardrails as the scheduled run apply automatically server-side; this can't bypass them. Call getProspectingQueue() afterward to pick up any new candidates. */
    suspend fun runProspectingSearchNow(): ProspectingSearchRunResult

    /** The full Partnerships pipeline -- prospect/qualify/draft/contact/pilot/outcome. Never sends anything; every write here is either a plain field edit or an explicit, human-confirmed step. Includes what the last discovery run (scheduled or owner-triggered) actually did. */
    suspend fun getPartnerships(): PartnershipsSummary
    /** Owner-triggered, bounded discovery refresh (see backend's discovery.ts) -- never contacts anyone, only qualifies new candidates for review. */
    suspend fun refreshPartnershipDiscovery(): PartnershipDiscoveryRunResult
    suspend fun createPartnership(
        organizationName: String,
        contactName: String?,
        partnerCategory: PartnerCategory,
        websiteUrl: String?,
        proposedCollaboration: String?,
    ): PartnershipProspect
    suspend fun updatePartnership(id: String, ownerNotes: String?, nextAction: String?, nextActionDueDate: String?, contactRoute: String?, contactRouteSource: String?, audienceFocus: String?, futuresRelevanceEvidence: String?): PartnershipProspect
    suspend fun qualifyPartnership(id: String, rationale: String): PartnershipProspect
    /** Runs the real campaign pipeline (mechanical gate + all 9 review agents) -- costs real LLM tokens, gated by Partnerships' own independent monthly budget. */
    suspend fun generatePartnershipDraft(id: String): PartnershipProspect
    /** The ONLY action that ever moves a prospect to 'contacted' -- never inferred from copying/opening a channel. [finalText] is the actual text sent, which may differ from the draft after an edit. */
    suspend fun markPartnershipContacted(id: String, channel: String, finalText: String): PartnershipProspect
    /**
     * Sends the pitch directly via Resend instead of copy+mailto -- only
     * offered for a prospect whose contactRoute is an email address. Same
     * approved-draft precondition as markPartnershipContacted server-side,
     * and marks the prospect contacted the same way on success. Throws
     * with a clear reason (not an email contact, RESEND_API_KEY not
     * configured yet) rather than silently no-op-ing.
     */
    suspend fun sendPartnershipEmail(id: String, subject: String, finalText: String): PartnershipProspect
    suspend fun recordPartnershipReply(id: String, summary: String): PartnershipProspect
    suspend fun startPartnershipPilot(id: String, termsAgreed: String, startDate: String): PartnershipProspect
    suspend fun activatePartnership(id: String): PartnershipProspect
    suspend fun closePartnership(id: String, reason: String): PartnershipProspect
    suspend fun archivePartnership(id: String, reason: String): PartnershipProspect
    suspend fun markPartnershipDoNotContact(id: String, reason: String): PartnershipProspect

    /** The latest Strategy Evolution report, or null if none has been generated yet. */
    suspend fun getLatestStrategy(): StrategyVersion?
    /** Forces a fresh strategy report now, regardless of the normal weekly schedule -- for the Strategy screen's manual "Regenerate" action. */
    suspend fun regenerateStrategy(): StrategyVersion

    suspend fun getExperiments(): List<Experiment>
    suspend fun createExperiment(hypothesis: String, scopePlatform: String?, scopeAssetType: String?, guardrailNote: String?, startDate: String, controlWindowDays: Int): Experiment
    /** Refreshes a running experiment's result without ending it. */
    suspend fun measureExperiment(id: String): Experiment
    /** Computes a final result and marks the experiment completed. */
    suspend fun completeExperiment(id: String): Experiment
    suspend fun abortExperiment(id: String)

    /** Real, meaningful-events-only in-app notifications -- see backend/src/notifications/notificationEngine.ts. Not OS-level push (that needs Firebase, a separate owner setup step). */
    suspend fun getNotifications(): Pair<List<AppNotification>, Int>
    suspend fun markNotificationRead(id: String)
    suspend fun markAllNotificationsRead()

    suspend fun getMorningBrief(): MorningBrief
    suspend fun getEveningReport(): EveningReport

    /**
     * Registers (or re-activates) this device's current FCM token for
     * video-render push delivery. Safe to call repeatedly with the same
     * token -- the backend upserts on the token's own uniqueness. Never
     * throws upward from a fire-and-forget caller's perspective is NOT
     * guaranteed here -- callers (MainActivity's startup registration,
     * FillbookMessagingService's onNewToken) are responsible for catching
     * their own failures, since a transient registration failure must
     * never crash or block anything else.
     */
    suspend fun registerDeviceToken(fcmToken: String)

    /**
     * Every video render the owner has ever approved, most recent first --
     * the durable source of truth for render state (queued/rendering/
     * ready/failed/canceled), independent of whether any push notification
     * about it was ever actually delivered. See migration 0027 and the
     * Video Status screen.
     */
    suspend fun getVideoRenderStatuses(): List<VideoRenderStatus>

    /** Deletes a failed or canceled render from the list so the owner can clear stuck items. */
    suspend fun dismissVideoRender(videoRenderId: String)

    /** Re-queues a failed render. Returns null when queued, or the reason it was refused (a render cap). */
    suspend fun retryVideoRender(videoRenderId: String): String?

    /**
     * Records the real external URL the owner pasted in after manually
     * posting a 'ready' video (TikTok/YouTube/Instagram). This is what
     * lets the backend's YouTube comment monitoring know which real, live
     * video to poll -- see backend/src/video/videoStatusHandlers.ts's
     * setPublishedUrl. Throws with a real backend error message (e.g. "not
     * a real http(s) URL") on rejection -- never silently swallowed.
     */
    suspend fun setVideoPublishedUrl(videoRenderId: String, publishedUrl: String)

    /** Today's posting plan plus the last 30 days of results -- see Posting.kt. */
    suspend fun getPostingOverview(): PostingOverview

    /** Records where a video was posted on one platform (re-recording the same platform replaces the link). */
    suspend fun recordVideoPost(campaignAssetId: String, videoRenderId: String?, platform: PostingPlatform, url: String)

    /** Records numbers typed in for a TikTok or Instagram post. */
    suspend fun recordPostStats(videoPostId: String, views: Int?, likes: Int?, comments: Int?, shares: Int?)
}

/**
 * Seeded with real content drawn from FillbookHQ's actual growth history
 * (docs/SEED_DATA_SOURCES.md) rather than generic placeholder text, so the
 * app is honest about what it will actually show once wired to the real
 * backend.
 */
class FakeGrowthOsRepository : GrowthOsRepository {
    private var fakeTodayXPost = TodayXPost(
        state = TodayXPostState.READY,
        campaignAssetId = "asset-fake-1",
        previewText = "Revenge trading doesn't show up as \"revenge\" in your P&L -- it shows up as funded-account breach.",
        topicLabel = "The mechanics of a revenge-trading spiral",
        selectionReason = "Selected \"The mechanics of a revenge-trading spiral\" (score 15.5) over 2 other candidates considered, incl. \"Position sizing in the hour after a loss\" (14.0): less overlap with recently used lessons/conclusions. This is the strongest of the candidates actually compared here, not a claim that no better post exists.",
    )
    private var fakeHistory = listOf(
        XFeedPostHistoryEntry(
            operatingDate = "2026-09-04",
            state = XFeedPostHistoryState.UNPOSTED_DRAFT,
            topicLabel = "What a prop-firm consistency rule actually enforces",
            previewText = "Consistency rules usually cap what ONE day can count toward your payout, not your total P&L -- a great day can quietly exceed that cap without you ever \"overtrading.\"",
            reason = null,
            campaignAssetId = "asset-fake-history-1",
        ),
        XFeedPostHistoryEntry(
            operatingDate = "2026-09-03",
            state = XFeedPostHistoryState.FAILED,
            topicLabel = "Trailing drawdown mechanics",
            previewText = null,
            reason = "review gate: fact_checker: unverified claim about breach statistics",
            campaignAssetId = null,
        ),
        XFeedPostHistoryEntry(
            operatingDate = "2026-09-02",
            state = XFeedPostHistoryState.POSTED,
            topicLabel = "The journaling habit that actually sticks",
            previewText = "Most journals die because they only log wins and losses -- never the process that led to either. Track the decision, not just the outcome.",
            reason = null,
            campaignAssetId = "asset-fake-history-3",
        ),
    )

    /**
     * FIXTURE-ONLY: switches the fake Today's X Post state to one of the
     * named scenarios below, for on-device rendering verification (see
     * docs/PROGRESS_LEDGER.md's Today's X Post release-readiness section)
     * -- never used by real app code, only a temporary debug affordance
     * while FakeGrowthOsRepository is wired in for screenshotting.
     */
    fun debugSetTodayXPostFixture(scenario: String) {
        fakeTodayXPost = when (scenario) {
            "ready" -> TodayXPost(
                state = TodayXPostState.READY,
                campaignAssetId = "asset-fake-1",
                previewText = "Revenge trading doesn't show up as \"revenge\" in your P&L -- it shows up as funded-account breach.",
                topicLabel = "The mechanics of a revenge-trading spiral",
                selectionReason = "Selected \"The mechanics of a revenge-trading spiral\" over 2 other candidates -- less overlap with recently used lessons.",
            )
            "running" -> TodayXPost(state = TodayXPostState.RUNNING, campaignAssetId = null, previewText = null)
            "failed" -> TodayXPost(
                state = TodayXPostState.FAILED,
                campaignAssetId = null,
                previewText = null,
                reason = "review gate: fact_checker: unverified claim about breach statistics; skeptic: reads as hype",
                canRegenerate = true,
            )
            "replacement_failure" -> TodayXPost(
                state = TodayXPostState.FAILED,
                campaignAssetId = null,
                previewText = null,
                reason = "stopped mid-run: monthly_budget_reached (\$6.0000 spent, cap is \$6.00) -- Regenerate attempt did not produce a passing replacement",
                canRegenerate = true,
            )
            "handed_off" -> TodayXPost(
                state = TodayXPostState.HANDED_OFF,
                campaignAssetId = "asset-fake-1",
                previewText = null,
                topicLabel = "The mechanics of a revenge-trading spiral",
            )
            "posted" -> TodayXPost(
                state = TodayXPostState.POSTED,
                campaignAssetId = "asset-fake-1",
                previewText = null,
                topicLabel = "The mechanics of a revenge-trading spiral",
            )
            else -> fakeTodayXPost
        }
    }

    override suspend fun getHomeSummary() = HomeSummary(
        video = TodaysVideo(TodaysVideoState.NEEDS_APPROVAL, "5 contracts against a plan of 3", 5, "Waiting for your approval", "Read the script in Approvals. Approving it starts the render."),
        signalsAnalyzedToday = 0,
        opportunitiesFound = 1,
        assetsReady = 0,
        pendingReview = 0,
        systemPaused = false,
        analytics = AnalyticsBreakdown(
            totalSignals = 25,
            signalsBySource = mapOf("x_mention" to 19, "youtube_video" to 6),
            opportunitiesByStatus = mapOf("open" to 12, "actioned" to 1),
            campaignAssetsByStage = mapOf("draft" to 1, "final_draft" to 1, "ready_for_owner" to 1),
            totalCostUsd = 0.09,
            todaySpendUsd = 0.0035,
            autoDraft = AutoDraftStatus(
                lastRunDate = "2026-09-08",
                lastRunStatus = "drafted",
                lastRunSkipReason = null,
                backlogCount = 1,
                backlogCap = 3,
                monthSpendUsd = 0.09,
                monthBudgetUsd = 5.0,
            ),
        ),
        todayXPost = fakeTodayXPost,
    )

    override suspend fun getHealth() = listOf(
        HealthItem("Supabase", HealthStatus.HEALTHY, "fillbook-growth-os project, live"),
        HealthItem("Job queue", HealthStatus.HEALTHY, "0 pending, 0 dead-lettered"),
        HealthItem("Search Console", HealthStatus.NOT_CONNECTED, "Needs a Google Cloud OAuth app (owner action)"),
        HealthItem("X", HealthStatus.NOT_CONNECTED, "Needs an X developer app (owner action)"),
        HealthItem("AI provider", HealthStatus.NOT_CONNECTED, "Needs an API key for deep content review"),
    )

    override suspend fun getOpportunities() = listOf(
        Opportunity(
            id = "opp-1",
            title = "Trailing drawdown rules confuse more traders than max drawdown",
            score = 78.4,
            urgency = Urgency.HIGH,
            rationale = "High audience relevance (prop-firm traders), strong Fillbook fit (drawdown tracking is a real feature), no recent coverage on this exact angle.",
            channels = listOf("X", "YouTube Shorts"),
        ),
        Opportunity(
            id = "opp-2",
            title = "x_mention: how do you handle a trailing drawdown reset on a funded account?",
            score = 62.0,
            urgency = Urgency.NORMAL,
            rationale = "A single real X mention worth a direct reply, not a full campaign.",
            channels = listOf("X"),
            sourceUrl = "https://x.com/i/web/status/999",
            authorHandle = "someTrader",
        ),
    )

    override suspend fun runCampaignForOpportunity(opportunityId: String) = CampaignRunResult(
        finalStage = "ready_for_owner",
        blockReasons = emptyList(),
        costUsd = 0.03,
    )

    override suspend fun requestVideoScript(motionConceptId: String) = CampaignRunResult(
        finalStage = "ready_for_owner",
        blockReasons = emptyList(),
        costUsd = 0.09,
    )

    override suspend fun getMotionConceptCatalog(): MotionConceptCatalog = MotionConceptCatalog(
        concepts = listOf(
            MotionConcept(id = "daily-02-orb-setup", title = "One setup: 8 trades, 25% win, lost $422", hook = "One setup wins only 25%. Overall 64%.", topic = "A sample account's setup report: its weakest setup", day = 2),
            MotionConcept(id = "daily-03-busy-day", title = "6 trades against a norm of 2.7", hook = "6 trades. Your norm: only 2.7 a day.", topic = "A sample account's flagged busy days", day = 3),
            MotionConcept(id = "daily-04-accounts-target", title = "Two accounts: 52% and 13% to target", hook = "52% to target here. Only 13% there.", topic = "A sample accounts overview", day = 4),
        ),
        unavailable = listOf(UnavailableMotionConcept(id = "daily-01-brief-room", title = "$1,725 to the floor, $1,000 left today", state = "made", day = 1)),
        dailyLimit = DailyRequestLimit(requestedToday = null, nextRequestAt = null),
        nextConceptId = "daily-02-orb-setup",
    )

    override suspend fun requestResearch(topic: String?, opportunityId: String?) = CampaignRunResult(
        finalStage = "ready_for_owner",
        blockReasons = emptyList(),
        costUsd = 0.02,
    )

    private val fakeResearchRecords = listOf(
        ResearchRecord(
            id = "research-fake-1",
            title = "Trailing drawdown confusion among funded traders",
            question = "Do funded traders understand how trailing drawdown is calculated?",
            summary = "Many funded traders confuse trailing drawdown with a fixed daily loss limit, especially around EOD balance-based calculations.",
            findings = listOf(
                "Trailing drawdown is commonly confused with a static daily loss limit.",
                "EOD balance-based trailing calculations are the most misunderstood variant.",
            ),
            evidenceReferences = listOf("Fillbook prop-firm drawdown tracking doc"),
            caveats = listOf("General trading-domain reasoning, not verified against Fillbook's own knowledge base."),
            contentAngles = listOf("A short explainer comparing trailing vs static drawdown."),
            status = "ready_for_review",
            costUsd = 0.021,
            createdAt = "2026-09-06T14:00:00Z",
        ),
        ResearchRecord(
            id = "research-fake-2",
            title = "Why funded traders overtrade after a loss",
            question = "What patterns precede a revenge-trading spiral?",
            summary = "Revenge trading typically follows an unexpected loss on a trade the trader felt confident about.",
            findings = listOf("Position sizing tends to increase immediately after an unexpected loss."),
            evidenceReferences = emptyList(),
            caveats = listOf("General trading-domain reasoning, not verified against Fillbook's own knowledge base."),
            contentAngles = listOf("A video on spotting the first warning sign of a revenge-trading spiral."),
            status = "approved",
            costUsd = 0.019,
            createdAt = "2026-09-04T09:00:00Z",
        ),
    )

    override suspend fun listResearch(): List<ResearchRecord> = fakeResearchRecords

    override suspend fun draftOpportunityReply(opportunityId: String) =
        "Depends on the firm -- most reset trailing drawdown at end of day, but a few use a static floor instead. Worth checking your specific rulebook."

    override suspend fun getApprovals() = emptyList<ApprovalAsset>()

    override suspend fun getCreators() = listOf(
        Creator(
            id = "creator-fake-1",
            handle = "@wannabechamp",
            displayName = "Dan Cheung",
            platform = "x",
            category = CreatorCategory.TIER_B,
            readinessScore = 2,
            followerCount = 40100,
            creatorProductMoment = "Journaling / journal-review discussions -- directly the product's core format.",
            notes = "Trading-journal/risk-management educator.",
            rejectionReason = null,
            lastInteractionAt = "2026-08-31T12:00:00Z",
        ),
    )

    override suspend fun getCampaigns() = listOf(
        Campaign(
            id = "campaign-fake-1",
            thesis = "A trader publicly told @FillbookHQ that revenge trading is what's breaching their funded accounts",
            status = "actioned",
            decidedBy = null,
            decidedAt = null,
            assets = listOf(
                CampaignAsset(
                    id = "asset-fake-1",
                    platform = "x",
                    assetType = "post",
                    stage = "ready_for_owner",
                    latestBody = "Revenge trading doesn't show up as \"revenge\" in your P&L -- it shows up as funded-account breach. One trade to fix the last one, every time, until you're done. Track the pattern or keep resetting.",
                    reviewPassCount = 9,
                    reviewFailCount = 0,
                ),
            ),
        ),
    )

    override suspend fun getCostSummary() = CostSummary(
        totalCostUsd = 0.02,
        last24hCostUsd = 0.02,
        totalCalls = 20,
    )

    override suspend fun decideApproval(campaignAssetId: String, approve: Boolean, reason: String?): VideoRenderOutcome? {
        // No backend to call in fake mode -- no-op.
        return null
    }

    override suspend fun setPaused(paused: Boolean) {
        // No backend to call in fake mode -- no-op.
    }

    override suspend fun handOffAsset(campaignAssetId: String): HandOffResult {
        if (fakeTodayXPost.campaignAssetId == campaignAssetId) {
            fakeTodayXPost = fakeTodayXPost.copy(state = TodayXPostState.HANDED_OFF)
        }
        return HandOffResult(campaignAssetId, "handed_off")
    }

    override suspend fun regenerateTodayXPost(): TodayXPost {
        fakeTodayXPost = TodayXPost(
            state = TodayXPostState.READY,
            campaignAssetId = "asset-fake-regenerated",
            previewText = "A flat stretch on your equity curve can be a controlled drawdown, not stagnation -- check the trade count, not just the slope.",
            topicLabel = "What your own equity curve is actually telling you",
        )
        return fakeTodayXPost
    }

    override suspend fun markTodayXPostPosted(campaignAssetId: String, postedText: String): TodayXPost {
        if (fakeTodayXPost.campaignAssetId == campaignAssetId) {
            fakeTodayXPost = fakeTodayXPost.copy(state = TodayXPostState.POSTED)
        }
        return fakeTodayXPost
    }

    override suspend fun getTodayXPostHistory(): List<XFeedPostHistoryEntry> = fakeHistory

    private val inboundItems = mutableListOf(
        InboundEngagement(
            id = "inbound-fake-1",
            platform = "x",
            authorHandle = "someTrader",
            body = "how do you handle trailing drawdown resets on a funded account?",
            inResponseToText = "Revenge trading doesn't show up as \"revenge\" in your P&L...",
            priority = InboundPriority.P1_DIRECT_REPLY,
            status = "needs_response",
            draftResponse = null,
            respondedAt = null,
            isRepeatEngager = false,
            creatorHandle = null,
            observedAt = "2026-09-01T18:00:00Z",
            sourceReference = "https://x.com/i/web/status/1",
        ),
        InboundEngagement(
            id = "inbound-fake-2",
            platform = "x",
            authorHandle = "wannabechamp",
            body = "following up -- did you ever add the journal-review export I asked about?",
            inResponseToText = null,
            priority = InboundPriority.P2_RELATIONSHIP,
            status = "needs_response",
            draftResponse = null,
            respondedAt = null,
            isRepeatEngager = true,
            creatorHandle = "wannabechamp",
            observedAt = "2026-08-30T09:00:00Z",
            sourceReference = "https://x.com/i/web/status/2",
        ),
    )

    override suspend fun getInboundQueue() = inboundItems.filter { it.status != "closed" && it.status != "responded" }

    override suspend fun getInboundSummary() = InboundSummary(
        needsResponse = inboundItems.count { it.status == "needs_response" },
        followUp = inboundItems.count { it.status == "follow_up" },
        repeatEngagers = inboundItems.count { it.isRepeatEngager && it.status != "closed" && it.status != "responded" },
        overdue = 0,
    )

    /** FIXTURE-ONLY: when set to "banned_phrase" or "unverified_claim", the next draftInboundResponse() call throws DraftRejectedException with the EXACT real message the backend's reply guardrail sends for that violation -- lets the rejection path be verified on-device without a paid call. "with_mention" returns a clean draft that includes an earned, soft Fillbook mention instead of the default no-mention draft. Resets to null after one use. Never used by production code. */
    var debugNextInboundOutcome: String? = null

    override suspend fun draftInboundResponse(id: String): InboundEngagement {
        val forced = debugNextInboundOutcome
        debugNextInboundOutcome = null
        when (forced) {
            "banned_phrase" -> throw DraftRejectedException("Draft rejected -- uses the banned generic phrase \"check out our platform\". Try drafting again.")
            "unverified_claim" -> throw DraftRejectedException("Draft rejected -- speaks in first person about personally trading, which Fillbook (a product) must never do. Try drafting again.")
        }
        val index = inboundItems.indexOfFirst { it.id == id }
        val draft = if (forced == "with_mention") {
            "That's the classic problem with spreadsheet journaling -- you catch the pattern two weeks too late. That's one of the things we're trying to make easier with Fillbook: flagging the repeat mistake while it's still happening."
        } else {
            "Trailing drawdown typically resets at end-of-day on most prop firms -- worth double-checking your specific firm's rule since a few use a static floor instead."
        }
        val updated = inboundItems[index].copy(status = "draft_ready", draftResponse = draft)
        inboundItems[index] = updated
        return updated
    }

    override suspend fun markInboundResponded(id: String, note: String?, finalResponse: String?) {
        val index = inboundItems.indexOfFirst { it.id == id }
        inboundItems[index] = inboundItems[index].copy(status = "responded", respondedAt = "2026-09-01T19:00:00Z")
    }

    override suspend fun markInboundFollowUp(id: String) {
        val index = inboundItems.indexOfFirst { it.id == id }
        inboundItems[index] = inboundItems[index].copy(status = "follow_up")
    }

    override suspend fun closeInbound(id: String) {
        val index = inboundItems.indexOfFirst { it.id == id }
        inboundItems[index] = inboundItems[index].copy(status = "closed")
    }

    override suspend fun runInboundBacklogRecovery() {
        // No backend to call in fake mode -- no-op.
    }

    private val prospectingItems = mutableListOf(
        ProspectingCandidate(
            id = "prospect-fake-1",
            platform = "x",
            discoveryQuery = "trailing_drawdown",
            discoveryLabel = "Trailing drawdown",
            replyClass = "A",
            authorHandle = "futuresGrind",
            authorFollowerCount = 3400,
            authorVerified = false,
            postText = "does trailing drawdown lock in at end of day or is it live the whole session? every firm explains it differently and I'm losing my mind",
            postUrl = "https://x.com/i/web/status/501",
            postCreatedAt = "2026-09-03T18:00:00Z",
            discoveredAt = "2026-09-03T20:15:00Z",
            opportunityScore = 78.2,
            scoreBreakdown = mapOf(
                "topicRelevance" to "\"Trailing drawdown\" (risk_management) -> +16",
                "activeDiscussion" to "3 replies, 0 quotes, 9 likes -> +9.8",
                "authorReach" to "3400 followers -> +11.3 (capped at 15)",
                "recency" to "posted 2.1h ago -> +14.3",
                "valueOpportunity" to "asks a question, enough context -> +15",
            ),
            creatorCandidate = false,
            status = "shown",
            draftReply = null,
            replyMentionsFillbook = null,
            replyUsedLink = null,
        ),
        ProspectingCandidate(
            id = "prospect-fake-2",
            platform = "x",
            discoveryQuery = "blown_account",
            discoveryLabel = "Blown account",
            replyClass = "A",
            authorHandle = "smallAccountTrader",
            authorFollowerCount = 620,
            authorVerified = false,
            postText = "blew my third funded account this year on the same mistake. one bad trade after four good days, every single time",
            postUrl = "https://x.com/i/web/status/502",
            postCreatedAt = "2026-09-03T19:30:00Z",
            discoveredAt = "2026-09-03T21:00:00Z",
            opportunityScore = 71.5,
            scoreBreakdown = mapOf(
                "topicRelevance" to "\"Blown account\" (risk_management) -> +16",
                "activeDiscussion" to "1 replies, 0 quotes, 22 likes -> +8.1",
                "authorReach" to "620 followers -> +8.4 (capped at 15)",
                "recency" to "posted 0.6h ago -> +14.8",
                "valueOpportunity" to "no question, enough context -> +7",
            ),
            creatorCandidate = false,
            status = "new",
            draftReply = null,
            replyMentionsFillbook = null,
            replyUsedLink = null,
        ),
    )

    /** FIXTURE-ONLY: same contract as debugNextInboundOutcome above, for Prospecting's draft-reply action. Never used by production code. */
    var debugNextProspectingOutcome: String? = null

    override suspend fun getProspectingQueue(): ProspectingQueueResult {
        for (i in prospectingItems.indices) {
            if (prospectingItems[i].status == "new") prospectingItems[i] = prospectingItems[i].copy(status = "shown")
        }
        val candidates = prospectingItems.filter { it.status in setOf("new", "shown", "ready") }.sortedByDescending { it.opportunityScore }
        // No backend to compute real diagnostics in fake mode -- null correctly
        // exercises the same "no diagnostics field" fallback a genuinely old
        // API response would, rather than fabricating plausible-looking counts.
        return ProspectingQueueResult(candidates, diagnostics = null)
    }

    override suspend fun draftProspectingReply(id: String): ProspectingCandidate {
        val forced = debugNextProspectingOutcome
        debugNextProspectingOutcome = null
        when (forced) {
            "banned_phrase" -> throw DraftRejectedException("Draft rejected -- uses the banned generic phrase \"check out our platform\". Try drafting again.")
            "unverified_claim" -> throw DraftRejectedException("Draft rejected -- cites an unverified performance statistic. Try drafting again.")
        }
        val index = prospectingItems.indexOfFirst { it.id == id }
        val (draft, mentions) = if (forced == "with_mention") {
            "That's the classic problem with spreadsheet journaling -- you catch the pattern two weeks too late. That's one of the things we're trying to make easier with Fillbook." to true
        } else {
            "Most firms lock it in at the daily close, but a few (Apex included) still trail live intraday -- worth checking your specific firm's rulebook since this trips people up constantly." to false
        }
        val updated = prospectingItems[index].copy(
            status = "ready",
            draftReply = draft,
            replyMentionsFillbook = mentions,
            replyUsedLink = false,
        )
        prospectingItems[index] = updated
        return updated
    }

    override suspend fun openProspectingCandidate(id: String) {
        // No backend to call in fake mode -- no-op.
    }

    override suspend fun markProspectingReplied(id: String, finalReply: String?, mentionsFillbook: Boolean?, usedLink: Boolean?): ProspectingCandidate {
        val index = prospectingItems.indexOfFirst { it.id == id }
        val updated = prospectingItems[index].copy(status = "replied")
        prospectingItems[index] = updated
        return updated
    }

    override suspend fun markProspectingSkipped(id: String, reason: String?) {
        val index = prospectingItems.indexOfFirst { it.id == id }
        if (index >= 0) prospectingItems[index] = prospectingItems[index].copy(status = "skipped")
    }

    override suspend fun markProspectingNotRelevant(id: String) {
        val index = prospectingItems.indexOfFirst { it.id == id }
        if (index >= 0) prospectingItems[index] = prospectingItems[index].copy(status = "not_relevant")
    }

    override suspend fun markProspectingAlreadyHandled(id: String) {
        val index = prospectingItems.indexOfFirst { it.id == id }
        if (index >= 0) prospectingItems[index] = prospectingItems[index].copy(status = "already_handled")
    }

    /** FIXTURE-ONLY: overrides what the next runProspectingSearchNow() call returns -- lets the "Search now" status line (found/skipped) be verified on-device without a real network call. Resets to null (default "found 1" behavior) after one use. Never used by production code. */
    var debugNextSearchNowResult: ProspectingSearchRunResult? = null

    override suspend fun runProspectingSearchNow(): ProspectingSearchRunResult {
        val forced = debugNextSearchNowResult
        debugNextSearchNowResult = null
        if (forced != null) return forced

        val newId = "prospecting-fake-searched-${prospectingItems.size + 1}"
        prospectingItems.add(
            ProspectingCandidate(
                id = newId,
                platform = "x",
                discoveryQuery = "too_many_trades",
                discoveryLabel = "Overtrading",
                replyClass = "B",
                authorHandle = "fakeoverTrader",
                authorFollowerCount = 340,
                authorVerified = false,
                postText = "anyone else feel like they're just clicking buttons at this point instead of actually trading a plan",
                postUrl = "https://x.com/i/web/status/fake-searched-$newId",
                postCreatedAt = "2026-09-10T12:00:00Z",
                discoveredAt = "2026-09-10T12:05:00Z",
                opportunityScore = 62.0,
                scoreBreakdown = mapOf("topicRelevance" to "Direct match on overtrading"),
                creatorCandidate = false,
                status = "new",
                draftReply = null,
                replyMentionsFillbook = null,
                replyUsedLink = null,
            ),
        )
        return ProspectingSearchRunResult(
            skipped = false,
            skipReason = null,
            topicsSearched = listOf("too_many_trades", "revenge_trading"),
            postsRead = 20,
            newCandidates = 1,
            excludedAsSpam = 0,
            costUsd = 0.10,
        )
    }

    private val partnershipItems = mutableListOf(
        PartnershipProspect(
            id = "partnership-fake-1",
            organizationName = "Apex Journaling Coach LLC",
            contactName = "Dana Rivera",
            partnerCategory = PartnerCategory.EDUCATOR_COACH,
            stage = PartnershipStage.QUALIFIED,
            websiteUrl = "https://apexjournalingcoach.example",
            socialLinks = mapOf("x" to "https://x.com/apexjournaling"),
            contactRoute = "email: dana@apexjournalingcoach.example",
            contactRouteSource = "Contact page on their site",
            audienceFocus = "Futures day traders working on risk management and consistency",
            futuresRelevanceEvidence = "Weekly YouTube series on prop-firm drawdown rules, ~8k subscribers",
            sourceUrls = listOf("https://apexjournalingcoach.example/about"),
            researchDate = "2026-09-05",
            competingJournalRelationships = null,
            competingJournalEvidence = null,
            proposedCollaboration = "A guided journaling pilot for a small cohort (10-15) of her current students.",
            qualificationRationale = "Strong futures-specific audience, no competing journal found, clear mutual benefit.",
            ownerNotes = null,
            nextAction = "Generate a draft pitch",
            nextActionDueDate = null,
            pilotTermsProposed = null,
            pilotTermsAgreed = null,
            pilotStartDate = null,
            pilotEndDate = null,
            followUpCount = 0,
            approvedCampaignAssetId = null,
            previewText = null,
            contactedAt = null,
            contactedChannel = null,
            discoveryScore = 78,
            discoveryConfidence = "high",
            discoveredVia = "x_search",
        ),
        PartnershipProspect(
            id = "partnership-fake-2",
            organizationName = "Futures Grind Community",
            contactName = "Jordan Lee",
            partnerCategory = PartnerCategory.CREATOR_COMMUNITY,
            stage = PartnershipStage.QUALIFIED,
            websiteUrl = null,
            socialLinks = mapOf("x" to "https://x.com/futuresgrind"),
            contactRoute = "X DM: @futuresgrind",
            contactRouteSource = "Public X bio",
            audienceFocus = "Small-account futures traders sharing daily P&L",
            futuresRelevanceEvidence = "Daily community X Spaces on funded-account rules, ~5k followers",
            sourceUrls = listOf("https://x.com/futuresgrind"),
            researchDate = "2026-09-05",
            competingJournalRelationships = null,
            competingJournalEvidence = null,
            proposedCollaboration = "A referral partnership promoting Fillbook to the community.",
            qualificationRationale = "Active daily engagement, futures-specific, no competing journal mentioned.",
            ownerNotes = null,
            nextAction = "Generate a draft pitch",
            nextActionDueDate = null,
            pilotTermsProposed = null,
            pilotTermsAgreed = null,
            pilotStartDate = null,
            pilotEndDate = null,
            followUpCount = 0,
            approvedCampaignAssetId = null,
            previewText = null,
            contactedAt = null,
            contactedChannel = null,
            discoveryScore = 62,
            discoveryConfidence = "medium",
            discoveredVia = "prospecting",
        ),
        // Real production shape (org name/evidence unmodified) -- a retail
        // trader's satisfied-customer review of a prop firm, auto-suppressed
        // by the backend's recommendationReassessment.ts because it shows no
        // evidence of running/offering anything, only a topic mention.
        PartnershipProspect(
            id = "partnership-fake-suppressed-1",
            organizationName = "pijat jogja",
            contactName = null,
            partnerCategory = PartnerCategory.PROP_FIRM,
            stage = PartnershipStage.QUALIFIED,
            websiteUrl = null,
            socialLinks = mapOf("x" to "https://x.com/pijatjogja19cem"),
            contactRoute = "X DM: @pijatjogja19cem",
            contactRouteSource = "Discovered via x_search",
            audienceFocus = "Matched topics: prop firm",
            futuresRelevanceEvidence = "Discovered via x search. 1 on-topic post found (topics: prop firm).",
            sourceUrls = listOf("https://x.com/pijatjogja19cem/status/1"),
            researchDate = "2026-09-05",
            competingJournalRelationships = null,
            competingJournalEvidence = null,
            proposedCollaboration = "A member-access or integration discussion for their funded traders.",
            qualificationRationale = "Discovered via x search. 1 on-topic post found (topics: prop firm).",
            ownerNotes = null,
            nextAction = null,
            nextActionDueDate = null,
            pilotTermsProposed = null,
            pilotTermsAgreed = null,
            pilotStartDate = null,
            pilotEndDate = null,
            followUpCount = 0,
            approvedCampaignAssetId = null,
            previewText = null,
            contactedAt = null,
            contactedChannel = null,
            discoveryScore = 64,
            discoveryConfidence = "medium",
            discoveredVia = "x_search",
            suppressedReason = "No evidence this recipient runs or offers an audience, community, business, educational offering, or complementary product -- only topic-relevant text, not a concrete partnership basis. Automatically re-checked; will un-suppress if the evidence is updated.",
        ),
        // Owner-driven terminal state -- must never appear in the
        // recommended queue OR the suppressed section (those are two
        // different things: system-suppressed vs. owner-declined).
        PartnershipProspect(
            id = "partnership-fake-do-not-contact-1",
            organizationName = "Not Interested LLC",
            contactName = null,
            partnerCategory = PartnerCategory.OTHER,
            stage = PartnershipStage.DO_NOT_CONTACT,
            websiteUrl = null,
            socialLinks = emptyMap(),
            contactRoute = null,
            contactRouteSource = null,
            audienceFocus = null,
            futuresRelevanceEvidence = null,
            sourceUrls = emptyList(),
            researchDate = "2026-09-01",
            competingJournalRelationships = null,
            competingJournalEvidence = null,
            proposedCollaboration = null,
            qualificationRationale = null,
            ownerNotes = "Owner marked do-not-contact.",
            nextAction = null,
            nextActionDueDate = null,
            pilotTermsProposed = null,
            pilotTermsAgreed = null,
            pilotStartDate = null,
            pilotEndDate = null,
            followUpCount = 0,
            approvedCampaignAssetId = null,
            previewText = null,
            contactedAt = null,
            contactedChannel = null,
            discoveryScore = 55,
            discoveryConfidence = "low",
            discoveredVia = "manual",
        ),
    )

    /** FIXTURE-ONLY: when true, the next getPartnerships() call throws once (then resets) -- lets error-state rendering be verified on-device without a real network failure. Never used by production code. */
    var debugFailNextPartnershipsCall: Boolean = false

    /** FIXTURE-ONLY: overrides what the next refreshPartnershipDiscovery() call returns (and whether it adds a fixture row) -- lets every discovery-status banner (found/no_matches/budget_exhausted/error) be verified on-device without a real network call. Resets to null (default "found" behavior) after one use. Never used by production code. */
    var debugNextDiscoveryResult: PartnershipDiscoveryRunResult? = null
    private var lastDiscoveryRun: PartnershipDiscoveryRunResult? = null

    override suspend fun getPartnerships(): PartnershipsSummary {
        if (debugFailNextPartnershipsCall) {
            debugFailNextPartnershipsCall = false
            throw RuntimeException("fixture-only simulated failure")
        }
        return PartnershipsSummary(partnershipItems.toList(), lastDiscoveryRun)
    }

    override suspend fun refreshPartnershipDiscovery(): PartnershipDiscoveryRunResult {
        val forced = debugNextDiscoveryResult
        debugNextDiscoveryResult = null
        val result = forced ?: run {
            val newId = "partnership-fake-discovered-${partnershipItems.size + 1}"
            partnershipItems.add(
                PartnershipProspect(
                    id = newId,
                    organizationName = "Ridgeline Futures Mentorship",
                    contactName = null,
                    partnerCategory = PartnerCategory.EDUCATOR_COACH,
                    stage = PartnershipStage.QUALIFIED,
                    websiteUrl = null,
                    socialLinks = mapOf("x" to "https://x.com/ridgelinefutures"),
                    contactRoute = "X DM: @ridgelinefutures",
                    contactRouteSource = "Discovered via x_search",
                    audienceFocus = "Matched topics: trading coach, journaling",
                    futuresRelevanceEvidence = "Discovered via x search. 2 on-topic posts found (topics: trading coach, journaling), most recent 2026-09-04.",
                    sourceUrls = listOf("https://x.com/ridgelinefutures/status/1"),
                    researchDate = "2026-09-05",
                    competingJournalRelationships = null,
                    competingJournalEvidence = null,
                    proposedCollaboration = "A guided journaling pilot for a small cohort of their traders.",
                    qualificationRationale = "Discovered via x search. 2 on-topic posts found (topics: trading coach, journaling), most recent 2026-09-04.",
                    ownerNotes = null,
                    nextAction = null,
                    nextActionDueDate = null,
                    pilotTermsProposed = null,
                    pilotTermsAgreed = null,
                    pilotStartDate = null,
                    pilotEndDate = null,
                    followUpCount = 0,
                    approvedCampaignAssetId = null,
                    previewText = null,
                    contactedAt = null,
                    contactedChannel = null,
                    discoveryScore = 71,
                    discoveryConfidence = "medium",
                    discoveredVia = "x_search",
                ),
            )
            PartnershipDiscoveryRunResult(status = "found", newCandidates = 1, sourcesSearched = listOf("creators", "prospecting", "inbound", "x_search"), costUsd = 0.15, error = null, skipReason = null)
        }
        lastDiscoveryRun = result
        return result
    }

    override suspend fun createPartnership(
        organizationName: String,
        contactName: String?,
        partnerCategory: PartnerCategory,
        websiteUrl: String?,
        proposedCollaboration: String?,
    ): PartnershipProspect {
        val created = PartnershipProspect(
            id = "partnership-fake-${partnershipItems.size + 1}",
            organizationName = organizationName,
            contactName = contactName,
            partnerCategory = partnerCategory,
            stage = PartnershipStage.PROSPECT,
            websiteUrl = websiteUrl,
            socialLinks = emptyMap(),
            contactRoute = null,
            contactRouteSource = null,
            audienceFocus = null,
            futuresRelevanceEvidence = null,
            sourceUrls = emptyList(),
            researchDate = null,
            competingJournalRelationships = null,
            competingJournalEvidence = null,
            proposedCollaboration = proposedCollaboration,
            qualificationRationale = null,
            ownerNotes = null,
            nextAction = null,
            nextActionDueDate = null,
            pilotTermsProposed = null,
            pilotTermsAgreed = null,
            pilotStartDate = null,
            pilotEndDate = null,
            followUpCount = 0,
            approvedCampaignAssetId = null,
            previewText = null,
            contactedAt = null,
            contactedChannel = null,
            discoveryScore = null,
            discoveryConfidence = null,
            discoveredVia = "manual",
        )
        partnershipItems.add(created)
        return created
    }

    private fun updatePartnershipItem(id: String, transform: (PartnershipProspect) -> PartnershipProspect): PartnershipProspect {
        val index = partnershipItems.indexOfFirst { it.id == id }
        val updated = transform(partnershipItems[index])
        partnershipItems[index] = updated
        return updated
    }

    override suspend fun updatePartnership(id: String, ownerNotes: String?, nextAction: String?, nextActionDueDate: String?, contactRoute: String?, contactRouteSource: String?, audienceFocus: String?, futuresRelevanceEvidence: String?): PartnershipProspect =
        updatePartnershipItem(id) {
            it.copy(
                ownerNotes = ownerNotes ?: it.ownerNotes,
                nextAction = nextAction ?: it.nextAction,
                nextActionDueDate = nextActionDueDate ?: it.nextActionDueDate,
                contactRoute = contactRoute ?: it.contactRoute,
                contactRouteSource = contactRouteSource ?: it.contactRouteSource,
                audienceFocus = audienceFocus ?: it.audienceFocus,
                futuresRelevanceEvidence = futuresRelevanceEvidence ?: it.futuresRelevanceEvidence,
            )
        }

    override suspend fun qualifyPartnership(id: String, rationale: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.QUALIFIED, qualificationRationale = rationale) }

    /** FIXTURE-ONLY: when set to "failed", "skipped", "network_error", "evidence_insufficient", "evidence_gap_stop", or "already_generating", the next generatePartnershipDraft() call throws a real-shaped error (the EXACT message the real backend now sends for each of this round's new stabilization behaviors) instead of succeeding -- lets each error path be verified on-device without spending real LLM budget. Resets to null after one use. Never used by production code. */
    var debugNextGenerateDraftOutcome: String? = null
    /** FIXTURE-ONLY: counts every real invocation reaching this fake, including forced-error ones -- lets an on-device repeated-tap test confirm the UI's busy-state disable actually prevented a second concurrent call, not just that the visible result looked right. Never used by production code. */
    var debugGenerateDraftCallCount: Int = 0

    override suspend fun generatePartnershipDraft(id: String): PartnershipProspect {
        debugGenerateDraftCallCount += 1

        // Mirrors the real backend's draft-reuse behavior: once a prospect
        // already has an approved draft, generating again returns it
        // instantly at zero cost instead of re-running the pipeline -- so
        // an on-device pass calling this twice on the same prospect can
        // observe the second call skip the 1500ms "spending" delay
        // entirely, exactly like the real generateDraftForPartnership does.
        val existing = partnershipItems.find { it.id == id }
        if (existing?.stage == PartnershipStage.DRAFT_READY && existing.approvedCampaignAssetId != null) {
            return existing
        }

        kotlinx.coroutines.delay(1500) // FIXTURE-ONLY: widens the busy window so an on-device repeated-tap test has time to actually attempt a second tap.
        val forced = debugNextGenerateDraftOutcome
        debugNextGenerateDraftOutcome = null
        when (forced) {
            "failed" -> throw PartnershipDraftRejectedException(
                shortReason = "Didn't pass review after 2 attempts -- needs stronger, more specific personalization for this recipient.",
                details = "hook_specialist: generic opener, could be sent to any recipient with the name swapped.; growth_strategist: no recipient-specific evidence of their actual work or audience.; fact_checker: the claim about their audience size cannot be traced to any verified evidence provided.",
            )
            "skipped" -> throw PartnershipDraftRejectedException(
                shortReason = "Draft generation skipped -- this month's Partnerships budget is used up.",
                details = "bucket_budget_reached (generation: actual \$2.0000 + in-flight \$0.0000 + requested \$0.2500 exceeds bucket cap \$2.00)",
            )
            "network_error" -> throw NetworkException("POST /api/approvals?resource=partnerships failed: HTTP 0 -- simulated network loss", null)
            // The exact real message from hasSufficientEvidenceForPitch's
            // guard in partnershipsHandlers.ts -- thrown BEFORE any spend.
            "evidence_insufficient" -> throw PartnershipDraftRejectedException(
                shortReason = "Not enough of this recipient's own words are on file to personalize a pitch confidently yet. Add real research (their actual posts, site copy, or notes in their own words) to evidenceExcerpts before generating -- a draft attempt here would very likely fail review and spend budget for nothing.",
            )
            // The exact real message when isUnresolvedEvidenceGap stops the
            // revision loop after ONE attempt instead of two.
            "evidence_gap_stop" -> throw PartnershipDraftRejectedException(
                shortReason = "(after 1 attempt -- stopped early, a rewrite can't fix this) The available evidence isn't specific enough to personalize a pitch, and the reviewers said so directly: review gate: fact_checker: demonstrates zero real knowledge of the recipient; growth_strategist: this could be sent to literally any prop firm with only the name swapped. Add more real research on this recipient before trying again -- another attempt with the same evidence would very likely fail the same way.",
            )
            // The exact real message from the generation_claimed_at mutex
            // when a duplicate/concurrent request reaches the same prospect.
            "already_generating" -> throw PartnershipDraftRejectedException(
                shortReason = "A draft is already being generated for this prospect -- please wait for it to finish before trying again.",
            )
        }
        return updatePartnershipItem(id) {
            it.copy(
                stage = PartnershipStage.DRAFT_READY,
                approvedCampaignAssetId = "asset-fake-partnership-${id}",
                previewText = "Hi ${it.contactName ?: "there"} -- I've been following ${it.organizationName}'s work with futures traders on risk management. Fillbook is a broker-agnostic trading journal built around session review and visible account-rule tracking. ${it.proposedCollaboration.orEmpty()} Would you be open to a quick call?",
            )
        }
    }

    override suspend fun markPartnershipContacted(id: String, channel: String, finalText: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.CONTACTED, contactedChannel = channel, contactedAt = "2026-09-05T20:00:00Z") }

    override suspend fun sendPartnershipEmail(id: String, subject: String, finalText: String): PartnershipProspect {
        val prospect = partnershipItems.first { it.id == id }
        if (prospect.contactRoute?.startsWith("email", ignoreCase = true) != true) {
            // Reuses PartnershipDraftRejectedException purely for its "show
            // this short reason directly, no generic connectivity message"
            // UI treatment -- not actually about a rejected draft here.
            throw PartnershipDraftRejectedException("Cannot send email: this prospect's contact route isn't an email address.")
        }
        return updatePartnershipItem(id) { it.copy(stage = PartnershipStage.CONTACTED, contactedChannel = "email", contactedAt = "2026-09-05T20:00:00Z") }
    }

    override suspend fun recordPartnershipReply(id: String, summary: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.REPLIED) }

    override suspend fun startPartnershipPilot(id: String, termsAgreed: String, startDate: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.PILOT, pilotTermsAgreed = termsAgreed, pilotStartDate = startDate) }

    override suspend fun activatePartnership(id: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.ACTIVE_PARTNER) }

    override suspend fun closePartnership(id: String, reason: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.CLOSED) }

    override suspend fun archivePartnership(id: String, reason: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.ARCHIVED) }

    override suspend fun markPartnershipDoNotContact(id: String, reason: String): PartnershipProspect =
        updatePartnershipItem(id) { it.copy(stage = PartnershipStage.DO_NOT_CONTACT) }

    private var fakeStrategy: StrategyVersion? = StrategyVersion(
        version = 1,
        generatedAt = "2026-09-03T12:00:00Z",
        topicsToIncrease = listOf(
            StrategyItem("Trailing drawdown confusion", "80% review pass rate across 5 campaigns, 4 reached ready-for-owner."),
        ),
        topicsToDecrease = listOf(
            StrategyItem("Generic motivation posts", "Only 20% review pass rate across 4 campaigns."),
        ),
        contentToRetire = emptyList(),
        formatsToTest = listOf(
            StrategyItem("x / post", "85% pass rate across 6 assets -- worth more volume here."),
        ),
        seoOpportunities = listOf(
            SeoOpportunity("prop firm consistency rule", velocity = 3.0, hasExistingOpportunity = false),
        ),
        creatorOpportunities = listOf(
            CreatorOpportunity("creator-fake-1", "@wannabechamp", "tier_b", 2, daysSinceLastInteraction = 34),
        ),
        experimentsToRun = listOf(
            ExperimentSuggestion(
                "Doubling down on \"Trailing drawdown confusion\"-style topics increases the ready-for-owner rate further.",
                "80% review pass rate across 5 campaigns, 4 reached ready-for-owner.",
            ),
        ),
        summary = "1 topic(s) to double down on, 1 to pull back on. 1 rising search topic(s) with no opportunity yet. 1 creator relationship(s) gone quiet.",
        lowConfidence = true,
    )

    override suspend fun getLatestStrategy(): StrategyVersion? = fakeStrategy

    override suspend fun regenerateStrategy(): StrategyVersion {
        val current = fakeStrategy
        val next = (current?.copy(version = current.version + 1) ?: fakeStrategy)!!
        fakeStrategy = next
        return next
    }

    private val fakeExperiments = mutableListOf(
        Experiment(
            id = "exp-fake-1",
            hypothesis = "More video_script assets on tiktok improve the review pass rate",
            scopePlatform = "tiktok",
            scopeAssetType = "video_script",
            guardrailNote = null,
            status = "running",
            startDate = "2026-08-27",
            endDate = null,
            controlWindowStart = "2026-08-13",
            createdAt = "2026-08-27T12:00:00Z",
            result = ExperimentResult(
                controlRate = 0.4,
                treatmentRate = 0.4,
                absoluteDifference = 0.0,
                pValue = null,
                isSignificant = false,
                insufficientSample = true,
                controlSampleSize = 3,
                treatmentSampleSize = 2,
                interpretation = "Not enough data yet (control: 3, treatment: 2 -- both need 5+). Keep running before drawing a conclusion.",
                computedAt = "2026-09-03T12:00:00Z",
            ),
        ),
    )

    override suspend fun getExperiments(): List<Experiment> = fakeExperiments.toList()

    override suspend fun createExperiment(hypothesis: String, scopePlatform: String?, scopeAssetType: String?, guardrailNote: String?, startDate: String, controlWindowDays: Int): Experiment {
        val created = Experiment(
            id = "exp-fake-${fakeExperiments.size + 1}",
            hypothesis = hypothesis,
            scopePlatform = scopePlatform,
            scopeAssetType = scopeAssetType,
            guardrailNote = guardrailNote,
            status = "running",
            startDate = startDate,
            endDate = null,
            controlWindowStart = startDate,
            createdAt = startDate,
            result = null,
        )
        fakeExperiments.add(0, created)
        return created
    }

    override suspend fun measureExperiment(id: String): Experiment = fakeExperiments.first { it.id == id }

    override suspend fun completeExperiment(id: String): Experiment {
        val index = fakeExperiments.indexOfFirst { it.id == id }
        val updated = fakeExperiments[index].copy(status = "completed", endDate = "2026-09-03")
        fakeExperiments[index] = updated
        return updated
    }

    override suspend fun abortExperiment(id: String) {
        val index = fakeExperiments.indexOfFirst { it.id == id }
        if (index >= 0) fakeExperiments[index] = fakeExperiments[index].copy(status = "aborted")
    }

    private val fakeNotifications = mutableListOf(
        AppNotification(
            id = "notif-fake-1",
            type = "high_value_opportunity",
            title = "High-value opportunity: Trailing drawdown confusion",
            body = "Score 80 -- worth a look in Radar.",
            severity = "info",
            createdAt = "2026-09-03T13:00:00Z",
            readAt = null,
            relatedId = "opp-1",
        ),
    )

    override suspend fun getNotifications(): Pair<List<AppNotification>, Int> =
        fakeNotifications.toList() to fakeNotifications.count { it.readAt == null }

    override suspend fun markNotificationRead(id: String) {
        val index = fakeNotifications.indexOfFirst { it.id == id }
        if (index >= 0) fakeNotifications[index] = fakeNotifications[index].copy(readAt = "2026-09-03T13:05:00Z")
    }

    override suspend fun markAllNotificationsRead() {
        for (i in fakeNotifications.indices) {
            if (fakeNotifications[i].readAt == null) fakeNotifications[i] = fakeNotifications[i].copy(readAt = "2026-09-03T13:05:00Z")
        }
    }

    override suspend fun getMorningBrief() = MorningBrief(
        generatedAt = "2026-09-03T13:00:00Z",
        signalsOvernight = 4,
        topNewOpportunities = listOf(OpportunitySummary("opp-1", "Trailing drawdown confusion", 80.0)),
        pendingApprovals = 1,
        inboundNeedsResponse = 2,
        strategySummary = "1 topic(s) to double down on, 1 to pull back on.",
        unreadNotificationCount = 1,
    )

    override suspend fun getEveningReport() = EveningReport(
        generatedAt = "2026-09-03T23:00:00Z",
        assetsDrafted = 2,
        approvedToday = 1,
        rejectedToday = 0,
        reviewPassRate = 0.85,
        costTodayUsd = 0.09,
        inboundResolvedToday = 3,
        topOpportunity = OpportunitySummary("opp-1", "Trailing drawdown confusion", 80.0),
    )

    override suspend fun registerDeviceToken(fcmToken: String) {
        // No backend to call in fake mode -- no-op.
    }

    private val fakeVideoRenders = listOf(
        VideoRenderStatus(
            id = "video-fake-1",
            campaignAssetId = "asset-fake-video-1",
            status = "ready",
            downloadUrl = "https://example.supabase.co/storage/v1/object/sign/rendered-videos/video-fake-1.mp4?token=fake",
            thumbnailDownloadUrl = "https://example.supabase.co/storage/v1/object/sign/rendered-videos/video-fake-1-thumbnail.jpg?token=fake",
            durationSeconds = 48.7,
            error = null,
            createdAt = "2026-09-05T18:00:00Z",
            updatedAt = "2026-09-05T18:02:00Z",
        ),
        VideoRenderStatus(
            id = "video-fake-2",
            campaignAssetId = "asset-fake-video-2",
            status = "rendering",
            downloadUrl = null,
            thumbnailDownloadUrl = null,
            durationSeconds = null,
            error = null,
            createdAt = "2026-09-06T09:00:00Z",
            updatedAt = "2026-09-06T09:00:30Z",
        ),
        VideoRenderStatus(
            id = "video-fake-3",
            campaignAssetId = "asset-fake-video-3",
            status = "failed",
            downloadUrl = null,
            thumbnailDownloadUrl = null,
            durationSeconds = null,
            error = "storage_cap_reached (committed 480000000 + reserved 0 + requested 1100000 exceeds cap 500000000)",
            createdAt = "2026-09-04T12:00:00Z",
            updatedAt = "2026-09-04T12:01:00Z",
        ),
    )

    override suspend fun getVideoRenderStatuses(): List<VideoRenderStatus> = fakeVideoRenders

    override suspend fun dismissVideoRender(videoRenderId: String) {
        // No-op in fake mode.
    }

    override suspend fun retryVideoRender(videoRenderId: String): String? = null

    override suspend fun setVideoPublishedUrl(videoRenderId: String, publishedUrl: String) {
        // No-op in fake mode.
    }

    override suspend fun getPostingOverview(): PostingOverview = PostingOverview(
        plan = PostingPlan(
            date = "2026-09-25",
            backlog = 0,
            slots = listOf(
                PlanSlot("06:30", "done", PlanVideo("asset-1", "render-1", "Green month. Losing setup.", PostingPlatform.entries.map { PlanPost(it, "https://example.com/${it.apiName}", "2026-09-25T13:40:00Z") }), emptyList()),
                PlanSlot("12:00", "due", PlanVideo("asset-2", "render-2", "Would your trades pass?", emptyList()), PostingPlatform.entries),
                PlanSlot("17:30", "empty", null, emptyList()),
            ),
        ),
        results = PostingResults(videos = emptyList(), xReplies = emptyList(), replyVisibility = ReplyVisibility("not_enough_data", null, 0, null, 0)),
    )

    override suspend fun recordVideoPost(campaignAssetId: String, videoRenderId: String?, platform: PostingPlatform, url: String) {
        // No-op in fake mode.
    }

    override suspend fun recordPostStats(videoPostId: String, views: Int?, likes: Int?, comments: Int?, shares: Int?) {
        // No-op in fake mode.
    }
}
