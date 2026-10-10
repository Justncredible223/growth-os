package com.fillbook.growthos.data

/**
 * Interface the UI depends on. NetworkGrowthOsRepository (calls the deployed
 * Vercel API) is the implementation; no screen code depends on a concrete
 * repository.
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

    /** The Live Host tab: the switch, the PC worker's presence, and every chat message seen and line said this stream. */
    suspend fun getLiveHostStatus(): LiveHostStatus
    /** The owner's Live Host switch. The character only speaks on stream while this is on; off stops it at once. */
    suspend fun setLiveHostSwitch(on: Boolean)
    /** The YouTube live stream whose chat the host reads. Accepts a link or an id; blank clears it. */
    suspend fun setLiveHostYoutubeVideo(linkOrId: String)
    /** Turns TikTok LIVE chat reading on or off, for the given TikTok username. Owner-only, like the switch. */
    suspend fun setLiveHostTiktokChat(enabled: Boolean, username: String)

    /**
     * The Engage tab (engagement assistant): other creators' videos with drafted comments. Nothing here posts to
     * a platform; the owner posts by hand and [doneEngagement] only records that they did. Refusals from the
     * server's guardrails (daily cap, spacing, creator cooldown, quota) arrive as [EngagementActionException].
     */
    suspend fun getEngagementStatus(): EngagementStatus
    /** Adds a pasted TikTok or YouTube video link to the queue. */
    suspend fun addEngagementLink(url: String): EngagementItem
    /** Adds a watchlist entry: an @handle or channel id, or a search query. */
    suspend fun addEngagementWatch(value: String)
    /** Pulls fresh YouTube candidates for the watchlist through the official Data API. */
    suspend fun discoverEngagement(): EngagementDiscoverResult
    /** Drafts two or three comment options for one video. */
    suspend fun draftEngagement(id: String): EngagementItem
    /** Records that the owner opened the video; returns the link to open. */
    suspend fun openEngagement(id: String): String
    /** Records a copy of a draft (or the owner's edited text) and returns the text to put on the clipboard. */
    suspend fun copyEngagement(id: String, draftId: String?, text: String?): EngagementCopyResult
    /** Records that the owner posted and/or liked: did is "commented", "liked" or "both". */
    suspend fun doneEngagement(id: String, did: String, draftId: String?, finalText: String?)
    suspend fun skipEngagement(id: String)

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
