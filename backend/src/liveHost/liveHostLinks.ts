/**
 * Tracked links for the stream. The site (frontend/src/lib/campaignLinks.ts and analytics.ts in the Fillbook repo)
 * already buckets utm_source=youtube and expects slug-safe campaign names (lowercase letters, digits, hyphens) and the
 * medium names in its CAMPAIGN_MEDIUMS, so these follow that convention. This is the one deliberate difference from a
 * bare "utm_medium=live / utm_campaign=fillbook_live": underscores are not slug-safe on the site, and "live" is not a
 * medium its link tooling knows.
 */
export const CANONICAL_SITE = "https://www.fillbookhq.com/";

export type LinkPlacement = "live" | "description" | "pinned-comment" | "short";

const MEDIUM: Record<LinkPlacement, string> = {
  live: "video",
  description: "description",
  "pinned-comment": "comment",
  short: "video",
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface TrackedLinkInput {
  placement: LinkPlacement;
  /** Episode label such as a date ("2026-10-12") or a number. Slugified. */
  episode?: string;
  /** Destination path on the site, such as "/pricing". Defaults to the home page. Must be a relative path. */
  path?: string;
}

export function buildTrackedUrl(input: TrackedLinkInput): string {
  const path = input.path ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\s<>"']/.test(path)) throw new Error(`Not a safe site path: ${path}`);
  const episode = slugify(input.episode ?? "");
  const campaign = episode ? `fillbook-live-${episode}` : "fillbook-live";
  if (!SLUG.test(campaign)) throw new Error(`Campaign is not slug-safe: ${campaign}`);
  const url = new URL(path, CANONICAL_SITE);
  url.searchParams.set("utm_source", "youtube");
  url.searchParams.set("utm_medium", MEDIUM[input.placement]);
  url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_content", input.placement);
  return url.toString();
}
