package com.fillbook.growthos.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Real backend client. Talks to the deployed Vercel API, which is the
 * only thing that ever touches Supabase with the service_role key -- this
 * app never holds that key.
 *
 * [protectionBypassSecret] is Vercel's "Protection Bypass for Automation"
 * token (Settings -> Deployment Protection), NOT the Supabase service_role
 * key. It exists specifically to let a client like this one reach a
 * protected deployment without a human Vercel login, and is safe to embed
 * client-side by design -- see Vercel's own docs on this feature. It is a
 * different trust tier from the Supabase service_role key, which never
 * appears anywhere in this app.
 *
 * [appToken] is the second, separate credential that actually gates this
 * project's own business data (see backend/src/lib/requireAppAuth.ts).
 * Same trust tier as the Vercel bypass secret above -- injected into the
 * app once at build time (see AppConfig.kt's APP_TOKEN, sourced from
 * android/local.properties or an env var, never a source literal), never
 * something the owner types or retrieves. The owner's actual gate is
 * BiometricGateScreen (fingerprint/face/device PIN); this token exists so
 * a stranger who only has the Vercel bypass secret still can't reach this
 * project's data without also having decompiled the APK for this value
 * too. Every request here sends it as a standard Authorization: Bearer
 * header; the backend rejects anything that doesn't match its own
 * APP_API_TOKEN (or, during a rotation window, APP_API_TOKEN_PREVIOUS) env
 * var.
 *
 * [deciderName] answers "who approved this" for the audit trail (see
 * migration 0013_campaign_decision_audit.sql) -- fixed to "Owner" for
 * this single-owner app rather than a real account system.
 */
