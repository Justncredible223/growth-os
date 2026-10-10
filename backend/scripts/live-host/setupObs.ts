#!/usr/bin/env node
/**
 * One-time OBS setup for the Live Host:
 *
 *   npm run live-host:setup-obs
 *
 * With OBS open and its WebSocket server enabled, this sets the canvas to 1080 x 1920 at 30 fps, and creates a
 * "Tilt Live" scene holding one Browser Source that shows the worker's stage page with its audio routed through
 * OBS. Safe to run again: anything that already exists is updated, not duplicated.
 *
 * It does not touch the stream service or the stream key. Those are set by the owner in OBS > Settings > Stream.
 */
import { fileURLToPath } from "node:url";
import { ObsClient } from "./obsClient.js";

export const OBS_SCENE_NAME = "Tilt Live";
export const OBS_SOURCE_NAME = "Tilt Stage";
export const STAGE_WIDTH = 1080;
export const STAGE_HEIGHT = 1920;

/** The stage address. Anything but a YouTube-only stream uses the TikTok-safe layout, which is fine on YouTube too. */
export function stageUrl(port: number, platform: string = process.env.LIVE_HOST_PLATFORM ?? ""): string {
  return `http://127.0.0.1:${port}/${platform.toLowerCase() === "youtube" ? "" : "?safe=tiktok"}`;
}

export function stageSourceSettings(port: number, platform?: string): Record<string, unknown> {
  return {
    url: stageUrl(port, platform),
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
    fps: 30,
    // "Control audio via OBS": the stage's voice goes into the stream instead of the PC speakers only.
    reroute_audio: true,
    // Keep the page alive when the scene is not shown, and reload it whenever the scene becomes active, so the
    // stage reconnects to the worker by itself.
    shutdown: false,
    restart_when_active: true,
  };
}

export async function setupObs(obs: ObsClient, port: number, log: (line: string) => void = console.log): Promise<void> {
  await obs.connect();

  await obs.request("SetVideoSettings", {
    baseWidth: STAGE_WIDTH,
    baseHeight: STAGE_HEIGHT,
    outputWidth: STAGE_WIDTH,
    outputHeight: STAGE_HEIGHT,
    fpsNumerator: 30,
    fpsDenominator: 1,
  });
  log(`Canvas set to ${STAGE_WIDTH} x ${STAGE_HEIGHT} at 30 fps`);

  const scenes = ((await obs.request("GetSceneList")).scenes ?? []) as Array<{ sceneName: string }>;
  if (!scenes.some((scene) => scene.sceneName === OBS_SCENE_NAME)) {
    await obs.request("CreateScene", { sceneName: OBS_SCENE_NAME });
    log(`Scene "${OBS_SCENE_NAME}" created`);
  }

  const inputs = ((await obs.request("GetInputList")).inputs ?? []) as Array<{ inputName: string }>;
  if (inputs.some((input) => input.inputName === OBS_SOURCE_NAME)) {
    await obs.request("SetInputSettings", { inputName: OBS_SOURCE_NAME, inputSettings: stageSourceSettings(port), overlay: true });
    log(`Browser Source "${OBS_SOURCE_NAME}" updated`);
  } else {
    await obs.request("CreateInput", { sceneName: OBS_SCENE_NAME, inputName: OBS_SOURCE_NAME, inputKind: "browser_source", inputSettings: stageSourceSettings(port), sceneItemEnabled: true });
    log(`Browser Source "${OBS_SOURCE_NAME}" added to "${OBS_SCENE_NAME}"`);
  }

  // "Monitor and Output": the host's voice goes to the stream AND to this PC's speakers, so the owner hears what
  // viewers hear. Without it the voice is only in the stream and the PC is silent.
  await obs.request("SetInputAudioMonitorType", { inputName: OBS_SOURCE_NAME, monitorType: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT" });
  log("Voice set to play on this PC as well as in the stream");

  await obs.request("SetCurrentProgramScene", { sceneName: OBS_SCENE_NAME });
  log(`"${OBS_SCENE_NAME}" is the active scene. Set the stream service and key in OBS > Settings > Stream.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const obs = new ObsClient(process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455", process.env.OBS_WEBSOCKET_PASSWORD || undefined);
  try {
    await setupObs(obs, Number(process.env.LIVE_HOST_PORT) || 8790);
    obs.close();
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
