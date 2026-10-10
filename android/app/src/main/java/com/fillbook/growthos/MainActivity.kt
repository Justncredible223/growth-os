package com.fillbook.growthos

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Handshake
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Nightlight
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material.icons.filled.QueryStats
import androidx.compose.material.icons.filled.WbSunny
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ShowChart
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.fillbook.growthos.data.CrashReporter
import com.fillbook.growthos.data.FillbookAuthEvents
import kotlinx.coroutines.launch
import com.fillbook.growthos.data.NetworkGrowthOsRepository
import com.fillbook.growthos.ui.screens.AnalyticsScreen
import com.fillbook.growthos.ui.screens.FillbookStatsScreen
import com.fillbook.growthos.ui.screens.ApprovalsScreen
import com.fillbook.growthos.ui.screens.BiometricGateScreen
import com.fillbook.growthos.ui.screens.canUseDeviceLock
import com.fillbook.growthos.ui.screens.CampaignsScreen
import com.fillbook.growthos.ui.screens.ContentLibraryScreen
import com.fillbook.growthos.ui.screens.CreatorsScreen
import com.fillbook.growthos.ui.screens.HomeScreen
import com.fillbook.growthos.ui.screens.InboundScreen
import com.fillbook.growthos.ui.screens.LiveHostScreen
import com.fillbook.growthos.ui.screens.ProspectingScreen
import com.fillbook.growthos.ui.screens.RadarScreen
import com.fillbook.growthos.ui.screens.ResearchScreen
import com.fillbook.growthos.ui.screens.SettingsScreen
import com.fillbook.growthos.ui.screens.StrategyScreen
import com.fillbook.growthos.ui.screens.ExperimentsScreen
import com.fillbook.growthos.ui.screens.NotificationsScreen
import com.fillbook.growthos.ui.screens.MorningBriefScreen
import com.fillbook.growthos.ui.screens.EveningReportScreen
import com.fillbook.growthos.ui.screens.PartnershipsScreen
import com.fillbook.growthos.ui.screens.SystemScreen
import com.fillbook.growthos.ui.screens.XFeedPostHistoryScreen
import com.fillbook.growthos.ui.screens.ResultsScreen
import com.fillbook.growthos.ui.screens.VideoStatusScreen
import com.fillbook.growthos.data.AppConfig
import com.fillbook.growthos.data.PostingReminders
import com.fillbook.growthos.data.VideoNotifications
import kotlinx.coroutines.tasks.await
import com.fillbook.growthos.ui.theme.Accent
import com.fillbook.growthos.ui.theme.Background
import com.fillbook.growthos.ui.theme.Border
import com.fillbook.growthos.ui.theme.FillbookGrowthOSTheme
import com.fillbook.growthos.ui.theme.Surface as SurfaceColor
import com.fillbook.growthos.ui.theme.SurfaceElevated
import com.fillbook.growthos.ui.theme.TextPrimary
import com.fillbook.growthos.ui.theme.TextSecondary
import com.fillbook.growthos.ui.theme.TextTertiary

private sealed class Destination(val route: String, val label: String, val icon: ImageVector) {
    data object Home : Destination("home", "Home", Icons.Filled.Home)
    data object Radar : Destination("radar", "Radar", Icons.Filled.Radar)
    data object Prospecting : Destination("prospecting", "Prospecting", Icons.Filled.TrendingUp)
    data object Approvals : Destination("approvals", "Approvals", Icons.Filled.CheckCircle)
    data object Inbound : Destination("inbound", "Inbound", Icons.Filled.Forum)
    data object Campaigns : Destination("campaigns", "Campaigns", Icons.Filled.Campaign)
    data object Analytics : Destination("analytics", "Analytics", Icons.Filled.Insights)
    data object ContentLibrary : Destination("content_library", "Content Library", Icons.Filled.VideoLibrary)
    data object Research : Destination("research", "Research", Icons.Filled.Science)
    data object Creators : Destination("creators", "Creators", Icons.Filled.Groups)
    data object Strategy : Destination("strategy", "Strategy", Icons.Filled.Timeline)
    data object Experiments : Destination("experiments", "Experiments", Icons.Filled.QueryStats)
    data object Notifications : Destination("notifications", "Notifications", Icons.Filled.NotificationsNone)
    data object MorningBrief : Destination("morning_brief", "Morning Brief", Icons.Filled.WbSunny)
    data object EveningReport : Destination("evening_report", "Evening Report", Icons.Filled.Nightlight)
    data object System : Destination("system", "System", Icons.Filled.Dns)
    data object Settings : Destination("settings", "Settings", Icons.Filled.Settings)
    data object XFeedPostHistory : Destination("x_feed_post_history", "Previous X Drafts", Icons.Filled.History)
    data object Partnerships : Destination("partnerships", "Partnerships", Icons.Filled.Handshake)
    data object VideoStatus : Destination("video_status", "Video Status", Icons.Filled.Movie)
    data object FillbookStats : Destination("fillbook_stats", "Fillbook Stats", Icons.Filled.ShowChart)
    data object Results : Destination("results", "Results", Icons.Filled.QueryStats)
    data object LiveHost : Destination("live_host", "Live Host", Icons.Filled.Podcasts)
}

