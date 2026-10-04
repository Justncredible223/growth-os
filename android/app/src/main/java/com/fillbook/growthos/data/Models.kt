package com.fillbook.growthos.data

enum class Urgency { LOW, NORMAL, HIGH }

/** One entry in the small, fixed catalog of concepts with real verified product-motion footage -- see GrowthOsRepository.getMotionConcepts's own doc comment. */
data class MotionConcept(
    val id: String,
    val title: String,
    val hook: String,
    val topic: String,
    /** Its day in the fixed daily order (1-30), or null for a concept outside it. */
    val day: Int? = null,
)

/** A daily concept that cannot be requested again: already [state] "made", "waiting" in Approvals, or "rejected". */
data class UnavailableMotionConcept(val id: String, val title: String, val state: String, val day: Int?)

/** The one-a-day rule: [requestedToday] is the title of the concept already requested today (null when today is free); [nextRequestAt] is when the next request opens (ISO instant). */
data class DailyRequestLimit(val requestedToday: String?, val nextRequestAt: String?)

/** What the Create Fillbook Video dialog needs: the concepts on offer in day order, the used-up ones, the one-a-day state, and which concept is next. */
data class MotionConceptCatalog(
    val concepts: List<MotionConcept>,
    val unavailable: List<UnavailableMotionConcept>,
    val dailyLimit: DailyRequestLimit,
    val nextConceptId: String?,
)

enum class HealthStatus { HEALTHY, DEGRADED, DOWN, NOT_CONNECTED }

data class Opportunity(
    val id: String,
    val title: String,
    val score: Double,
    val urgency: Urgency,
    val rationale: String,
    val channels: List<String>,
    /**
     * Only present when this opportunity traces back to exactly one real
     * X mention (see SupabaseOpportunityRepository.attachSourceUrls on
     * the backend) -- its presence, not any title/label heuristic, is
     * what marks this as an "engagement" opportunity (reply-worthy)
     * rather than a "campaign/content" opportunity.
     */
    val sourceUrl: String? = null,
    /** The real @handle X resolved for the mention's author, when it did. Never guessed -- null, not a fake handle, when X couldn't resolve one. */
    val authorHandle: String? = null,
) {
    val isEngagementOpportunity: Boolean get() = sourceUrl != null
}

/** Result of handing a ready campaign asset off to the owner (opened the platform composer) -- never a publish confirmation. */
data class HandOffResult(val campaignAssetId: String, val stage: String)

/**
 * What the server did about rendering when a video_script was approved. `queued` is true when a render is
 * now in progress (including one that already existed); otherwise `reason` says why not, e.g.
 * "daily_render_cap_reached (1 renders today, cap is 1)". Null from decideApproval means the asset was not
 * a video (or it was rejected), so there was nothing to report.
 */
data class VideoRenderOutcome(val queued: Boolean, val alreadyExisted: Boolean, val reason: String?)

enum class AssetStage {
    DRAFT, FINAL_DRAFT, READY_FOR_OWNER, HANDED_OFF
}

data class ApprovalAsset(
    val id: String,
    val campaignTitle: String,
    val platform: String,
    val assetType: String,
    val previewText: String,
    val stage: AssetStage,
    val isAutoDraft: Boolean,
    val costUsd: Double?,
    val generatedAt: String?,
    val reviewPassCount: Int,
    val reviewFailCount: Int,
    /**
     * A consistent UTM query string (utm_source/medium/campaign/content)
     * to append to any fillbookhq.com link in the post -- NOT real click/
     * signup tracking (Growth OS has no access to FillbookHQ's analytics
     * to read that back). See backend/src/attribution/utmBuilder.ts.
     */
    val trackingQuery: String,
    /** The daily concept behind a motion video draft and its day (1-30); null for any other draft. */
    val conceptTitle: String? = null,
    val conceptDay: Int? = null,
)

data class HealthItem(
    val label: String,
    val status: HealthStatus,
    val detail: String,
)

