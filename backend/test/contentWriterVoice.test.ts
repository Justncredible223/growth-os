import { describe, it, expect, vi } from "vitest";
import { draftContent } from "../src/content/contentWriter";

function fakeClient() {
  const callTool = vi.fn(async () => ({ body: "ok" }));
  return { callTool } as any;
}

describe("draftContent voice rules", () => {
  it("gives a standalone post the team post voice, and no reply-only rules", async () => {
    const client = fakeClient();
    await draftContent(client, "x", { title: "t", rationale: "r" }, "brand", "facts");
    const [system, user] = client.callTool.mock.calls[0];
    expect(system).toContain("FILLBOOK TEAM VOICE FOR PUBLIC POSTS");
    expect(user).not.toContain("HOW REAL TRADERS ACTUALLY REPLY");
  });

  it("gives a reply to an X mention the reply voice rules", async () => {
    const client = fakeClient();
    await draftContent(client, "x", { title: "t", rationale: "r" }, "brand", "facts", { authorHandle: "someone" });
    expect(client.callTool.mock.calls[0][1]).toContain("HOW REAL TRADERS ACTUALLY REPLY");
  });

  it("does not put the reply rules into a private partnership pitch", async () => {
    const client = fakeClient();
    await draftContent(client, "x", { title: "t", rationale: "r" }, "brand", "facts", undefined, {
      recipientOrganization: "Acme", channel: "email", evidenceExcerpts: ["e"], proposedCollaboration: "c",
    });
    expect(client.callTool.mock.calls[0][1]).not.toContain("HOW REAL TRADERS ACTUALLY REPLY");
  });
});

describe("draftContent proper capitalization (owner rule 2026-09-20)", () => {
  const clientReturning = (...bodies: string[]) => {
    const callTool = vi.fn(async () => ({ body: bodies[Math.min(callTool.mock.calls.length - 1, bodies.length - 1)]! }));
    return { callTool } as any;
  };
  const opportunity = { title: "t", rationale: "r" };

  it("makes one call when the draft is properly capitalized", async () => {
    const client = clientReturning("Trailing drawdown locks once you're up 2k.");
    const text = await draftContent(client, "x", opportunity, "brand", "facts");
    expect(text).toBe("Trailing drawdown locks once you're up 2k.");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("rewrites a lowercase draft once, naming the problem, and returns the fixed version", async () => {
    const client = clientReturning("fees are the silent killer. every spread counts.", "Fees are the silent killer. Every spread counts.");
    const text = await draftContent(client, "x", opportunity, "brand", "facts");

    expect(text).toBe("Fees are the silent killer. Every spread counts.");
    expect(client.callTool).toHaveBeenCalledTimes(2);
    const retryUser = client.callTool.mock.calls[1][1] as string;
    expect(retryUser).toContain("starts with a lowercase letter");
    expect(retryUser).toContain("fees are the silent killer");
  });

  it("never blocks the post: a second lowercase draft is still returned after the one rewrite", async () => {
    const client = clientReturning("still lowercase here.", "still lowercase here too.");
    const text = await draftContent(client, "x", opportunity, "brand", "facts");
    expect(text).toBe("still lowercase here too.");
    expect(client.callTool).toHaveBeenCalledTimes(2);
  });
});

describe("draftContent first-two-lines rule (owner question 2026-10-25)", () => {
  it("tells the writer the first two lines must stand alone, with the hook and the specific, because the timeline cuts a post", async () => {
    const client = fakeClient();
    await draftContent(client, "x", { title: "t", rationale: "r" }, "brand", "facts");
    const [system] = client.callTool.mock.calls[0];
    expect(system).toContain("The first two lines of an X post must stand on their own");
    expect(system).toContain("Show more");
    expect(system).toContain("the hook AND the one specific");
    expect(system).toContain("the Fillbook line, must be optional");
    // The existing layout and length rules stay.
    expect(system).toContain("separated by one blank line");
    expect(system).toContain("under 280 characters");
  });
});