/**
 * The 6 screens worth a permanent thumb-reach slot -- everything else
 * lives in More. Prospecting replaced Analytics here: for a new product
 * with no inbound traffic yet, proactive daily outreach is the primary
 * growth system, not a periodic check (see docs/PROSPECTING.md) --
 * Analytics is still one tap away in More, just no longer competing for
 * the habitual daily slot. Inbound later replaced Approvals for the same
 * reason: real engagement replies are now a daily habit, while Approvals
 * was a periodic review that didn't need a permanent slot.
 *
 * Approvals later swapped back in for Partnerships (2026-09-09): approving
 * drafts is now the more frequent daily action of the two, so Partnerships
 * moved to More instead -- still one tap away, just no longer competing
 * for the habitual slot.
 *
 * VideoStatus joined as a 6th slot (2026-09-22): checking on a render,
 * downloading it, and sharing/drafting it out is now a routine daily loop
 * of its own, not an occasional check -- worth the permanent slot instead
 * of a trip through More every time.
 */
private val primaryDestinations =
    listOf(Destination.Home, Destination.Radar, Destination.Prospecting, Destination.Inbound, Destination.Approvals, Destination.VideoStatus)

/** Secondary screens: real but lower-frequency, reached via the More sheet instead of eating a nav slot. */
private val moreDestinations = listOf(
    Destination.Results,
    Destination.LiveHost,
    Destination.Partnerships,
    Destination.Analytics,
    Destination.Campaigns,
    Destination.ContentLibrary,
    Destination.Creators,
    Destination.System,
    Destination.Settings,
    Destination.Research,
    Destination.Strategy,
    Destination.Experiments,
    Destination.Notifications,
    Destination.MorningBrief,
    Destination.EveningReport,
    Destination.XFeedPostHistory,
    Destination.FillbookStats,
)

private val allDestinations = primaryDestinations + moreDestinations

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        CrashReporter.install(this, AppConfig.BASE_URL, AppConfig.PROTECTION_BYPASS_SECRET, AppConfig.APP_TOKEN)
        VideoNotifications.createChannel(this)
        PostingReminders.createChannel(this)
        PostingReminders.scheduleNext(this)
        // The deep-link route (if this activity was launched by tapping a
        // video-render push notification) is read once here and threaded
        // down through GrowthOsRoot/GrowthOsApp as initial nav state --
        // onNewIntent (below) updates the same holder for the
        // already-running-process case, since a singleTop/singleTask
        // launch never re-runs onCreate.
        pendingDeepLinkRoute.value = intent?.let { VideoNotifications.deepLinkRouteFor(it) }
        // Only on a fresh launch: a recreated activity still carries the old intent, and an OAuth code is single-use.
        if (savedInstanceState == null) intent?.let { handleOAuthCallback(it) }
        setContent {
            FillbookGrowthOSTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    GrowthOsRoot(this, pendingDeepLinkRoute)
                }
            }
        }
    }

    /** Fires instead of a fresh onCreate when the app is already running and a new notification tap arrives (default launchMode is already effectively singleTop for a single-Activity app's back stack root). */
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingDeepLinkRoute.value = VideoNotifications.deepLinkRouteFor(intent)
        handleOAuthCallback(intent)
    }

    private fun handleOAuthCallback(intent: android.content.Intent) {
        if (intent.action != AuthCallbackActivity.ACTION_OAUTH_CALLBACK) return
        val data = intent.data
        setIntent(android.content.Intent(this, MainActivity::class.java))
        pendingDeepLinkRoute.value = "fillbook_stats"
        val code = data?.getQueryParameter("code")
        if (code == null) {
            val reason = data?.getQueryParameter("error_description") ?: data?.getQueryParameter("error") ?: "no sign-in code was returned"
            FillbookAuthEvents.publish(false, "Google sign-in failed: $reason.")
            return
        }
        lifecycleScope.launch {
            try {
                AppConfig.buildSupabaseAuthClient(this@MainActivity).completeOAuthSignIn(code)
                FillbookAuthEvents.publish(true, null)
            } catch (e: Exception) {
                FillbookAuthEvents.publish(false, e.message ?: "Google sign-in failed.")
            }
        }
    }

    private val pendingDeepLinkRoute = mutableStateOf<String?>(null)
}