class NetworkGrowthOsRepository(
    private val baseUrl: String,
    private val protectionBypassSecret: String,
    private val appToken: String,
    private val deciderName: String = "",
) : GrowthOsRepository {

    // Default OkHttp timeouts are 10s each way -- fine for every other
    // endpoint here. POST /api/run-campaign used to drift well past 10s
    // (it drafted content and ran up to nine sequential LLM review-agent
    // calls inline), which is exactly why that endpoint is now enqueue-only
    // and polled instead (see enqueueAndAwaitCampaignRun below) -- the 90s
    // read timeout here is a generous margin for any individual request,
    // not a budget for the whole campaign run anymore.
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    companion object {
        private const val CAMPAIGN_RUN_POLL_INTERVAL_MS = 3_000L
        // Generous outer bound on the whole enqueue-and-wait loop -- well
        // past any campaign run this pipeline has actually taken so far,
        // but still short enough that the app doesn't hang indefinitely if
        // something is genuinely stuck. The run itself is never lost if
        // this is hit -- see the timeout message below.
        private const val CAMPAIGN_RUN_POLL_TIMEOUT_MS = 5 * 60_000L
    }

    private suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .header("x-vercel-protection-bypass", protectionBypassSecret)
            .header("x-vercel-set-bypass-cookie", "true")
            .header("Authorization", "Bearer $appToken")
            .build()

        client.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: "{}"
            if (!response.isSuccessful) {
                throw NetworkException("GET $path failed: HTTP ${response.code} -- $body", response.code)
            }
            JSONObject(body)
        }
    }

    private suspend fun post(path: String, jsonBody: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .header("x-vercel-protection-bypass", protectionBypassSecret)
            .header("x-vercel-set-bypass-cookie", "true")
            .header("Authorization", "Bearer $appToken")
            .post(jsonBody.toString().toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(request).execute().use { response ->
            val responseBody = response.body?.string() ?: "{}"
            if (!response.isSuccessful) {
                throw NetworkException("POST $path failed: HTTP ${response.code} -- $responseBody", response.code)
            }
            JSONObject(responseBody)
        }
    }

    /**
     * Same fix as generatePartnershipDraft's own 404-body parsing (see
     * extractPartnershipActionErrorMessage's docstring) -- confirmed on
     * inspection that draftProspectingReply/draftInboundResponse had never
     * received it: a thrown ProspectingActionError/InboundActionError
     * (e.g. the reply guardrail rejecting a banned phrase or unverified
     * claim) converts into an HTTP 404 with a real, actionable
     * `{error: message}` body, but without this, it fell through as a bare
     * NetworkException -- ProspectingScreen/InboundScreen's generic
     * `catch (e: Exception)` has no specific handler for that, so it
     * silently became "Couldn't draft a reply. Check your connection and
     * try again.", hiding the real reason the owner needed to see.
     */
    private suspend fun postExpectingDraftRejection(path: String, jsonBody: JSONObject): JSONObject =
        try {
            post(path, jsonBody)
        } catch (e: NetworkException) {
            val parsedError = extractPartnershipActionErrorMessage(e.httpCode, e.message)
            if (parsedError != null) throw DraftRejectedException(parsedError)
            throw e
        }

    override suspend fun getHomeSummary(): HomeSummary {
        val json = get("/api/summary")
        val analytics = json.getJSONObject("analytics")
        return HomeSummary(
            signalsAnalyzedToday = json.getInt("signalsAnalyzedToday"),
            opportunitiesFound = json.getInt("opportunitiesFound"),
            assetsReady = json.getInt("assetsReady"),
            pendingReview = json.getInt("pendingReview"),
            systemPaused = json.getBoolean("systemPaused"),
            analytics = AnalyticsBreakdown(
                totalSignals = analytics.getInt("totalSignals"),
                signalsBySource = analytics.getJSONObject("signalsBySource").toIntMap(),
                opportunitiesByStatus = analytics.getJSONObject("opportunitiesByStatus").toIntMap(),
                campaignAssetsByStage = analytics.getJSONObject("campaignAssetsByStage").toIntMap(),
                totalCostUsd = analytics.getDouble("totalCostUsd"),
                todaySpendUsd = analytics.getDouble("todaySpendUsd"),
                autoDraft = analytics.getJSONObject("autoDraft").let { ad ->
                    AutoDraftStatus(
                        lastRunDate = ad.optStringOrNull("lastRunDate"),
                        lastRunStatus = ad.optStringOrNull("lastRunStatus"),
                        lastRunSkipReason = ad.optStringOrNull("lastRunSkipReason"),
                        backlogCount = ad.getInt("backlogCount"),
                        backlogCap = ad.getInt("backlogCap"),
                        monthSpendUsd = ad.getDouble("monthSpendUsd"),
                        monthBudgetUsd = ad.getDouble("monthBudgetUsd"),
                    )
                },
                growthLoop = analytics.optJSONObject("growthLoop")?.let { gl ->
                    GrowthLoopSummary(
                        windowDays = gl.getInt("windowDays"),
                        publishedContentCount = gl.getInt("publishedContentCount"),
                        trackedLinkClicks = gl.getInt("trackedLinkClicks"),
                        funnelConnected = gl.getString("funnelConnectionStatus") == "connected",
                        signups = gl.getInt("signups"),
                        activated = gl.getInt("activated"),
                        firstPaidConversions = gl.getInt("firstPaidConversions"),
                        contentProductionCostUsd = gl.getDouble("contentProductionCostUsd"),
                        costPerSignup = if (gl.isNull("costPerSignup")) null else gl.getDouble("costPerSignup"),
                        activeSubscriptionsUnavailableReason = gl.getJSONObject("activeSubscriptions").getString("reason"),
                        byChannel = gl.getJSONArray("byChannel").map { ch ->
                            GrowthLoopChannelBreakdown(
                                channel = ch.getString("channel"),
                                publishedContentCount = ch.getInt("publishedContentCount"),
                                signups = ch.getInt("signups"),
                                activated = ch.getInt("activated"),
                                firstPaidConversions = ch.getInt("firstPaidConversions"),
                            )
                        },
                        attributionNote = gl.getString("attributionNote"),
                    )
                },
            ),
            todayXPost = json.optJSONObject("todayXPost").toTodayXPost(),
            video = parseTodaysVideo(json.optJSONObject("video")),
            attribution = json.optJSONObject("attribution")?.let { attr ->
                AttributionSummary(
                    signupsLast7Days = attr.optInt("signupsLast7Days", 0),
                    topSource = attr.optStringOrNull("topSource"),
                )
            } ?: AttributionSummary(0, null),
        )
    }

    /** Shared parsing for GET /api/summary's embedded todayXPost and the x-feed-post resource's own responses -- same shape from both. */
    private fun JSONObject?.toTodayXPost(): TodayXPost {
        if (this == null) return TodayXPost(TodayXPostState.EMPTY, null, null)
        return TodayXPost(
            state = runCatching { TodayXPostState.valueOf(getString("state").uppercase()) }.getOrDefault(TodayXPostState.EMPTY),
            campaignAssetId = optStringOrNull("campaignAssetId"),
            previewText = optStringOrNull("previewText"),
            topicLabel = optStringOrNull("topicLabel"),
            reason = optStringOrNull("reason"),
            selectionReason = optStringOrNull("selectionReason"),
            canRegenerate = optBoolean("canRegenerate", false),
        )
    }

    override suspend fun getHealth(): List<HealthItem> {
        val json = get("/api/health")
        return json.getJSONArray("health").map { item ->
            HealthItem(
                label = item.getString("label"),
                status = runCatching { HealthStatus.valueOf(item.getString("status")) }
                    .getOrDefault(HealthStatus.NOT_CONNECTED),
                detail = item.getString("detail"),
            )
        }
    }

    override suspend fun getOpportunities(): List<Opportunity> {
        val json = get("/api/opportunities")
        return json.getJSONArray("opportunities").map { item ->
            Opportunity(
                id = item.getString("id"),
                title = item.getString("title"),
                score = item.getDouble("score"),
                urgency = runCatching { Urgency.valueOf(item.getString("urgency").uppercase()) }
                    .getOrDefault(Urgency.NORMAL),
                rationale = item.getString("rationale"),
                channels = item.getJSONArray("recommendedChannels").mapStrings(),
                sourceUrl = item.optStringOrNull("sourceUrl"),
                authorHandle = item.optStringOrNull("authorHandle"),
            )
        }
    }

    override suspend fun draftOpportunityReply(opportunityId: String): String {
        val body = JSONObject().put("action", "draft-reply").put("opportunityId", opportunityId)
        // Real gap found in the 2026-09-07 release audit: unlike
        // draftInboundResponse/draftProspectingReply/generatePartnershipDraft
        // (all routed through postExpectingDraftRejection), this call used
        // the plain post() helper, so a real, actionable rejection reason
        // from opportunities.ts's OpportunityReplyError (HTTP 400 --
        // different status than the Partnerships/Inbound/Prospecting 404
        // pattern, since this is a distinct backend route) fell through as
        // a bare NetworkException. RadarScreen's catch (e: Exception) has
        // no specific handler for that, so it silently became "Couldn't
        // draft a reply. Check your connection and try again." instead of
        // the real guardrail reason.
        val json = try {
            post("/api/opportunities", body)
        } catch (e: NetworkException) {
            val parsedError = extractOpportunityReplyErrorMessage(e.httpCode, e.message)
            if (parsedError != null) throw DraftRejectedException(parsedError)
            throw e
        }
        return json.getString("draft")
    }

    /**
     * A rejection can come from either gate: the mechanical gate (banned
     * phrases/duplicates -- `mechanicalBlockReasons`) or the nine-agent deep
     * review (`deepReview.blockReasons`, e.g. "brand_guardian: ..."). Before
     * this, only mechanicalBlockReasons was surfaced, so a deep-review
     * rejection (the far more common case in practice) showed the owner a
     * bare "Didn't clear review (Final Draft)." with no indication of what
     * actually needs to change -- confirmed against real production video
     * requests that failed brand_guardian/skeptic for a personal-trading
     * narrative the owner had no way to see without querying the database
     * directly.
     */
    /**
     * POST /api/run-campaign now only enqueues the run and returns a
     * campaignRunRequestId immediately (2026-09-22) -- the actual pipeline
     * (one drafting call plus up to nine review calls) moved to GitHub
     * Actions after production logs showed it occasionally exceeding
     * Vercel's 120s function cap, which this app surfaced as a generic
     * "couldn't run that campaign" even on runs that eventually succeeded
     * server-side. This polls GET /api/campaign-run-status until the run
     * reaches a terminal state, then maps it to the exact same
     * CampaignRunResult every caller (RadarScreen, ResearchScreen,
     * VideoStatusScreen) already expects -- none of them need to change.
     */
    private suspend fun enqueueAndAwaitCampaignRun(body: JSONObject): CampaignRunResult {
        val enqueued = post("/api/run-campaign", body)
        val campaignRunRequestId = enqueued.getString("campaignRunRequestId")

        val deadline = System.currentTimeMillis() + CAMPAIGN_RUN_POLL_TIMEOUT_MS
        while (true) {
            val status = get("/api/campaign-run-status?id=$campaignRunRequestId")
            when (status.getString("status")) {
                "ready" -> {
                    val mechanicalReasons = status.optJSONArray("blockReasons")?.mapStrings() ?: emptyList()
                    return CampaignRunResult(
                        finalStage = status.getString("finalStage"),
                        blockReasons = mechanicalReasons,
                        costUsd = if (status.isNull("costUsd")) 0.0 else status.getDouble("costUsd"),
                    )
                }
                "failed" -> throw NetworkException(status.optString("error", "Campaign run failed for an unknown reason."))
                else -> {
                    if (System.currentTimeMillis() > deadline) {
                        throw NetworkException("Campaign run is taking longer than expected -- check Approvals shortly, it may still land.")
                    }
                    delay(CAMPAIGN_RUN_POLL_INTERVAL_MS)
                }
            }
        }
    }

    override suspend fun runCampaignForOpportunity(opportunityId: String): CampaignRunResult =
        enqueueAndAwaitCampaignRun(JSONObject().put("opportunityId", opportunityId))

    override suspend fun requestVideoScript(motionConceptId: String): CampaignRunResult =
        enqueueAndAwaitCampaignRun(JSONObject().put("assetType", "video_script").put("motionConceptId", motionConceptId))

    override suspend fun getMotionConceptCatalog(): MotionConceptCatalog = parseMotionConceptCatalog(get("/api/run-campaign"))

    override suspend fun requestResearch(topic: String?, opportunityId: String?): CampaignRunResult {
        val body = JSONObject().put("assetType", "research")
        if (topic != null) body.put("topic", topic)
        if (opportunityId != null) body.put("opportunityId", opportunityId)
        return enqueueAndAwaitCampaignRun(body)
    }

    private fun JSONObject.toResearchRecord() = ResearchRecord(
        id = getString("id"),
        title = getString("title"),
        question = getString("question"),
        summary = getString("summary"),
        findings = optJSONArray("findings")?.mapStrings() ?: emptyList(),
        evidenceReferences = optJSONArray("evidenceReferences")?.mapStrings() ?: emptyList(),
        caveats = optJSONArray("caveats")?.mapStrings() ?: emptyList(),
        contentAngles = optJSONArray("contentAngles")?.mapStrings() ?: emptyList(),
        status = getString("status"),
        costUsd = if (isNull("costUsd")) null else getDouble("costUsd"),
        createdAt = getString("createdAt"),
    )

    // Folded into /api/approvals (?resource=research) -- same Vercel
    // Hobby 12-function-cap reasoning as inbound/prospecting/partnerships/
    // video-status above.
    override suspend fun listResearch(): List<ResearchRecord> {
        val json = get("/api/approvals?resource=research")
        return json.getJSONArray("items").map { it.toResearchRecord() }
    }

    override suspend fun getApprovals(): List<ApprovalAsset> {
        val json = get("/api/approvals")
        return json.getJSONArray("approvals").map { item ->
            ApprovalAsset(
                id = item.getString("id"),
                campaignTitle = item.getString("campaignTitle"),
                platform = item.getString("platform"),
                assetType = item.getString("assetType"),
                previewText = item.getString("previewText"),
                stage = runCatching { AssetStage.valueOf(item.getString("stage")) }
                    .getOrDefault(AssetStage.READY_FOR_OWNER),
                isAutoDraft = item.getBoolean("isAutoDraft"),
                costUsd = if (item.isNull("costUsd")) null else item.getDouble("costUsd"),
                generatedAt = item.optStringOrNull("generatedAt"),
                reviewPassCount = item.optInt("reviewPassCount", 0),
                reviewFailCount = item.optInt("reviewFailCount", 0),
                trackingQuery = item.optStringOrNull("trackingQuery") ?: "",
            )
        }
    }

    override suspend fun getCreators(): List<Creator> {
        val json = get("/api/creators")
        return json.getJSONArray("creators").map { item ->
            Creator(
                id = item.getString("id"),
                handle = item.getString("handle"),
                displayName = item.optStringOrNull("displayName"),
                platform = item.getString("platform"),
                category = runCatching { CreatorCategory.valueOf(item.getString("category").uppercase()) }
                    .getOrDefault(CreatorCategory.RESEARCH_NEXT),
                readinessScore = if (item.isNull("readinessScore")) null else item.getInt("readinessScore"),
                followerCount = if (item.isNull("followerCount")) null else item.getInt("followerCount"),
                creatorProductMoment = item.optStringOrNull("creatorProductMoment"),
                notes = item.optStringOrNull("notes"),
                rejectionReason = item.optStringOrNull("rejectionReason"),
                lastInteractionAt = item.optStringOrNull("lastInteractionAt"),
            )
        }
    }

    override suspend fun getCampaigns(): List<Campaign> {
        val json = get("/api/campaigns")
        return json.getJSONArray("campaigns").map { item ->
            Campaign(
                id = item.getString("id"),
                thesis = item.getString("thesis"),
                status = item.getString("status"),
                decidedBy = item.optStringOrNull("decidedBy"),
                decidedAt = item.optStringOrNull("decidedAt"),
                assets = item.getJSONArray("assets").map { asset ->
                    CampaignAsset(
                        id = asset.getString("id"),
                        platform = asset.getString("platform"),
                        assetType = asset.getString("assetType"),
                        stage = asset.getString("stage"),
                        latestBody = asset.optStringOrNull("latestBody"),
                        reviewPassCount = asset.getInt("reviewPassCount"),
                        reviewFailCount = asset.getInt("reviewFailCount"),
                    )
                },
            )
        }
    }

    override suspend fun getCostSummary(): CostSummary {
        // Folded into /api/summary (?view=cost) to free a serverless-function
        // slot for /api/growth-pulse -- see backend/api/summary.ts's doc
        // comment. Response shape is unchanged, only the URL moved.
        val json = get("/api/summary?view=cost")
        return CostSummary(
            totalCostUsd = json.getDouble("totalCostUsd"),
            last24hCostUsd = json.getDouble("last24hCostUsd"),
            totalCalls = json.getInt("totalCalls"),
        )
    }

    override suspend fun decideApproval(campaignAssetId: String, approve: Boolean): VideoRenderOutcome? {
        val body = JSONObject()
            .put("campaignAssetId", campaignAssetId)
            .put("action", if (approve) "approve" else "reject")
            .put("decidedBy", deciderName)
        return parseVideoRenderOutcome(post("/api/approvals", body))
    }

    override suspend fun setPaused(paused: Boolean) {
        post("/api/summary", JSONObject().put("paused", paused))
    }

    override suspend fun handOffAsset(campaignAssetId: String): HandOffResult {
        val body = JSONObject().put("action", "hand-off").put("campaignAssetId", campaignAssetId)
        val json = post("/api/approvals", body)
        return HandOffResult(campaignAssetId = json.getString("campaignAssetId"), stage = json.getString("stage"))
    }

    override suspend fun regenerateTodayXPost(): TodayXPost {
        val json = post("/api/summary?resource=x-feed-post", JSONObject().put("action", "regenerate"))
        return json.optJSONObject("todayXPost").toTodayXPost()
    }

    override suspend fun markTodayXPostPosted(campaignAssetId: String, postedText: String): TodayXPost {
        val body = JSONObject().put("action", "mark-posted").put("campaignAssetId", campaignAssetId).put("postedText", postedText)
        val json = post("/api/summary?resource=x-feed-post", body)
        return json.optJSONObject("todayXPost").toTodayXPost()
    }

    override suspend fun getTodayXPostHistory(): List<XFeedPostHistoryEntry> {
        val json = get("/api/summary?resource=x-feed-post-history")
        return json.getJSONArray("entries").map { item ->
            XFeedPostHistoryEntry(
                operatingDate = item.getString("operatingDate"),
                state = runCatching { XFeedPostHistoryState.valueOf(item.getString("state").uppercase()) }
                    .getOrDefault(XFeedPostHistoryState.FAILED),
                topicLabel = item.optStringOrNull("topicLabel"),
                previewText = item.optStringOrNull("previewText"),
                reason = item.optStringOrNull("reason"),
                campaignAssetId = item.optStringOrNull("campaignAssetId"),
            )
        }
    }

    private fun JSONObject.toInboundEngagement() = InboundEngagement(
        id = getString("id"),
        platform = getString("platform"),
        authorHandle = optStringOrNull("authorHandle"),
        body = getString("body"),
        inResponseToText = optStringOrNull("inResponseToText"),
        priority = runCatching { InboundPriority.valueOf(getString("priority").uppercase()) }
            .getOrDefault(InboundPriority.P4_MENTION),
        status = getString("status"),
        draftResponse = optStringOrNull("draftResponse"),
        respondedAt = optStringOrNull("respondedAt"),
        isRepeatEngager = getBoolean("isRepeatEngager"),
        creatorHandle = optStringOrNull("creatorHandle"),
        observedAt = getString("observedAt"),
        sourceReference = optStringOrNull("sourceReference"),
    )

    // Folded into /api/approvals (?resource=inbound) rather than a new endpoint --
    // Vercel Hobby's 12-serverless-function cap is already fully used (see api/ingest.ts
    // for the same reasoning applied to signal sources).
    override suspend fun getInboundQueue(): List<InboundEngagement> {
        val json = get("/api/approvals?resource=inbound")
        return json.getJSONArray("items").map { it.toInboundEngagement() }
    }

    override suspend fun getInboundSummary(): InboundSummary {
        val json = get("/api/approvals?resource=inbound&summary=1")
        return InboundSummary(
            needsResponse = json.getInt("needsResponse"),
            followUp = json.getInt("followUp"),
            repeatEngagers = json.getInt("repeatEngagers"),
            overdue = json.getInt("overdue"),
        )
    }

    override suspend fun draftInboundResponse(id: String): InboundEngagement {
        val json = postExpectingDraftRejection("/api/approvals?resource=inbound", JSONObject().put("action", "draft").put("id", id))
        return json.toInboundEngagement()
    }

    override suspend fun markInboundResponded(id: String, note: String?, finalResponse: String?) {
        val body = JSONObject().put("action", "mark-responded").put("id", id)
        if (note != null) body.put("note", note)
        // Only sent when the owner actually changed the draft -- the backend keeps it as a tone example for future drafts.
        if (finalResponse != null) body.put("finalResponse", finalResponse)
        post("/api/approvals?resource=inbound", body)
    }

    override suspend fun markInboundFollowUp(id: String) {
        post("/api/approvals?resource=inbound", JSONObject().put("action", "follow-up").put("id", id))
    }

    override suspend fun closeInbound(id: String) {
        post("/api/approvals?resource=inbound", JSONObject().put("action", "close").put("id", id))
    }

    override suspend fun runInboundBacklogRecovery() {
        post("/api/approvals?resource=inbound", JSONObject().put("action", "backlog-recover"))
    }

    private fun JSONObject.toProspectingCandidate() = ProspectingCandidate(
        id = getString("id"),
        // Every row has a platform server-side; "x" is only the fallback for a
        // response predating the field.
        platform = optStringOrNull("platform") ?: "x",
        discoveryQuery = getString("discoveryQuery"),
        discoveryLabel = optStringOrNull("discoveryLabel") ?: getString("discoveryQuery"),
        replyClass = optStringOrNull("replyClass") ?: "B",
        authorHandle = optStringOrNull("authorHandle"),
        authorFollowerCount = if (isNull("authorFollowerCount")) null else getInt("authorFollowerCount"),
        authorVerified = if (isNull("authorVerified")) null else getBoolean("authorVerified"),
        postText = getString("postText"),
        postUrl = getString("postUrl"),
        postCreatedAt = optStringOrNull("postCreatedAt"),
        discoveredAt = optStringOrNull("discoveredAt"),
        opportunityScore = getDouble("opportunityScore"),
        scoreBreakdown = optJSONObject("scoreBreakdown")?.toStringMap() ?: emptyMap(),
        creatorCandidate = optBoolean("creatorCandidate", false),
        status = getString("status"),
        draftReply = optStringOrNull("draftReply"),
        replyMentionsFillbook = if (isNull("replyMentionsFillbook")) null else getBoolean("replyMentionsFillbook"),
        replyUsedLink = if (isNull("replyUsedLink")) null else getBoolean("replyUsedLink"),
    )

    private fun JSONObject.toProspectingDiagnostics() = ProspectingDiagnostics(
        totalConsidered = getInt("totalConsidered"),
        selected = getInt("selected"),
        deferred = getInt("deferred"),
        belowQualityBar = getInt("belowQualityBar"),
        tooOldForToday = getInt("tooOldForToday"),
    )

    // Folded into /api/approvals (?resource=prospecting) -- same 12-function-cap reasoning as inbound above.
    override suspend fun getProspectingQueue(): ProspectingQueueResult {
        val json = get("/api/approvals?resource=prospecting")
        return ProspectingQueueResult(
            candidates = json.getJSONArray("items").map { it.toProspectingCandidate() },
            // Null (not a zeroed-out instance) when this response predates the
            // diagnostics field -- optJSONObject returns null for a missing
            // key rather than throwing, which is exactly the "older/unknown
            // API response" fallback case this is meant to represent.
            diagnostics = json.optJSONObject("diagnostics")?.toProspectingDiagnostics(),
            pacing = json.optJSONObject("pacing")?.toProspectingPacing(),
        )
    }

    private fun JSONObject.toProspectingPacing() = ProspectingPacing(
        repliedLast24h = optInt("repliedLast24h"),
        dailyCap = optInt("dailyCap", 5),
        cooldownMinutes = optInt("cooldownMinutes", 20),
        nextReplyAtMillis = if (isNull("nextReplyAt")) null else runCatching { java.time.Instant.parse(getString("nextReplyAt")).toEpochMilli() }.getOrNull(),
        reason = if (isNull("reason")) null else optString("reason"),
    )

    override suspend fun draftProspectingReply(id: String): ProspectingCandidate {
        val json = postExpectingDraftRejection("/api/approvals?resource=prospecting", JSONObject().put("action", "draft").put("id", id))
        return json.toProspectingCandidate()
    }

    override suspend fun openProspectingCandidate(id: String) {
        post("/api/approvals?resource=prospecting", JSONObject().put("action", "open").put("id", id))
    }

    override suspend fun markProspectingReplied(id: String, finalReply: String?, mentionsFillbook: Boolean?, usedLink: Boolean?): ProspectingCandidate {
        val body = JSONObject().put("action", "mark-replied").put("id", id)
        if (finalReply != null) body.put("finalReply", finalReply)
        if (mentionsFillbook != null) body.put("mentionsFillbook", mentionsFillbook)
        if (usedLink != null) body.put("usedLink", usedLink)
        val json = post("/api/approvals?resource=prospecting", body)
        return json.toProspectingCandidate()
    }

    override suspend fun markProspectingSkipped(id: String, reason: String?) {
        val body = JSONObject().put("action", "skip").put("id", id)
        if (reason != null) body.put("reason", reason)
        post("/api/approvals?resource=prospecting", body)
    }

    override suspend fun markProspectingNotRelevant(id: String) {
        post("/api/approvals?resource=prospecting", JSONObject().put("action", "not-relevant").put("id", id))
    }

    override suspend fun markProspectingAlreadyHandled(id: String) {
        post("/api/approvals?resource=prospecting", JSONObject().put("action", "already-handled").put("id", id))
    }

    private fun JSONObject.toProspectingSearchRunResult(): ProspectingSearchRunResult = ProspectingSearchRunResult(
        skipped = optBoolean("skipped", false),
        skipReason = optStringOrNull("skipReason"),
        topicsSearched = optJSONArray("topicsSearched")?.mapStrings() ?: emptyList(),
        postsRead = optInt("postsRead", 0),
        newCandidates = optInt("newCandidates", 0),
        excludedAsSpam = optInt("excludedAsSpam", 0),
        costUsd = optDouble("costUsd", 0.0),
    )

    override suspend fun runProspectingSearchNow(): ProspectingSearchRunResult {
        val json = post("/api/ingest?source=x_prospecting", JSONObject())
        return json.getJSONObject("result").toProspectingSearchRunResult()
    }

    private fun JSONObject.toPartnershipProspect(): PartnershipProspect {
        val socialLinksObj = optJSONObject("socialLinks")
        val socialLinks = mutableMapOf<String, String>()
        socialLinksObj?.keys()?.forEach { key -> socialLinks[key] = socialLinksObj.getString(key) }
        return PartnershipProspect(
            id = getString("id"),
            organizationName = getString("organizationName"),
            contactName = optStringOrNull("contactName"),
            partnerCategory = runCatching { PartnerCategory.valueOf(getString("partnerCategory").uppercase()) }.getOrDefault(PartnerCategory.OTHER),
            stage = runCatching { PartnershipStage.valueOf(getString("stage").uppercase()) }.getOrDefault(PartnershipStage.PROSPECT),
            websiteUrl = optStringOrNull("websiteUrl"),
            socialLinks = socialLinks,
            contactRoute = optStringOrNull("contactRoute"),
            contactRouteSource = optStringOrNull("contactRouteSource"),
            audienceFocus = optStringOrNull("audienceFocus"),
            futuresRelevanceEvidence = optStringOrNull("futuresRelevanceEvidence"),
            sourceUrls = optJSONArray("sourceUrls")?.mapStrings() ?: emptyList(),
            researchDate = optStringOrNull("researchDate"),
            competingJournalRelationships = optStringOrNull("competingJournalRelationships"),
            competingJournalEvidence = optStringOrNull("competingJournalEvidence"),
            proposedCollaboration = optStringOrNull("proposedCollaboration"),
            qualificationRationale = optStringOrNull("qualificationRationale"),
            ownerNotes = optStringOrNull("ownerNotes"),
            nextAction = optStringOrNull("nextAction"),
            nextActionDueDate = optStringOrNull("nextActionDueDate"),
            pilotTermsProposed = optStringOrNull("pilotTermsProposed"),
            pilotTermsAgreed = optStringOrNull("pilotTermsAgreed"),
            pilotStartDate = optStringOrNull("pilotStartDate"),
            pilotEndDate = optStringOrNull("pilotEndDate"),
            followUpCount = optInt("followUpCount", 0),
            approvedCampaignAssetId = optStringOrNull("approvedCampaignAssetId"),
            previewText = optStringOrNull("previewText"),
            contactedAt = optStringOrNull("contactedAt"),
            contactedChannel = optStringOrNull("contactedChannel"),
            discoveryScore = if (isNull("discoveryScore")) null else optDouble("discoveryScore").toInt(),
            discoveryConfidence = optStringOrNull("discoveryConfidence"),
            discoveredVia = optString("discoveredVia", "manual"),
            suppressedReason = optStringOrNull("suppressedReason"),
        )
    }

    private fun JSONObject.toDiscoveryRunResult(): PartnershipDiscoveryRunResult = PartnershipDiscoveryRunResult(
        status = getString("status"),
        newCandidates = optInt("newCandidates", 0),
        sourcesSearched = optJSONArray("sourcesSearched")?.mapStrings() ?: emptyList(),
        costUsd = optDouble("costUsd", 0.0),
        error = optStringOrNull("error"),
        skipReason = optStringOrNull("skipReason"),
    )

    override suspend fun getPartnerships(): PartnershipsSummary {
        val json = get("/api/approvals?resource=partnerships")
        val items = json.getJSONArray("items").map { it.toPartnershipProspect() }
        val lastRun = json.optJSONObject("lastDiscoveryRun")?.toDiscoveryRunResult()
        return PartnershipsSummary(items, lastRun)
    }

    override suspend fun refreshPartnershipDiscovery(): PartnershipDiscoveryRunResult {
        val json = post("/api/approvals?resource=partnerships", JSONObject().put("action", "refresh-discovery"))
        return json.toDiscoveryRunResult()
    }

    override suspend fun createPartnership(organizationName: String, contactName: String?, partnerCategory: PartnerCategory, websiteUrl: String?, proposedCollaboration: String?): PartnershipProspect {
        val body = JSONObject()
            .put("action", "create")
            .put("organizationName", organizationName)
            .put("partnerCategory", partnerCategory.name.lowercase())
        if (contactName != null) body.put("contactName", contactName)
        if (websiteUrl != null) body.put("websiteUrl", websiteUrl)
        if (proposedCollaboration != null) body.put("proposedCollaboration", proposedCollaboration)
        return post("/api/approvals?resource=partnerships", body).toPartnershipProspect()
    }

    override suspend fun updatePartnership(id: String, ownerNotes: String?, nextAction: String?, nextActionDueDate: String?, contactRoute: String?, contactRouteSource: String?, audienceFocus: String?, futuresRelevanceEvidence: String?): PartnershipProspect {
        val body = JSONObject().put("action", "update").put("id", id)
        ownerNotes?.let { body.put("ownerNotes", it) }
        nextAction?.let { body.put("nextAction", it) }
        nextActionDueDate?.let { body.put("nextActionDueDate", it) }
        contactRoute?.let { body.put("contactRoute", it) }
        contactRouteSource?.let { body.put("contactRouteSource", it) }
        audienceFocus?.let { body.put("audienceFocus", it) }
        futuresRelevanceEvidence?.let { body.put("futuresRelevanceEvidence", it) }
        return post("/api/approvals?resource=partnerships", body).toPartnershipProspect()
    }

    override suspend fun qualifyPartnership(id: String, rationale: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "qualify").put("id", id).put("rationale", rationale)).toPartnershipProspect()

    override suspend fun generatePartnershipDraft(id: String): PartnershipProspect {
        val result =
            try {
                post("/api/approvals?resource=partnerships", JSONObject().put("action", "generate-draft").put("id", id))
            } catch (e: NetworkException) {
                // approvals.ts converts a thrown PartnershipActionError into an
                // HTTP 404 with a real, actionable {error: message} body (e.g.
                // the evidence-insufficiency guard, or the generation_claimed_at
                // duplicate-request mutex rejection) -- BEFORE this fix, that
                // fell through as a bare NetworkException, which
                // PartnershipsScreen's catch block has no specific handler for,
                // so it silently became the generic "Couldn't complete that
                // action. Check your connection and try again." -- hiding the
                // real, useful reason the owner actually needed to see (add
                // more evidence; wait for the in-flight generation to finish).
                // Confirmed by tracing this exact path end-to-end while
                // verifying this round's new error messages on-device.
                val parsedError = extractPartnershipActionErrorMessage(e.httpCode, e.message)
                if (parsedError != null) throw PartnershipDraftRejectedException(shortReason = parsedError)
                throw e
            }
        // "failed" (didn't pass the mechanical/review gates) and "skipped" (budget
        // exhausted) are real, meaningful outcomes the owner needs to actually see
        // -- not a connection problem, and not something to silently discard.
        // Thrown here (rather than swallowed) so PartnershipsScreen's existing
        // error-display path shows the real reason instead of a generic message.
        when (result.optString("status")) {
            "failed" -> {
                val attempts = result.optInt("attempts", 1)
                throw PartnershipDraftRejectedException(
                    shortReason = "Didn't pass review after $attempts attempt${if (attempts == 1) "" else "s"} -- needs stronger, more specific personalization for this recipient.",
                    details = result.optString("error", "no details returned"),
                )
            }
            "skipped" -> throw PartnershipDraftRejectedException(
                shortReason = "Draft generation skipped -- this month's Partnerships budget is used up.",
                details = result.optString("skipReason", "no details returned"),
            )
        }
        // The generate-draft response is a lightweight result (status/cost), not the full prospect shape --
        // re-fetch this one prospect's real current state (including the new previewText) from the list.
        return getPartnerships().items.first { it.id == id }
    }

    override suspend fun markPartnershipContacted(id: String, channel: String, finalText: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "mark-contacted").put("id", id).put("channel", channel).put("finalText", finalText)).toPartnershipProspect()

    override suspend fun sendPartnershipEmail(id: String, subject: String, finalText: String): PartnershipProspect =
        try {
            post("/api/approvals?resource=partnerships", JSONObject().put("action", "send-email").put("id", id).put("subject", subject).put("finalText", finalText)).toPartnershipProspect()
        } catch (e: NetworkException) {
            // Same 404-with-real-reason pattern as generatePartnershipDraft above --
            // "not an email contact" and "RESEND_API_KEY not configured yet" are
            // real, actionable reasons the owner needs to see, not a generic
            // connectivity message.
            val parsedError = extractPartnershipActionErrorMessage(e.httpCode, e.message)
            if (parsedError != null) throw PartnershipDraftRejectedException(shortReason = parsedError)
            throw e
        }

    override suspend fun recordPartnershipReply(id: String, summary: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "record-reply").put("id", id).put("summary", summary)).toPartnershipProspect()

    override suspend fun startPartnershipPilot(id: String, termsAgreed: String, startDate: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "start-pilot").put("id", id).put("termsAgreed", termsAgreed).put("startDate", startDate)).toPartnershipProspect()

    override suspend fun activatePartnership(id: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "activate").put("id", id)).toPartnershipProspect()

    override suspend fun closePartnership(id: String, reason: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "close").put("id", id).put("reason", reason)).toPartnershipProspect()

    override suspend fun archivePartnership(id: String, reason: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "archive").put("id", id).put("reason", reason)).toPartnershipProspect()

    override suspend fun markPartnershipDoNotContact(id: String, reason: String): PartnershipProspect =
        post("/api/approvals?resource=partnerships", JSONObject().put("action", "do-not-contact").put("id", id).put("reason", reason)).toPartnershipProspect()

    private fun JSONObject.toStrategyItemList(key: String): List<StrategyItem> =
        getJSONArray(key).map { StrategyItem(label = it.optStringOrNull("topic") ?: it.getString("platform") + " / " + it.getString("assetType"), reason = it.getString("reason")) }

    private fun JSONObject.toStrategyVersion(): StrategyVersion = StrategyVersion(
        version = getInt("version"),
        generatedAt = getString("generatedAt"),
        topicsToIncrease = toStrategyItemList("topicsToIncrease"),
        topicsToDecrease = toStrategyItemList("topicsToDecrease"),
        contentToRetire = toStrategyItemList("contentToRetire"),
        formatsToTest = toStrategyItemList("formatsToTest"),
        seoOpportunities = getJSONArray("seoOpportunities").map {
            SeoOpportunity(topic = it.getString("topic"), velocity = it.getDouble("velocity"), hasExistingOpportunity = it.getBoolean("hasExistingOpportunity"))
        },
        creatorOpportunities = getJSONArray("creatorOpportunities").map {
            CreatorOpportunity(
                id = it.getString("id"),
                handle = it.getString("handle"),
                category = it.getString("category"),
                readinessScore = if (it.isNull("readinessScore")) null else it.getInt("readinessScore"),
                daysSinceLastInteraction = if (it.isNull("daysSinceLastInteraction")) null else it.getInt("daysSinceLastInteraction"),
            )
        },
        experimentsToRun = getJSONArray("experimentsToRun").map {
            ExperimentSuggestion(hypothesis = it.getString("hypothesis"), rationale = it.getString("rationale"))
        },
        summary = getString("summary"),
        lowConfidence = getBoolean("lowConfidence"),
    )

    // Folded into /api/summary (?resource=strategy) -- same 12-function-cap reasoning as inbound/prospecting above.
    override suspend fun getLatestStrategy(): StrategyVersion? {
        val json = get("/api/summary?resource=strategy")
        return json.optJSONObject("strategy")?.toStrategyVersion()
    }

    override suspend fun regenerateStrategy(): StrategyVersion {
        val json = post("/api/summary?resource=strategy", JSONObject())
        return json.getJSONObject("strategy").toStrategyVersion()
    }

    private fun JSONObject.toExperimentResult(): ExperimentResult? {
        if (isNull("result")) return null
        val r = getJSONObject("result")
        return ExperimentResult(
            controlRate = if (r.isNull("controlRate")) null else r.getDouble("controlRate"),
            treatmentRate = if (r.isNull("treatmentRate")) null else r.getDouble("treatmentRate"),
            absoluteDifference = if (r.isNull("absoluteDifference")) null else r.getDouble("absoluteDifference"),
            pValue = if (r.isNull("pValue")) null else r.getDouble("pValue"),
            isSignificant = r.getBoolean("isSignificant"),
            insufficientSample = r.getBoolean("insufficientSample"),
            controlSampleSize = r.getInt("controlSampleSize"),
            treatmentSampleSize = r.getInt("treatmentSampleSize"),
            interpretation = r.getString("interpretation"),
            computedAt = r.getString("computedAt"),
        )
    }

    private fun JSONObject.toExperiment(): Experiment {
        val scope = optJSONObject("scope")
        return Experiment(
            id = getString("id"),
            hypothesis = getString("hypothesis"),
            scopePlatform = scope?.optStringOrNull("platform"),
            scopeAssetType = scope?.optStringOrNull("assetType"),
            guardrailNote = optStringOrNull("guardrailNote"),
            status = getString("status"),
            startDate = getString("startDate"),
            endDate = optStringOrNull("endDate"),
            controlWindowStart = getString("controlWindowStart"),
            createdAt = getString("createdAt"),
            result = toExperimentResult(),
        )
    }

    // Folded into /api/summary (?resource=experiments) -- same 12-function-cap reasoning as strategy above.
    override suspend fun getExperiments(): List<Experiment> {
        val json = get("/api/summary?resource=experiments")
        return json.getJSONArray("experiments").map { it.toExperiment() }
    }

    override suspend fun createExperiment(hypothesis: String, scopePlatform: String?, scopeAssetType: String?, guardrailNote: String?, startDate: String, controlWindowDays: Int): Experiment {
        val scope = JSONObject()
        if (scopePlatform != null) scope.put("platform", scopePlatform)
        if (scopeAssetType != null) scope.put("assetType", scopeAssetType)
        val body = JSONObject()
            .put("hypothesis", hypothesis)
            .put("scope", scope)
            .put("startDate", startDate)
            .put("controlWindowDays", controlWindowDays)
        if (guardrailNote != null) body.put("guardrailNote", guardrailNote)
        val json = post("/api/summary?resource=experiments", body)
        return json.getJSONObject("experiment").toExperiment()
    }

    override suspend fun measureExperiment(id: String): Experiment {
        val json = post("/api/summary?resource=experiments", JSONObject().put("id", id).put("action", "measure"))
        return json.getJSONObject("experiment").toExperiment()
    }

    override suspend fun completeExperiment(id: String): Experiment {
        val json = post("/api/summary?resource=experiments", JSONObject().put("id", id).put("action", "complete"))
        return json.getJSONObject("experiment").toExperiment()
    }

    override suspend fun abortExperiment(id: String) {
        post("/api/summary?resource=experiments", JSONObject().put("id", id).put("action", "abort"))
    }

    private fun JSONObject.toAppNotification() = AppNotification(
        id = getString("id"),
        type = getString("type"),
        title = getString("title"),
        body = getString("body"),
        severity = getString("severity"),
        createdAt = getString("createdAt"),
        readAt = optStringOrNull("readAt"),
        relatedId = optStringOrNull("relatedId"),
    )

    override suspend fun getNotifications(): Pair<List<AppNotification>, Int> {
        val json = get("/api/summary?resource=notifications")
        val items = json.getJSONArray("notifications").map { it.toAppNotification() }
        return items to json.getInt("unreadCount")
    }

    override suspend fun markNotificationRead(id: String) {
        post("/api/summary?resource=notifications", JSONObject().put("id", id).put("action", "mark-read"))
    }

    override suspend fun markAllNotificationsRead() {
        post("/api/summary?resource=notifications", JSONObject().put("action", "mark-all-read"))
    }

    private fun JSONObject.toOpportunitySummary() = parseOpportunitySummary(this)

    override suspend fun getMorningBrief(): MorningBrief {
        val json = get("/api/summary?resource=brief")
        return MorningBrief(
            generatedAt = json.getString("generatedAt"),
            signalsOvernight = json.getInt("signalsOvernight"),
            topNewOpportunities = json.getJSONArray("topNewOpportunities").map { it.toOpportunitySummary() },
            pendingApprovals = json.getInt("pendingApprovals"),
            inboundNeedsResponse = json.getInt("inboundNeedsResponse"),
            strategySummary = json.optStringOrNull("strategySummary"),
            unreadNotificationCount = json.getJSONArray("unreadNotifications").length(),
        )
    }

    private fun JSONObject.toVideoRenderMetadata(): VideoRenderMetadata? {
        val meta = optJSONObject("videoMetadata") ?: return null
        return VideoRenderMetadata(
            youtubeTitle = meta.getString("youtubeTitle"),
            youtubeDescription = meta.getString("youtubeDescription"),
            tiktokCaption = meta.getString("tiktokCaption"),
            instagramCaption = meta.optStringOrNull("instagramCaption"),
            hashtags = meta.optJSONArray("hashtags")?.mapStrings() ?: emptyList(),
            disclosureCta = meta.optStringOrNull("disclosureCta"),
            youtubeThumbnailConcept = meta.optStringOrNull("youtubeThumbnailConcept"),
            pinnedComment = meta.optStringOrNull("pinnedComment"),
        )
    }

    private fun JSONObject.toVideoRenderStatus() = VideoRenderStatus(
        id = getString("id"),
        campaignAssetId = getString("campaignAssetId"),
        status = getString("status"),
        downloadUrl = optStringOrNull("downloadUrl"),
        thumbnailDownloadUrl = optStringOrNull("thumbnailDownloadUrl"),
        durationSeconds = if (isNull("durationSeconds")) null else getDouble("durationSeconds"),
        error = optStringOrNull("error"),
        createdAt = getString("createdAt"),
        updatedAt = getString("updatedAt"),
        videoMetadata = toVideoRenderMetadata(),
        publishedUrl = optStringOrNull("publishedUrl"),
        conceptTitle = optStringOrNull("conceptTitle"),
        conceptDay = if (isNull("conceptDay")) null else optInt("conceptDay", 0).takeIf { it > 0 },
    )

    // Folded into /api/approvals (?resource=video-status) -- same
    // Vercel Hobby 12-function-cap reasoning as inbound/prospecting/
    // partnerships above.
    override suspend fun getVideoRenderStatuses(): List<VideoRenderStatus> {
        val json = get("/api/approvals?resource=video-status")
        return json.getJSONArray("items").map { it.toVideoRenderStatus() }
    }

    override suspend fun registerDeviceToken(fcmToken: String) {
        post("/api/approvals?resource=video-status", JSONObject().put("action", "register-device").put("fcmToken", fcmToken))
    }

    override suspend fun dismissVideoRender(videoRenderId: String) {
        post("/api/approvals?resource=video-status", JSONObject().put("action", "dismiss").put("videoRenderId", videoRenderId))
    }

    override suspend fun retryVideoRender(videoRenderId: String): String? {
        val json = post("/api/approvals?resource=video-status", JSONObject().put("action", "retry-render").put("videoRenderId", videoRenderId))
        return if (json.optBoolean("queued", false)) null else json.optString("reason", "The render could not be queued.")
    }

    override suspend fun setVideoPublishedUrl(videoRenderId: String, publishedUrl: String) {
        post(
            "/api/approvals?resource=video-status",
            JSONObject().put("action", "set-published-url").put("videoRenderId", videoRenderId).put("publishedUrl", publishedUrl),
        )
    }

    override suspend fun getPostingOverview(): PostingOverview = get("/api/approvals?resource=posting").toPostingOverview()

    override suspend fun recordVideoPost(campaignAssetId: String, videoRenderId: String?, platform: PostingPlatform, url: String) {
        val body = JSONObject().put("action", "record-post").put("campaignAssetId", campaignAssetId).put("platform", platform.apiName).put("url", url)
        if (videoRenderId != null) body.put("videoRenderId", videoRenderId)
        post("/api/approvals?resource=posting", body)
    }

    override suspend fun recordPostStats(videoPostId: String, views: Int?, likes: Int?, comments: Int?, shares: Int?) {
        val body = JSONObject().put("action", "record-stats").put("videoPostId", videoPostId)
        views?.let { body.put("views", it) }
        likes?.let { body.put("likes", it) }
        comments?.let { body.put("comments", it) }
        shares?.let { body.put("shares", it) }
        post("/api/approvals?resource=posting", body)
    }

    override suspend fun getEveningReport(): EveningReport {
        val json = get("/api/summary?resource=evening-report")
        return EveningReport(
            generatedAt = json.getString("generatedAt"),
            assetsDrafted = json.getInt("assetsDrafted"),
            approvedToday = json.getInt("approvedToday"),
            rejectedToday = json.getInt("rejectedToday"),
            reviewPassRate = if (json.isNull("reviewPassRate")) null else json.getDouble("reviewPassRate"),
            costTodayUsd = json.getDouble("costTodayUsd"),
            inboundResolvedToday = json.getInt("inboundResolvedToday"),
            topOpportunity = json.optJSONObject("topOpportunity")?.toOpportunitySummary(),
        )
    }
}