data class AutoDraftStatus(
    val lastRunDate: String?,
    val lastRunStatus: String?,
    val lastRunSkipReason: String?,
    val backlogCount: Int,
    val backlogCap: Int,
    val monthSpendUsd: Double,
    val monthBudgetUsd: Double,
)

data class AnalyticsBreakdown(
    val totalSignals: Int,
    val signalsBySource: Map<String, Int>,
    val opportunitiesByStatus: Map<String, Int>,
    val campaignAssetsByStage: Map<String, Int>,
    val totalCostUsd: Double,
    /** Properly date-scoped (today, all providers) -- see backend's getTodaySpendUsd. Use this for any "today" spend display; totalCostUsd is lifetime. */
    val todaySpendUsd: Double,
    val autoDraft: AutoDraftStatus,
    val growthLoop: GrowthLoopSummary? = null,
)

/**
 * "Published content -> customer outcomes" growth loop (2026-09-18) --
 * see backend/src/attribution/growthLoopAnalytics.ts's own header comment
 * for exactly what each field can and cannot honestly claim. [activeSubscriptionsUnavailableReason]
 * is always non-null: this project has no access to FillbookHQ's own
 * billing database (isolated by design), so "current active
 * subscriptions" is never computed, only explained as unavailable.
 */
data class GrowthLoopSummary(
    val windowDays: Int,
    val publishedContentCount: Int,
    val trackedLinkClicks: Int,
    val funnelConnected: Boolean,
    val signups: Int,
    val activated: Int,
    val firstPaidConversions: Int,
    val contentProductionCostUsd: Double,
    val costPerSignup: Double?,
    val activeSubscriptionsUnavailableReason: String,
    val byChannel: List<GrowthLoopChannelBreakdown>,
    val attributionNote: String,
)

data class GrowthLoopChannelBreakdown(
    val channel: String,
    val publishedContentCount: Int,
    val signups: Int,
    val activated: Int,
    val firstPaidConversions: Int,
)

/** Where the daily video is, for the Home card (backend: src/video/todaysVideo.ts). */
enum class TodaysVideoState { NONE, DRAFTING, NEEDS_APPROVAL, RENDERING, READY, POSTED, FAILED }

data class TodaysVideo(
    val state: TodaysVideoState,
    /** The concept's own title, or null when nothing is in play. */
    val title: String?,
    /** Its day in the fixed daily order (1-30). */
    val day: Int?,
    val headline: String,
    val detail: String,
    /** Platforms with a saved post link: "tiktok", "youtube_shorts", "instagram". */
    val platformsPosted: List<String> = emptyList(),
)

data class HomeSummary(
    val signalsAnalyzedToday: Int,
    val opportunitiesFound: Int,
    val assetsReady: Int,
    val pendingReview: Int,
    val systemPaused: Boolean,
    val analytics: AnalyticsBreakdown,
    val todayXPost: TodayXPost = TodayXPost(TodayXPostState.EMPTY, null, null, null, null, null, false),
    val attribution: AttributionSummary = AttributionSummary(0, null),
    /** Null when the server did not send it (an older backend) or could not work it out. */
    val video: TodaysVideo? = null,
)

/**
 * How many real FillbookHQ signups this project's own outreach can be
 * tied to, over the last 7 days -- backed by the conversion_events table
 * the FillbookHQ signup webhook writes to (see backend/src/attribution/).
 * Surfaced on Home so the attribution loop is actually visible instead of
 * a table nobody queries. [topSource] is null when there's simply been no
 * conversion_events activity yet (a genuine "nothing to report" state, not
 * a data gap) -- never fabricated as "none" or "unknown".
 */
data class AttributionSummary(
    val signupsLast7Days: Int,
    val topSource: String?,
)

enum class TodayXPostState { EMPTY, RUNNING, READY, HANDED_OFF, POSTED, FAILED }