@Composable
private fun GrowthOsRoot(activity: FragmentActivity, pendingDeepLinkRoute: androidx.compose.runtime.MutableState<String?>) {
    // Re-checked once per process, not per recomposition. If the device
    // has no lock screen configured at all, there's nothing to gate on --
    // skip straight into the app rather than blocking access with a
    // check that structurally can't work.
    val deviceLockAvailable = remember { canUseDeviceLock(activity) }
    var unlocked by remember { mutableStateOf(!deviceLockAvailable) }

    if (!unlocked) {
        BiometricGateScreen(activity = activity, onUnlocked = { unlocked = true })
    } else {
        val repo = remember { AppConfig.buildRepository() }
        val fillbookAdminRepo = remember { AppConfig.buildFillbookAdminRepository(activity) }

        // POST_NOTIFICATIONS is a runtime permission on API 33+; below
        // that, notifications are granted at install time and this launcher
        // is simply never invoked. Requested once per process, right after
        // unlock -- not before, so the very first thing after the
        // biometric gate isn't yet another system dialog. A denial isn't
        // re-prompted here; the owner can still grant it later from system
        // Settings, and the rest of the app works identically either way
        // (the render pipeline itself needs no permission -- only the push
        // notification about it does).
        val notificationPermissionLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
            androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
        ) { /* no-op either way -- see comment above */ }
        LaunchedEffect(Unit) {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                val granted = androidx.core.content.ContextCompat.checkSelfPermission(activity, android.Manifest.permission.POST_NOTIFICATIONS) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                if (!granted) notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
            // Registers this device's current FCM token once per process
            // start -- covers both "token already existed before this
            // launch" (onNewToken in FillbookMessagingService only fires
            // for a NEW/rotated token, not an existing valid one) and a
            // fresh install. A failure here (offline, token not yet
            // available) is silent and non-fatal -- the token naturally
            // gets registered on the next successful launch or the next
            // real onNewToken callback, and it never blocks any other part
            // of the app from working.
            runCatching {
                val token = com.google.firebase.messaging.FirebaseMessaging.getInstance().token.await()
                repo.registerDeviceToken(token)
            }
        }

        GrowthOsApp(repo = repo, fillbookAdminRepo = fillbookAdminRepo, pendingDeepLinkRoute = pendingDeepLinkRoute)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GrowthOsApp(
    repo: com.fillbook.growthos.data.GrowthOsRepository,
    fillbookAdminRepo: com.fillbook.growthos.data.FillbookAdminRepository,
    pendingDeepLinkRoute: androidx.compose.runtime.MutableState<String?>,
) {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination
    var showMore by remember { mutableStateOf(false) }

    fun navigate(route: String) {
        navController.navigate(route) {
            popUpTo(navController.graph.startDestinationId) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    // Consumes a notification-tap deep link exactly once -- read then
    // immediately cleared, so rotating the device or any later
    // recomposition never re-navigates on its own.
    LaunchedEffect(pendingDeepLinkRoute.value) {
        pendingDeepLinkRoute.value?.let { route ->
            navigate(route)
            pendingDeepLinkRoute.value = null
        }
    }

    Scaffold(
        bottomBar = {
            val onMoreScreen = moreDestinations.any { d -> currentDestination?.hierarchy?.any { it.route == d.route } == true }
            GrowthBottomNav(
                items = primaryDestinations,
                currentDestination = currentDestination,
                onMoreScreen = onMoreScreen,
                onSelect = ::navigate,
                onMore = { showMore = true },
            )
        },
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Destination.Home.route,
            modifier = Modifier.padding(innerPadding),
        ) {
            composable(Destination.Home.route) { HomeScreen(repo, onNavigate = ::navigate) }
            composable(Destination.Radar.route) { RadarScreen(repo) }
            composable(Destination.Prospecting.route) { ProspectingScreen(repo) }
            composable(Destination.Approvals.route) { ApprovalsScreen(repo) }
            composable(Destination.Inbound.route) { InboundScreen(repo) }
            composable(Destination.Campaigns.route) { CampaignsScreen(repo) }
            composable(Destination.Analytics.route) { AnalyticsScreen(repo) }
            composable(Destination.ContentLibrary.route) { ContentLibraryScreen(repo) }
            composable(Destination.Research.route) { ResearchScreen(repo, onNavigateToApprovals = { navigate(Destination.Approvals.route) }) }
            composable(Destination.Creators.route) { CreatorsScreen(repo) }
            composable(Destination.Strategy.route) { StrategyScreen(repo) }
            composable(Destination.Experiments.route) { ExperimentsScreen(repo) }
            composable(Destination.Notifications.route) { NotificationsScreen(repo, onNavigate = ::navigate) }
            composable(Destination.MorningBrief.route) { MorningBriefScreen(repo, onNavigate = ::navigate) }
            composable(Destination.EveningReport.route) { EveningReportScreen(repo, onNavigate = ::navigate) }
            composable(Destination.System.route) { SystemScreen(repo) }
            composable(Destination.Settings.route) { SettingsScreen(repo) }
            composable(Destination.XFeedPostHistory.route) { XFeedPostHistoryScreen(repo) }
            composable(Destination.Partnerships.route) { PartnershipsScreen(repo) }
            composable(Destination.VideoStatus.route) { VideoStatusScreen(repo) }
            composable(Destination.FillbookStats.route) { FillbookStatsScreen(fillbookAdminRepo) }
            composable(Destination.Results.route) { ResultsScreen(repo) }
            composable(Destination.LiveHost.route) { LiveHostScreen(repo) }
        }
    }

    if (showMore) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { showMore = false },
            sheetState = sheetState,
            containerColor = SurfaceColor,
        ) {
            MoreSheetContent(
                currentDestination = currentDestination,
                onSelect = { route -> showMore = false; navigate(route) },
            )
        }
    }
}