/** [httpCode] lets callers tell an auth/config problem (401/500) apart from an unrelated server/network failure -- both used to surface as the same generic message before this existed. */
class NetworkException(message: String, val httpCode: Int? = null) : Exception(message)

/**
 * A 401/403 means the app's own APP_API_TOKEN is missing, stale, or was
 * rotated server-side without a matching APK rebuild (see
 * requireAppAuth.ts) -- fundamentally different from a network/offline
 * failure, and no amount of tapping Retry fixes it. Every screen's
 * "couldn't load" catch block used to show the same generic "check your
 * connection" message for both cases even though [NetworkException]
 * already captured [NetworkException.httpCode] -- confirmed as a real gap
 * in the 2026-09-07 release audit. Returns null (never a message) for
 * anything else, including a bare offline/timeout failure, so callers
 * keep their own existing fallback text and existing Retry behavior
 * unchanged.
 */
fun authErrorMessage(e: Throwable): String? =
    if (e is NetworkException && (e.httpCode == 401 || e.httpCode == 403)) {
        "Authentication expired. Reopen the app or reinstall the current APK."
    } else {
        null
    }

/**
 * Pure, unit-testable parsing for the `{id, title, score}`-shaped JSON both
 * getMorningBrief's topNewOpportunities and getEveningReport's topOpportunity
 * produce. `id` is deliberately optional (production bug, 2026-09-07): the
 * evening-report resource's topOpportunity field (backend/api/summary.ts's
 * handleEveningReport) only ever selects title/score, never id -- unlike the
 * morning-brief resource's topNewOpportunities, which does include it.
 * Neither EveningReportScreen nor MorningBriefScreen ever reads
 * OpportunitySummary.id (both only render title/score), so requiring it
 * unconditionally was an unnecessary, over-strict assumption that turned a
 * missing-but-unneeded field into a hard parse failure -- confirmed live via
 * a JSONException thrown from getString("id") every time evening-report's
 * trailing-24h window had a real new opportunity to report, surfacing to the
 * owner as a generic "check your connection" message instead of real data.
 */
