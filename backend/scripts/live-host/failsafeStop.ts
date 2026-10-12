/** Independent fail-safe: stops the OBS stream (and recording) whether or not the worker is alive. Run after a delay. */
import { ObsClient } from "./obsClient.js";
const obs = new ObsClient(process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455", process.env.OBS_WEBSOCKET_PASSWORD || undefined, console.log);
try {
  await obs.connect();
  await obs.stopRecording().catch(() => {});
  await obs.stopStream();
  console.log("failsafe: stream stopped");
} catch (err) {
  console.log(`failsafe: could not stop OBS (${err instanceof Error ? err.message : String(err)})`);
} finally {
  obs.close();
}