/**
 * A custom bottom nav rather than stock Material NavigationBar -- the
 * selected item gets a soft cyan pill behind its icon instead of the
 * default ripple-circle indicator, and the bar itself sits on an
 * elevated surface with a top hairline rather than Material's default
 * tonal surface, so it reads as this product's own chrome rather than a
 * generic Android nav bar.
 */
@Composable
private fun GrowthBottomNav(
    items: List<Destination>,
    currentDestination: androidx.navigation.NavDestination?,
    onMoreScreen: Boolean,
    onSelect: (String) -> Unit,
    onMore: () -> Unit,
) {
    Column {
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Border))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(SurfaceElevated)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(horizontal = 4.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            items.forEach { destination ->
                val selected = currentDestination?.hierarchy?.any { it.route == destination.route } == true
                NavItem(destination.icon, destination.label, selected, Modifier.weight(1f)) { onSelect(destination.route) }
            }
            NavItem(Icons.Filled.MoreHoriz, "More", onMoreScreen, Modifier.weight(1f), onMore)
        }
    }
}

/**
 * Every semantic a11y needs is set explicitly rather than relying on
 * incidental merging: `role = Tab` + `selected` so TalkBack announces
 * "Home, tab, selected", `mergeDescendants` so the label text (not a
 * duplicate icon description) becomes the one accessible name, and the
 * icon itself goes decorative (contentDescription = null) since its
 * meaning is now carried by the merged label. `heightIn(min = 48.dp)`
 * guarantees a real touch target even though the visual chrome (icon +
 * small label) is shorter than that on its own.
 */
@Composable
private fun NavItem(icon: ImageVector, label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val color = if (selected) Accent else TextTertiary
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .heightIn(min = 48.dp)
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) {
                this.role = Role.Tab
                this.selected = selected
                contentDescription = label
            }
            .padding(horizontal = 2.dp),
    ) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(14.dp))
                .background(if (selected) Accent.copy(alpha = 0.16f) else androidx.compose.ui.graphics.Color.Transparent)
                .padding(horizontal = 14.dp, vertical = 6.dp),
        ) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.height(3.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, lineHeight = 12.sp),
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            softWrap = false,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * Editorial list rather than an icon grid -- a row per destination (icon
 * in a soft circle, label, chevron) reads as a real menu, not a launcher
 * page. Kept as one flat list in the same order the product already
 * settled on (workflow screens first, System/Settings, Research/Strategy
 * last as the not-yet-built modules) rather than inventing new groupings.
 */
@Composable
private fun MoreSheetContent(currentDestination: androidx.navigation.NavDestination?, onSelect: (String) -> Unit) {
    Column(modifier = Modifier.padding(bottom = 12.dp)) {
        Text(
            "More",
            style = MaterialTheme.typography.headlineMedium,
            color = TextPrimary,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
        )
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
            moreDestinations.forEach { destination ->
                val selected = currentDestination?.hierarchy?.any { it.route == destination.route } == true
                MoreRow(destination.label, destination.icon, selected) { onSelect(destination.route) }
            }
        }
    }
}

@Composable
private fun MoreRow(label: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(if (selected) Accent.copy(alpha = 0.16f) else Background),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = if (selected) Accent else TextSecondary, modifier = Modifier.size(19.dp))
        }
        Spacer(Modifier.width(14.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = TextPrimary, modifier = Modifier.weight(1f))
        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = TextTertiary, modifier = Modifier.size(18.dp))
    }
}