fun parseOpportunitySummary(json: JSONObject) = OpportunitySummary(
    id = json.optString("id", ""),
    title = json.getString("title"),
    score = json.getDouble("score"),
)

/**
 * Pure, unit-testable extraction of the real actionable message
 * approvals.ts sends back when it catches a thrown PartnershipActionError
 * (evidence-insufficiency, the generation_claimed_at duplicate-request
 * mutex) -- it converts that into an HTTP 404 with a JSON `{error: string}`
 * body (see approvals.ts's own catch block), which post()'s generic
 * failure path wraps into `NetworkException("POST $path failed: HTTP 404 --
 * $responseBody", 404)`. Before this existed, that whole message fell
 * through PartnershipsScreen's catch-all as a bare NetworkException,
 * silently replacing the real reason with "Couldn't complete that action.
 * Check your connection and try again." -- confirmed by tracing this exact
 * path while verifying this round's new error messages on-device. Returns
 * null (never throws) for anything that isn't this specific shape, so a
 * genuine network/auth failure still surfaces as NetworkException.
 */
// Deliberately a hand-rolled regex, not JSONObject -- org.json is an
// unmocked Android stub under a plain JVM unit test (no Robolectric in
// this project), so a real parse here would silently return null in every
// test and only work on-device. approvals.ts's error bodies are always a
// single flat `{"error": "..."}` (see its catch block), so this is a
// bounded, safe simplification, not a general JSON parser.
private val ERROR_FIELD_PATTERN = Regex(""""error"\s*:\s*"((?:[^"\\]|\\.)*)"""")

private fun unescapeJsonString(s: String): String =
    s.replace("\\\"", "\"").replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t").replace("\\\\", "\\")

/**
 * "Create Fillbook Video" (2026-09-08): extracts the real, actionable
 * error message api/run-campaign.ts's `topic`/`assetType` handling sends
 * back -- an off-topic topic, an opportunity that doesn't read as
 * trading-related enough, invalid topic length, a duplicate-topic conflict,
 * or a server-side generation error (500). The 500 body carries the same
 * `{"error": "..."}` shape as 400/409, so we surface it rather than hiding
 * it behind the generic "check your connection" fallback.
 */
fun extractVideoScriptRequestErrorMessage(httpCode: Int?, networkExceptionMessage: String?): String? {
    if (httpCode != 400 && httpCode != 409 && httpCode != 500) return null
    val body = networkExceptionMessage?.substringAfter(" -- ", missingDelimiterValue = "") ?: return null
    if (body.isBlank()) return null
    val raw = ERROR_FIELD_PATTERN.find(body)?.groupValues?.get(1) ?: return null
    val error = unescapeJsonString(raw)
    return error.takeIf { it.isNotBlank() }
}

/**
 * Same idea as [extractVideoScriptRequestErrorMessage], for Research
 * Lab's own use of api/run-campaign.ts's `topic`/`assetType` validation --
 * an off-topic topic, invalid length, an opportunity that doesn't read as
 * trading-related enough, a duplicate-topic conflict (409), or a
 * duplicate-opportunity conflict (409, this opportunity already has
 * non-retired research).
 */
fun extractResearchRequestErrorMessage(httpCode: Int?, networkExceptionMessage: String?): String? {
    if (httpCode != 400 && httpCode != 409) return null
    val body = networkExceptionMessage?.substringAfter(" -- ", missingDelimiterValue = "") ?: return null
    if (body.isBlank()) return null
    val raw = ERROR_FIELD_PATTERN.find(body)?.groupValues?.get(1) ?: return null
    val error = unescapeJsonString(raw)
    return error.takeIf { it.isNotBlank() }
}

fun extractPartnershipActionErrorMessage(httpCode: Int?, networkExceptionMessage: String?): String? {
    if (httpCode != 404) return null
    val body = networkExceptionMessage?.substringAfter(" -- ", missingDelimiterValue = "") ?: return null
    if (body.isBlank()) return null
    val raw = ERROR_FIELD_PATTERN.find(body)?.groupValues?.get(1) ?: return null
    val error = unescapeJsonString(raw)
    return error.takeIf { it.isNotBlank() }
}

/**
 * Same idea as extractPartnershipActionErrorMessage, but for
 * opportunities.ts's draft-reply action specifically, which converts a
 * thrown OpportunityReplyError into HTTP 400 (backend/api/opportunities.ts's
 * own catch block) -- a different status than the Partnerships/Inbound/
 * Prospecting 404 pattern, since this is a separate backend route with its
 * own error-status convention. Confirmed as a real gap in the 2026-09-07
 * release audit: without this, RadarScreen's draft-reply failure always
 * showed the same generic "check your connection" message, discarding the
 * real, actionable rejection reason the backend had already sent.
 */
fun extractOpportunityReplyErrorMessage(httpCode: Int?, networkExceptionMessage: String?): String? {
    if (httpCode != 400) return null
    val body = networkExceptionMessage?.substringAfter(" -- ", missingDelimiterValue = "") ?: return null
    if (body.isBlank()) return null
    val raw = ERROR_FIELD_PATTERN.find(body)?.groupValues?.get(1) ?: return null
    val error = unescapeJsonString(raw)
    return error.takeIf { it.isNotBlank() }
}

/**
 * A real, meaningful outcome from generate-draft (failed review/mechanical
 * gate, or budget exhaustion) -- distinct from NetworkException so callers
 * never mistake a legitimate content-quality rejection for a connectivity
 * problem. [shortReason] is a plain-language one-liner for the primary
 * error display; [details] is the full raw reviewer/skip text, shown only
 * behind an explicit "Show details" disclosure -- the real per-agent
 * critique is long and technical (confirmed on a real device: nine
 * reviewers' full reasoning at once is a wall of text), not something to
 * dump on the owner by default.
 */
class PartnershipDraftRejectedException(val shortReason: String, val details: String? = null) : Exception(shortReason)

/**
 * Same real-outcome-not-a-connectivity-problem distinction as
 * PartnershipDraftRejectedException above, for Prospecting's and Inbound's
 * draft-reply actions -- e.g. the mechanical reply guardrail (banned
 * generic phrase, an unverified claim, an undeclared link) rejecting a
 * draft before it's ever persisted. Kept as its own, more generically
 * named type rather than reusing the Partnership-named one.
 */
class DraftRejectedException(val shortReason: String) : Exception(shortReason)

/** Small helpers since org.json's JSONArray predates Kotlin collections. */
private fun <T> JSONArray.map(transform: (JSONObject) -> T): List<T> =
    (0 until length()).map { transform(getJSONObject(it)) }

private fun JSONArray.mapStrings(): List<String> =
    (0 until length()).map { getString(it) }

private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key) || !has(key)) null else getString(key)