/**
 * Never fabricated: EMPTY means no real, still-wanted X feed post exists
 * for today's operating day, full stop -- Home must not invent a
 * placeholder. RUNNING/READY/HANDED_OFF/POSTED/FAILED only ever reflect a
 * genuine x_feed_post_runs + campaign_assets row (see api/summary.ts's
 * computeTodayXPostView). RUNNING means generation is genuinely (or
 * apparently) in flight right now -- distinct from EMPTY (nothing has
 * even started). HANDED_OFF means the owner already opened X with this
 * draft -- never "published." POSTED is a SEPARATE, later, explicit
 * owner confirmation ("Mark posted") that the post actually went out --
 * this app has no way to verify that via the X API, same reasoning as
 * Inbound's "Mark responded." FAILED means a genuine generation attempt
 * ran and didn't produce a passing post -- [reason] carries the real
 * cause, and [canRegenerate] says whether a retry is offered.
 */
data class TodayXPost(
    val state: TodayXPostState,
    val campaignAssetId: String?,
    val previewText: String?,
    val topicLabel: String? = null,
    val reason: String? = null,
    /** Why this angle was selected over the other candidates actually compared for today -- see backend's selectFeedPostAngle. Null for a run created before this field existed, or when not yet generated. */
    val selectionReason: String? = null,
    val canRegenerate: Boolean = false,
)

enum class XFeedPostHistoryState { UNPOSTED_DRAFT, POSTED, FAILED }

/** One prior day's X feed post run, for the Previous drafts / history surface -- never today's own (that's TodayXPost above). */
data class XFeedPostHistoryEntry(
    val operatingDate: String,
    val state: XFeedPostHistoryState,
    val topicLabel: String?,
    val previewText: String?,
    val reason: String?,
    val campaignAssetId: String?,
)

enum class CreatorCategory { TIER_B, RESEARCH_NEXT, REJECTED }

data class Creator(
    val id: String,
    val handle: String,
    val displayName: String?,
    val platform: String,
    val category: CreatorCategory,
    val readinessScore: Int?,
    val followerCount: Int?,
    val creatorProductMoment: String?,
    val notes: String?,
    val rejectionReason: String?,
    val lastInteractionAt: String?,
)

data class CampaignAsset(
    val id: String,
    val platform: String,
    val assetType: String,
    /** Raw stage string from the server -- not every one of the 17 possible
     * CampaignFactory stages has a matching AssetStage case, and this
     * screen shows every campaign regardless of stage, so it's kept as
     * text rather than forced into an enum that would misrepresent
     * unmapped stages. */
    val stage: String,
    val latestBody: String?,
    val reviewPassCount: Int,
    val reviewFailCount: Int,
)

data class Campaign(
    val id: String,
    val thesis: String,
    val status: String,
    val decidedBy: String?,
    val decidedAt: String?,
    val assets: List<CampaignAsset>,
)

data class CostSummary(
    val totalCostUsd: Double,
    val last24hCostUsd: Double,
    val totalCalls: Int,
)

/**
 * Result of manually running one opportunity through POST /api/run-campaign.
 * `finalStage` reaching "ready_for_owner" means it landed in Approvals;
 * anything else means the mechanical gate or deep review blocked it --
 * `blockReasons` is why, not a failure of the request itself.
 */
data class CampaignRunResult(
    val finalStage: String,
    val blockReasons: List<String>,
    val costUsd: Double,
)

enum class InboundPriority { P1_DIRECT_REPLY, P2_RELATIONSHIP, P3_COMMENT, P4_MENTION, LOW_VALUE }

/** Raw status string kept as-is (not every server value maps to something the UI treats specially) rather than an enum that could silently drop an unrecognized future status. */
data class InboundEngagement(
    val id: String,
    val platform: String,
    val authorHandle: String?,
    val body: String,
    val inResponseToText: String?,
    val priority: InboundPriority,
    val status: String,
    val draftResponse: String?,
    val respondedAt: String?,
    val isRepeatEngager: Boolean,
    val creatorHandle: String?,
    val observedAt: String,
    val sourceReference: String?,
)

data class InboundSummary(
    val needsResponse: Int,
    val followUp: Int,
    val repeatEngagers: Int,
    val overdue: Int,
)

