import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services")
}

/**
 * Release signing: the keystore and its passwords are owner-controlled and
 * NEVER live in this repo. Two ways to supply them, checked in this order:
 *
 * 1. `android/keystore.properties` (gitignored, see .gitignore) -- a local
 *    file with `storeFile`/`storePassword`/`keyAlias`/`keyPassword` keys.
 *    Simplest for a developer machine building releases by hand.
 * 2. Environment variables `GROWTH_OS_KEYSTORE_PATH` /
 *    `GROWTH_OS_KEYSTORE_PASSWORD` / `GROWTH_OS_KEY_ALIAS` /
 *    `GROWTH_OS_KEY_PASSWORD` -- for CI or any environment where dropping a
 *    properties file isn't convenient.
 *
 * If neither source provides all four values, the `release` signingConfig
 * below is left incomplete on purpose. That is NOT a silent no-op: AGP's own
 * `validateSigningRelease` task refuses to assemble/bundle a release build
 * with an incomplete signing config and fails with a clear error naming the
 * missing field -- there is deliberately no fallback that would let an
 * unsigned or debug-signed APK pass as "release" output. `assembleDebug` is
 * completely unaffected either way; the debug build type keeps using AGP's
 * own auto-managed debug keystore, which never touches any of this.
 */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

fun signingValue(propertyKey: String, envVarName: String): String? =
    keystoreProperties.getProperty(propertyKey) ?: System.getenv(envVarName)

val releaseStoreFilePath = signingValue("storeFile", "GROWTH_OS_KEYSTORE_PATH")
val releaseStorePassword = signingValue("storePassword", "GROWTH_OS_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "GROWTH_OS_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "GROWTH_OS_KEY_PASSWORD")

/**
 * Backend auth credentials (production-readiness audit finding, 2026-09-07):
 * these used to be plaintext `const val`s committed straight into
 * AppConfig.kt, and were ALSO duplicated in two tracked handoff docs --
 * three copies of live production secrets sitting in git history. Moved to
 * the exact same "gitignored local file, env var fallback" mechanism this
 * file already uses for release signing above, just reading
 * `android/local.properties` (already gitignored, already exists on every
 * dev machine for `sdk.dir`) instead of a separate properties file --
 * one fewer file for a developer to remember to create.
 *
 * Two keys, checked in this order:
 * 1. `android/local.properties`'s `growthOsProtectionBypassSecret` /
 *    `growthOsAppToken` entries -- simplest for a developer machine.
 * 2. Environment variables `GROWTH_OS_PROTECTION_BYPASS_SECRET` /
 *    `GROWTH_OS_APP_TOKEN` -- for CI or scripted builds.
 *
 * Deliberately falls back to an EMPTY string (never fails the build) when
 * neither source provides a value -- unlike release signing, a debug build
 * with no configured token is a legitimate, common case (typechecking/
 * compiling this module, or CI verifying the app still builds, needs
 * neither secret and must never require them just to succeed). An empty
 * token simply means the resulting APK gets a 401 from every backend call
 * until a real value is supplied and the app is rebuilt -- a loud, obvious
 * runtime failure, never a silent wrong-behavior one.
 */
val localPropertiesFile = rootProject.file("local.properties")
val localProperties = Properties().apply {
    if (localPropertiesFile.exists()) {
        FileInputStream(localPropertiesFile).use { load(it) }
    }
}

fun secretValue(propertyKey: String, envVarName: String): String =
    localProperties.getProperty(propertyKey) ?: System.getenv(envVarName) ?: ""

val protectionBypassSecret = secretValue("growthOsProtectionBypassSecret", "GROWTH_OS_PROTECTION_BYPASS_SECRET")
val appToken = secretValue("growthOsAppToken", "GROWTH_OS_APP_TOKEN")

android {
    namespace = "com.fillbook.growthos"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fillbook.growthos"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.2.1"

        // See secretValue() above -- injected here so BuildConfig carries
        // them as plain compile-time String constants, same as every other
        // buildConfigField. AppConfig.kt reads these; no other file should.
        buildConfigField("String", "PROTECTION_BYPASS_SECRET", "\"$protectionBypassSecret\"")
        buildConfigField("String", "APP_TOKEN", "\"$appToken\"")
    }

    signingConfigs {
        create("release") {
            // Deliberately assigned even when values are null/missing --
            // see the kdoc above for why an incomplete config here is the
            // point, not a bug.
            releaseStoreFilePath?.let { storeFile = file(it) }
            releaseStorePassword?.let { storePassword = it }
            releaseKeyAlias?.let { keyAlias = it }
            releaseKeyPassword?.let { keyPassword = it }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    // Fold/hinge detection (FoldingFeature) for the two-pane layout on the Galaxy Z Fold inner screen.
    implementation("androidx.window:window:1.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.biometric:biometric:1.1.0")
    // Forces a modern androidx.fragment resolution (transitively pulled in
    // at 1.2.5 by biometric:1.1.0/activity-compose otherwise) -- 1.2.5
    // predates the 1.3.6 fix that made FragmentActivity's own permission-
    // request-code validation tolerate the larger codes the Activity Result
    // API's rememberLauncherForActivityResult generates. Without this,
    // FragmentActivity.validateRequestPermissionsRequestCode throws
    // "Can only use lower 16 bits for requestCode" the first time any
    // ActivityResultContracts.RequestPermission() launcher is used on this
    // FragmentActivity (required here for BiometricPrompt) -- confirmed via
    // a real on-device crash log, not a hypothetical.
    implementation("androidx.fragment:fragment-ktx:1.8.5")

    val firebaseBom = platform("com.google.firebase:firebase-bom:34.17.0")
    implementation(firebaseBom)
    implementation("com.google.firebase:firebase-messaging")
    // Gives Task<T>.await() -- used once, to register this device's FCM
    // token from a plain suspend function (MainActivity's startup
    // registration) instead of a callback listener.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")

    debugImplementation("androidx.compose.ui:ui-tooling")

    // Plain JVM unit tests (app/src/test) for the pure-Kotlin logic the
    // screens render from -- platform wording, filter reconciliation,
    // experiment list merging. No emulator or instrumentation needed:
    // `./gradlew :app:testDebugUnitTest`.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    // The android.jar used for plain JVM unit tests stubs every method on
    // platform classes (including org.json.JSONObject) to throw
    // "RuntimeException: Stub!" -- see NetworkGrowthOsRepository.kt's own
    // comment on why extractPartnershipActionErrorMessage avoids JSONObject
    // entirely for this reason. This pulls in the real upstream org.json
    // reference implementation instead, which the JVM unit test classpath
    // resolves ahead of the stub -- the standard fix for this well-known
    // Android/JVM-unit-test limitation, without pulling in Robolectric just
    // to construct a JSONObject. Test-only; never ships in the APK.
    testImplementation("org.json:json:20231013")
}
