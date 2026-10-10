# Fillbook Growth OS — Android Mission Control

Kotlin + Jetpack Compose, native (not Capacitor/hybrid).

## Build

```bash
export JAVA_HOME=/path/to/a/JDK-17-to-21   # Gradle 8.14.3 does not yet support JDK 25
cd android
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

On this development machine, JDK 25 (Android Studio's bundled JBR) is
**not** compatible with Gradle 8.14.3 — use the JetBrains Runtime 21 at
`C:\Users\<you>\.jdks\jbr-21.0.11` instead (already present if Android
Studio installed a second JBR for a project targeting an older Gradle).

## Current state (Phase 7, right-sized core)

Three real screens, wired to a `GrowthOsRepository` interface:
- **Home** — engine health per integration, today's stats.
- **Radar** — open opportunities with score, urgency, rationale, and
  recommended channels. No "post" action anywhere on this screen.
- **Approvals** — drafts ready for review. Buttons are strictly
  "Approve internally" and "Open in `<platform>`" — there is no button on
  this screen, and no code path in this app, that publishes anything. See
  `docs/EXTERNAL_WRITE_FIREWALL.md`.

`NetworkGrowthOsRepository` is the implementation behind that interface;
no screen code depends on a concrete repository.

## Known gaps, honestly

- **No emulator/device visual QA performed.** This dev machine has the
  Android SDK's `platform-tools`/`build-tools`/`emulator` binary
  installed, but no system image and no `cmdline-tools`/`sdkmanager` to
  fetch one — installing one is a multi-GB download plus enabling
  hardware acceleration, not attempted unattended. Install a system image
  via Android Studio's own SDK Manager (Tools -> SDK Manager -> SDK
  Platforms/SDK Tools) to run this on an emulator, or `adb install
  app-debug.apk` to a physical device connected over USB with developer
  mode + USB debugging enabled.
- **Only 3 of the 12 spec screens exist** (Home, Radar, Approvals) —
  Campaigns, Analytics, Content Library, Research, Creators, Strategy,
  System, Settings are not built. This matches the "right-sized core
  first" sequencing decision, not an oversight.
- **No dark/light theme toggle wired to a real setting** — currently
  follows system theme only; a light palette exists but is unpolished
  relative to the dark-first design.
- **No haptics, no custom transitions** yet beyond Compose Navigation's
  defaults.