/**
 * Someone else's public post found by Prospecting on X -- NOT a person
 * who mentioned/replied to Fillbook (that's InboundEngagement). Raw
 * status string kept as-is, same rationale as InboundEngagement.status:
 * the server owns the state machine.
 */
/**
 * Why today's Prospecting queue looks the way it does -- see
 * backend/src/prospecting/prospectingHandlers.ts's
 * ProspectingSelectionDiagnostics, the server-side source of these same
 * counts. Null (not a zeroed-out instance) when the API response predates
 * this field, so callers can tell "we asked and got nothing" apart from
 * "the server hasn't started sending this yet" -- see
 * ProspectingScreen.kt's emptyStateMessage, which falls back to the
 * original generic copy specifically for that null case.
 */
data class ProspectingDiagnostics(
    val totalConsidered: Int,
    val selected: Int,
    val deferred: Int,
    val belowQualityBar: Int,
    val tooOldForToday: Int,
)

/**
 * Reply pacing from backend/src/prospecting/prospectingPacing.ts (2026-09-25): replies posted in a burst got
 * @FillbookHQ's replies hidden on X, so the app holds the next reply until [nextReplyAtMillis]. Null when the
 * API response predates the field.
 */
data class ProspectingPacing(
    val repliedLast24h: Int,
    val dailyCap: Int,
    val cooldownMinutes: Int,
    /** When the next reply is fine to post (epoch millis), or null if it already is. */
    val nextReplyAtMillis: Long?,
    /** "cooldown" or "daily_cap" while waiting, else null. */
    val reason: String?,
)

/** Return shape for GrowthOsRepository.getProspectingQueue() -- pairs today's selected candidates with the diagnostics explaining why the list looks the way it does (see ProspectingDiagnostics). */
data class ProspectingQueueResult(
    val candidates: List<ProspectingCandidate>,
    val diagnostics: ProspectingDiagnostics?,
    val pacing: ProspectingPacing? = null,
)

/** The result of one Prospecting search run (scheduled or owner-triggered "Search now") -- see backend/src/prospecting/prospectingSearch.ts's ProspectingRunResult. */
data class ProspectingSearchRunResult(
    val skipped: Boolean,
    val skipReason: String?,
    val topicsSearched: List<String>,
    val postsRead: Int,
    val newCandidates: Int,
    val excludedAsSpam: Int,
    val costUsd: Double,
)

data class ProspectingCandidate(
    val id: String,
    /** Lowercase platform key from the server ("x") -- drives which app "Copy + Open" launches and how the confirmation reads. */
    val platform: String,
    val discoveryQuery: String,
    val discoveryLabel: String,
    /** "A" = direct fit, "B" = adjacent fit, "C" = relationship fit (no Fillbook mention required) -- see backend/src/prospecting/prospectingTopics.ts. */
    val replyClass: String,
    val authorHandle: String?,
    val authorFollowerCount: Int?,
    val authorVerified: Boolean?,
    val postText: String,
    val postUrl: String,
    /** ISO timestamp of the original post, when X reported one -- null (not fabricated) when unavailable. */
    val postCreatedAt: String?,
    /** ISO timestamp of when Growth OS itself found this post -- distinct from postCreatedAt. Shown alongside it so a real post-age vs. backlog-age gap (2026-09-07 freshness review) is visible to the owner, not hidden. */
    val discoveredAt: String?,
    val opportunityScore: Double,
    /** Human-readable reasons behind the score, keyed by factor name ("topicRelevance", "activeDiscussion", ...) -- never fabricated, comes straight from the server's own scoring breakdown. */
    val scoreBreakdown: Map<String, String>,
    /** Flagged only by a simple follower-count heuristic server-side -- never auto-added to Creators; a human still decides. */
    val creatorCandidate: Boolean,
    val status: String,
    /** Only present once a draft has actually been generated -- never fabricated client-side. */
    val draftReply: String?,
    val replyMentionsFillbook: Boolean?,
    val replyUsedLink: Boolean?,
)

