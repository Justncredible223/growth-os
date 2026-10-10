import { describe, it, expect, vi } from "vitest";
import {
  authorize,
  authorizeLiveHostSpeech,
  authorizeLiveHostSpeechAndAudit,
  ExternalWriteRejectedError,
  KNOWN_EXTERNAL_WRITE_ACTIONS,
  LIVE_HOST_SPEAK_ACTION,
  LiveHostSpeechRejectedError,
  type LiveHostSpeechGrant,
} from "../src/firewall/externalWriteFirewall";

// The one owner-approved exception to the External Write Firewall (2026-10-09, see the "Live Host exception"
// section of docs/EXTERNAL_WRITE_FIREWALL.md). This file is its contract: what it allows, and that it loosens
// nothing else. firewall.test.ts is unchanged and still passes as written.
describe("ExternalWriteFirewall Live Host exception", () => {
  const grant: LiveHostSpeechGrant = {
    ownerSwitchedOn: true,
    systemPaused: false,
    sessionId: "session-1",
    guardrailProblem: null,
    text: "Welcome in. Ask me anything about prop firm rules.",
  };

  it("allows one spoken line when the owner switched the host on and the line passed guardrails", () => {
    const action = authorizeLiveHostSpeech(grant);
    expect(action.name).toBe(LIVE_HOST_SPEAK_ACTION);
    expect(action.actionClass).toBe("LIVE_HOST_SPEECH");
  });

  it("rejects when any one condition is missing", () => {
    const broken: Partial<LiveHostSpeechGrant>[] = [
      { ownerSwitchedOn: false },
      { systemPaused: true },
      { sessionId: null },
      { guardrailProblem: "makes a guarantee, which is never verifiable" },
      { text: "   " },
    ];
    for (const change of broken) {
      expect(() => authorizeLiveHostSpeech({ ...grant, ...change })).toThrow(LiveHostSpeechRejectedError);
    }
  });

  it("cannot be reached through authorize() by declaring the class", () => {
    expect(() => authorize({ name: LIVE_HOST_SPEAK_ACTION, actionClass: "LIVE_HOST_SPEECH" })).toThrow(ExternalWriteRejectedError);
    expect(() => authorize({ name: "tiktok.comment", actionClass: "LIVE_HOST_SPEECH" })).toThrow(ExternalWriteRejectedError);
  });

  it("leaves every known EXTERNAL_WRITE action rejected, chat replies and comments included", () => {
    for (const name of KNOWN_EXTERNAL_WRITE_ACTIONS) {
      expect(() => authorize({ name, actionClass: "EXTERNAL_WRITE" })).toThrow(ExternalWriteRejectedError);
    }
    expect(KNOWN_EXTERNAL_WRITE_ACTIONS).toContain("tiktok.comment");
    expect(KNOWN_EXTERNAL_WRITE_ACTIONS).toContain("youtube.post_comment");
  });

  it("audits allowed and rejected lines", async () => {
    const auditSink = vi.fn();
    await authorizeLiveHostSpeechAndAudit(grant, auditSink);
    await expect(authorizeLiveHostSpeechAndAudit({ ...grant, ownerSwitchedOn: false }, auditSink)).rejects.toThrow(LiveHostSpeechRejectedError);
    expect(auditSink).toHaveBeenCalledTimes(2);
    expect(auditSink.mock.calls[0]![0].outcome).toBe("allowed");
    expect(auditSink.mock.calls[1]![0].outcome).toBe("rejected");
    expect(auditSink.mock.calls[1]![0].actionClass).toBe("LIVE_HOST_SPEECH");
  });
});
