import type { VideoMetadata } from "./types.js";

export class TiktokOembedError extends Error {}

const OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";
const ALLOWED_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]);

/** True for an http(s) URL on a TikTok host. Anything else is refused before any request is made. */
export function isTiktokUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Reads a pasted TikTok link through TikTok's public oEmbed endpoint: title, author, thumbnail, and nothing else.
 * This is the ONLY request the engagement assistant ever makes to TikTok. There is no TikTok comment or like API,
 * and TikTok bans bots and scraping, so discovery is the owner pasting links and posting is the owner's own tap.
 */
export async function fetchTiktokOembed(url: string, fetchImpl: typeof fetch = fetch): Promise<VideoMetadata> {
  const cleaned = url.trim();
  if (!isTiktokUrl(cleaned)) throw new TiktokOembedError("That is not a TikTok link.");

  const res = await fetchImpl(`${OEMBED_ENDPOINT}?url=${encodeURIComponent(cleaned)}`, { headers: { Accept: "application/json" }, redirect: "error" });
  if (!res.ok) throw new TiktokOembedError(`TikTok oEmbed could not read that link (HTTP ${res.status}). Is the video public?`);

  const json = (await res.json()) as {
    title?: string;
    author_name?: string;
    author_url?: string;
    author_unique_id?: string;
    thumbnail_url?: string;
    embed_product_id?: string;
  };

  const pathId = /\/video\/(\d+)/.exec(new URL(cleaned).pathname)?.[1];
  const externalId = json.embed_product_id || pathId;
  if (!externalId) throw new TiktokOembedError("TikTok did not return a video id for that link. Paste the full video link.");

  const handleFromUrl = json.author_url ? /\/@([^/?#]+)/.exec(json.author_url)?.[1] : undefined;
  const creatorId = (json.author_unique_id || handleFromUrl || json.author_name || "").trim();
  if (!creatorId) throw new TiktokOembedError("TikTok did not return the creator for that link.");

  return {
    platform: "tiktok",
    externalId,
    url: cleaned,
    title: (json.title ?? "").trim() || "(no caption)",
    creatorId,
    creatorName: (json.author_name ?? creatorId).trim(),
    thumbnailUrl: json.thumbnail_url ?? null,
    description: null,
    stats: null,
  };
}