/** A topic or format worth acting on, with the plain-English reason the server computed it -- never a bare label with no evidence attached. */
data class StrategyItem(val label: String, val reason: String)

/** A rising search topic Growth OS hasn't turned into an opportunity yet. */
data class SeoOpportunity(val topic: String, val velocity: Double, val hasExistingOpportunity: Boolean)

/** A creator relationship that's gone quiet (30+ days) or was never actually contacted, surfaced so it doesn't just decay silently. */
data class CreatorOpportunity(
    val id: String,
    val handle: String,
    val category: String,
    val readinessScore: Int?,
    val daysSinceLastInteraction: Int?,
)

data class ExperimentSuggestion(val hypothesis: String, val rationale: String)

/**
 * One versioned Strategy Evolution report (see backend/src/strategy/types.ts).
 * Built entirely from Growth OS's own data -- real conversion/attribution
 * data from FillbookHQ itself isn't available to this project by design
 * (see docs/ARCHITECTURE.md), so [lowConfidence] exists specifically to
 * flag a report that doesn't yet have enough completed campaigns behind
 * it to mean much -- never hide that caveat from the owner.
 */
data class StrategyVersion(
    val version: Int,
    val generatedAt: String,
    val topicsToIncrease: List<StrategyItem>,
    val topicsToDecrease: List<StrategyItem>,
    val contentToRetire: List<StrategyItem>,
    val formatsToTest: List<StrategyItem>,
    val seoOpportunities: List<SeoOpportunity>,
    val creatorOpportunities: List<CreatorOpportunity>,
    val experimentsToRun: List<ExperimentSuggestion>,
    val summary: String,
    val lowConfidence: Boolean,
)

/**
 * A before/after content-performance test -- NOT a randomized traffic
 * split (there's one X/YouTube/TikTok account, no infrastructure to show
 * different content to different visitors). "Control" is the period
 * before [startDate], "treatment" is [startDate] onward, both measured
 * on the same real metric (see backend/src/experiments/types.ts).
 */
data class Experiment(
    val id: String,
    val hypothesis: String,
    val scopePlatform: String?,
    val scopeAssetType: String?,
    val guardrailNote: String?,
    val status: String,
    val startDate: String,
    val endDate: String?,
    val controlWindowStart: String,
    val createdAt: String,
    val result: ExperimentResult?,
)

data class AppNotification(
    val id: String,
    val type: String,
    val title: String,
    val body: String,
    val severity: String,
    val createdAt: String,
    val readAt: String?,
    val relatedId: String?,
)

data class OpportunitySummary(val id: String, val title: String, val score: Double)

/** Real, computed from the trailing 24h -- see backend/api/summary.ts's handleBrief. Nothing here is fabricated when a field is empty; it just means nothing meaningful happened in that window. */
data class MorningBrief(
    val generatedAt: String,
    val signalsOvernight: Int,
    val topNewOpportunities: List<OpportunitySummary>,
    val pendingApprovals: Int,
    val inboundNeedsResponse: Int,
    val strategySummary: String?,
    val unreadNotificationCount: Int,
)

data class EveningReport(
    val generatedAt: String,
    val assetsDrafted: Int,
    val approvedToday: Int,
    val rejectedToday: Int,
    val reviewPassRate: Double?,
    val costTodayUsd: Double,
    val inboundResolvedToday: Int,
    val topOpportunity: OpportunitySummary?,
)

data class ExperimentResult(
    val controlRate: Double?,
    val treatmentRate: Double?,
    val absoluteDifference: Double?,
    val pValue: Double?,
    val isSignificant: Boolean,
    val insufficientSample: Boolean,
    val controlSampleSize: Int,
    val treatmentSampleSize: Int,
    val interpretation: String,
    val computedAt: String,
)

enum class PartnerCategory { EDUCATOR_COACH, CREATOR_COMMUNITY, PROP_FIRM, PLATFORM_BROKER, OTHER }