private fun JSONObject.toIntMap(): Map<String, Int> =
    keys().asSequence().associateWith { key -> getInt(key) }

private fun JSONObject.toStringMap(): Map<String, String> =
    keys().asSequence().associateWith { key -> getString(key) }

/**
 * Reads the `videoRender` block POST /api/approvals adds when an approved asset was a video script.
 * Null when the response has none (a reject, or any other asset type), so callers only report a render
 * outcome when there is one.
 */
internal fun parseVideoRenderOutcome(response: JSONObject): VideoRenderOutcome? {
    val block = response.optJSONObject("videoRender") ?: return null
    return VideoRenderOutcome(
        queued = block.optBoolean("queued", false),
        alreadyExisted = block.optBoolean("alreadyExisted", false),
        reason = if (block.isNull("reason")) null else block.optString("reason").ifBlank { null },
    )
}


/** The concept request title the backend stores begins with this; the dialog shows only the concept's own title. */
private const val MOTION_CONCEPT_REQUEST_PREFIX = "Motion concept request: "

/**
 * Reads GET /api/run-campaign: the concepts on offer (each with its day in the daily order), the used-up ones, the one-a-day
 * state and the next concept. Every field added after the first version is optional, so an older server still parses.
 */
internal fun parseMotionConceptCatalog(json: JSONObject): MotionConceptCatalog {
    val concepts = json.getJSONArray("motionConcepts").map { item ->
        MotionConcept(
            id = item.getString("id"),
            title = item.getString("title"),
            hook = item.getString("hook"),
            topic = item.getString("topic"),
            day = item.optInt("day", 0).takeIf { it > 0 },
        )
    }
    val unavailable = json.optJSONArray("unavailableMotionConcepts")?.map { item ->
        UnavailableMotionConcept(
            id = item.getString("id"),
            title = item.getString("title"),
            state = item.optString("state", ""),
            day = item.optInt("day", 0).takeIf { it > 0 },
        )
    } ?: emptyList()
    val limit = json.optJSONObject("dailyLimit")
    return MotionConceptCatalog(
        concepts = concepts,
        unavailable = unavailable.sortedBy { it.day ?: Int.MAX_VALUE },
        dailyLimit = DailyRequestLimit(
            requestedToday = limit?.optString("requestedToday", "")?.takeIf { it.isNotBlank() && it != "null" }?.removePrefix(MOTION_CONCEPT_REQUEST_PREFIX),
            nextRequestAt = limit?.optString("nextRequestAt", "")?.takeIf { it.isNotBlank() && it != "null" },
        ),
        nextConceptId = json.optString("nextConceptId", "").takeIf { it.isNotBlank() && it != "null" },
    )
}


/** Reads GET /api/summary's `video` block (null stays null: the card is simply not shown). */
internal fun parseTodaysVideo(json: JSONObject?): TodaysVideo? {
    if (json == null) return null
    val state = runCatching { TodaysVideoState.valueOf(json.getString("state").uppercase()) }.getOrNull() ?: return null
    return TodaysVideo(
        state = state,
        title = json.optString("title", "").takeIf { it.isNotBlank() && it != "null" },
        day = json.optInt("day", 0).takeIf { it > 0 },
        headline = json.optString("headline", ""),
        detail = json.optString("detail", ""),
        platformsPosted = json.optJSONArray("platformsPosted")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
    )
}