enum class PartnershipStage { PROSPECT, QUALIFIED, DRAFT_READY, CONTACTED, REPLIED, PILOT, ACTIVE_PARTNER, CLOSED, ARCHIVED, DO_NOT_CONTACT }

/**
 * A potential Fillbook partner and where things stand with them -- never a
 * cold list of guesses. Every research-derived field (audienceFocus,
 * futuresRelevanceEvidence, sourceUrls, etc.) stays null/empty rather than
 * fabricated when genuinely unknown; the UI must show that plainly, not
 * paper over it. previewText, if present, is the currently-approved
 * pitch's real reviewed text (from campaign_assets/content_versions via
 * approvedCampaignAssetId) -- never invented client-side.
 */
data class PartnershipProspect(
    val id: String,
    val organizationName: String,
    val contactName: String?,
    val partnerCategory: PartnerCategory,
    val stage: PartnershipStage,
    val websiteUrl: String?,
    val socialLinks: Map<String, String>,
    val contactRoute: String?,
    val contactRouteSource: String?,
    val audienceFocus: String?,
    val futuresRelevanceEvidence: String?,
    val sourceUrls: List<String>,
    val researchDate: String?,
    val competingJournalRelationships: String?,
    val competingJournalEvidence: String?,
    val proposedCollaboration: String?,
    val qualificationRationale: String?,
    val ownerNotes: String?,
    val nextAction: String?,
    val nextActionDueDate: String?,
    val pilotTermsProposed: String?,
    val pilotTermsAgreed: String?,
    val pilotStartDate: String?,
    val pilotEndDate: String?,
    val followUpCount: Int,
    val approvedCampaignAssetId: String?,
    val previewText: String?,
    val contactedAt: String?,
    val contactedChannel: String?,
    /** 0-100 ranking score from discoveryScoring.ts -- null for a manually entered prospect. */
    val discoveryScore: Int?,
    val discoveryConfidence: String?,
    /** "manual" for owner-entered prospects; otherwise which automated source found this one. */
    val discoveredVia: String,
    /** Set only by automated backend reassessment when stored evidence no longer shows a concrete partnership basis (an audience/community/business/educational-offering/complementary-product) -- null means not suppressed. Never set by this app, never implies the record was deleted or its stage changed -- see PartnershipsScreen's own suppressed section. */
    val suppressedReason: String? = null,
)

/** The result of one discovery run (scheduled or owner-triggered "Refresh") -- see backend/src/partnerships/discovery.ts's DiscoveryRunResult. */
data class PartnershipDiscoveryRunResult(
    val status: String, // "found" | "no_matches" | "budget_exhausted" | "error" | "skipped_cadence"
    val newCandidates: Int,
    val sourcesSearched: List<String>,
    val costUsd: Double,
    val error: String?,
    val skipReason: String?,
)

/** GET /api/approvals?resource=partnerships' full response -- items plus what the most recent discovery run (scheduled or owner-triggered) actually did, so the UI can distinguish "never run" / "found N" / "no matches" / "budget exhausted" / "errored" without triggering a new run itself. */
data class PartnershipsSummary(
    val items: List<PartnershipProspect>,
    val lastDiscoveryRun: PartnershipDiscoveryRunResult?,
)

/**
 * Raw status string kept as-is (mirrors InboundEngagement.status's own
 * rationale) rather than an enum -- the server owns this state machine
 * (queued -> rendering -> ready|failed|canceled, see migration 0027).
 */
data class VideoRenderStatus(
    val id: String,
    val campaignAssetId: String,
    val status: String,
    /**
     * A short-lived signed URL into the private rendered-videos bucket --
     * present only when [status] is "ready" and the backend's signing call
     * succeeded for THIS particular fetch. Never cached/reused past this
     * screen session: a stale one simply 404s/expires, and the fix is
     * pulling to refresh for a fresh one, never re-deriving a URL
     * client-side (this app never holds Supabase Storage credentials of
     * any kind).
     */
    val downloadUrl: String?,
    /** Same signed-URL contract as [downloadUrl], but for a real video-frame thumbnail (extracted during the Hook caption) the backend generates alongside the video. Null whenever thumbnail generation failed for this render (best-effort, never blocks the render itself) or the render predates this field. */
    val thumbnailDownloadUrl: String?,
    val durationSeconds: Double?,
    val error: String?,
    val createdAt: String,
    val updatedAt: String,
    /**
     * The platform-specific publishing metadata generated alongside the
     * video script ("Create Fillbook Video", 2026-09-08) -- null whenever
     * the underlying draft has no structured videoScript on file (e.g. a
     * render created before this field existed). Never fabricated
     * client-side; always exactly what the backend actually stored.
     */
    val videoMetadata: VideoRenderMetadata? = null,
    /** The real external URL the owner pasted back in after manually posting this video -- null until they do. See setVideoPublishedUrl. */
    val publishedUrl: String? = null,
    /** The daily concept behind this video and its day (1-30), when it came from one. */
    val conceptTitle: String? = null,
    val conceptDay: Int? = null,
)

/** See [VideoRenderStatus.videoMetadata]'s own doc comment. */
data class VideoRenderMetadata(
    val youtubeTitle: String,
    val youtubeDescription: String,
    val tiktokCaption: String,
    /** Null only for a render predating this field (2026-09-18) -- never fabricated. */
    val instagramCaption: String?,
    val hashtags: List<String>,
    /** Null when the video genuinely didn't need one -- never a fabricated filler line. */
    val disclosureCta: String?,
    /** YouTube thumbnail concept: bold text overlay + one-sentence visual description. Null for renders predating this field. */
    val youtubeThumbnailConcept: String?,
    /** The comment to post and pin under the video on TikTok and YouTube (links viewers to the free sample). Null from a server that predates this field. */
    val pinnedComment: String? = null,
)

/**
 * A private, internal research document (Research Lab, 2026-09-07) -- the
 * owner reviews this in full before it informs any public content;
 * nothing here is ever published or shown to anyone else directly. See
 * backend/src/content/researchWriter.ts's ResearchReport, which this
 * mirrors field-for-field.
 *
 * [status] is a raw string kept as-is (same rationale as
 * [VideoRenderStatus.status]) rather than an enum -- the server owns this
 * state machine. "requested"/"researching" are transient CLIENT-SIDE-only
 * states covering the moment between this app's own POST and the next GET
 * reflecting a persisted row -- they are never actually returned by the
 * backend; only ready_for_review/approved/rejected/failed are.
 */
data class ResearchRecord(
    val id: String,
    val title: String,
    val question: String,
    val summary: String,
    val findings: List<String>,
    val evidenceReferences: List<String>,
    val caveats: List<String>,
    val contentAngles: List<String>,
    val status: String,
    val costUsd: Double?,
    val createdAt: String,
)

/**
 * Fillbook Stats: a scoped subset of what GET /api/admin?action=growth on
 * the fillbookhq.com site returns (see handleGrowth in frontend/api/
 * admin.ts, and AdminGrowth.tsx which renders the same response) --
 * deliberately not every field that endpoint has (acquisition-by-source,
 * plan distribution, the intro-offer experiment, etc.), matching this
 * app's own "cap the top-N, don't wall the owner with every number that
 * exists" convention elsewhere (BreakdownChart above). Field names below
 * are copied from that endpoint's actual `metrics`/`funnel` keys, not
 * invented -- see admin.ts's handleGrowth for the source of truth if this
 * ever needs extending.
 */
data class GrowthStats(
    val period: String,
    val visitors: Int,
    val signups: Int,
    val signupStarted: Int,
    val activated: Int,
    val newSubscribers: Int,
    val cancellations: Int,
    /**
     * Ordered stage-to-stage conversion rates as whole percents (0-100),
     * null meaning "not enough data" (admin.ts's own pct() returns null on
     * a zero denominator, never a misleading 0%/NaN) -- rendered literally
     * as "N/A", never coerced to 0.
     */
    val funnel: List<Pair<String, Double?>>,
)

