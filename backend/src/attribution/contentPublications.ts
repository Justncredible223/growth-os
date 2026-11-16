import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDestinationUrl } from "./utmBuilder.js";

export interface ContentPublicationRow {
  id: string;
  campaignAssetId: string;
  channel: string;
  destinationLink: string | null;
  actualUrl: string | null;
  evidenceType: "owner_reported_url" | "owner_confirmed_no_url";
  ownerReportedPublishedAt: string | null;
  recordedAt: string;
}

function fromRow(row: any): ContentPublicationRow {
  return {
    id: row.id,
    campaignAssetId: row.campaign_asset_id,
    channel: row.channel,
    destinationLink: row.destination_link,
    actualUrl: row.actual_url,
    evidenceType: row.evidence_type,
    ownerReportedPublishedAt: row.owner_reported_published_at,
    recordedAt: row.recorded_at,
  };
}

/**
 * The one write path for "the owner told us they published this" --
 * generalizes video_renders.published_url (0034) to every content type.
 * Upserts on (campaign_asset_id, channel) so re-editing a link (the
 * Android "Edit" affordance video already has) updates the same row
 * rather than creating a duplicate. Never itself posts, shares, or
 * verifies anything externally -- this is purely a database write of
 * what the owner reports, same EXTERNAL_DRAFT-only guarantee as the rest
 * of this pipeline (see docs/EXTERNAL_WRITE_FIREWALL.md).
 */
export async function recordOwnerPublication(
  client: SupabaseClient,
  input: {
    campaignAssetId: string;
    channel: string;
    actualUrl?: string | null;
    ownerReportedPublishedAt?: string | null;
  },
): Promise<ContentPublicationRow> {
  const actualUrl = input.actualUrl?.trim() || null;
  if (actualUrl) {
    let parsed: URL;
    try {
      parsed = new URL(actualUrl);
    } catch {
      throw new Error("That doesn't look like a real URL -- must be a valid http(s) link.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Must be a real http(s) URL.");
    }
  }

  const { data, error } = await client
    .from("content_publications")
    .upsert(
      {
        campaign_asset_id: input.campaignAssetId,
        channel: input.channel,
        actual_url: actualUrl,
        evidence_type: actualUrl ? "owner_reported_url" : "owner_confirmed_no_url",
        owner_reported_published_at: input.ownerReportedPublishedAt ?? new Date().toISOString(),
        recorded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "campaign_asset_id,channel" },
    )
    .select()
    .single();
  if (error) throw new Error(`Failed to record publication: ${error.message}`);
  return fromRow(data);
}

/**
 * Get-or-create the trackable destination link for one campaign asset +
 * channel, independent of whether it's been published yet -- "Copy
 * tracking link" must work the moment a draft is approved, not only after
 * "I posted this." Stored on first read so every later read (this asset's
 * own screen, Analytics joining clicks back to it) returns the exact same
 * URL rather than regenerating a new UTM string each time.
 */
export async function getOrCreateDestinationLink(
  client: SupabaseClient,
  input: { campaignAssetId: string; channel: string; campaignThesis: string; path?: string },
): Promise<string> {
  const { data: existing, error: selectError } = await client
    .from("content_publications")
    .select("destination_link")
    .eq("campaign_asset_id", input.campaignAssetId)
    .eq("channel", input.channel)
    .maybeSingle();
  if (selectError) throw new Error(`Failed to look up destination link: ${selectError.message}`);
  if (existing?.destination_link) return existing.destination_link;

  const destinationLink = buildDestinationUrl(input.campaignAssetId, input.channel, input.campaignThesis, input.path ?? "/");

  // Row may not exist yet (asset not published) -- insert a placeholder
  // row carrying only the link, no evidence, so a later "I posted this"
  // upserts onto it instead of colliding. ignoreDuplicates: a concurrent
  // second reader racing this same insert is a harmless no-op, not an
  // error -- the unique (campaign_asset_id, channel) constraint is the
  // safety net either way.
  const { error: insertError } = await client
    .from("content_publications")
    .upsert(
      { campaign_asset_id: input.campaignAssetId, channel: input.channel, destination_link: destinationLink, evidence_type: "owner_confirmed_no_url" },
      { onConflict: "campaign_asset_id,channel", ignoreDuplicates: true },
    );
  if (insertError) throw new Error(`Failed to save destination link: ${insertError.message}`);
  return destinationLink;
}

/**
 * Read-only twin of getOrCreateDestinationLink for list views (P0 2026-11-15, ChatGPT: reads must be side-effect-free). Returns the stored
 * link if there is one, otherwise the same deterministic link it would store, and writes nothing.
 */
export async function peekDestinationLink(
  client: SupabaseClient,
  input: { campaignAssetId: string; channel: string; campaignThesis: string; path?: string },
): Promise<string> {
  const { data: existing } = await client
    .from("content_publications")
    .select("destination_link")
    .eq("campaign_asset_id", input.campaignAssetId)
    .eq("channel", input.channel)
    .maybeSingle();
  if (existing?.destination_link) return existing.destination_link as string;
  return buildDestinationUrl(input.campaignAssetId, input.channel, input.campaignThesis, input.path ?? "/");
}

export async function listPublicationsForAssets(client: SupabaseClient, campaignAssetIds: string[]): Promise<ContentPublicationRow[]> {
  if (campaignAssetIds.length === 0) return [];
  const { data, error } = await client.from("content_publications").select("*").in("campaign_asset_id", campaignAssetIds);
  if (error) throw new Error(`Failed to list publications: ${error.message}`);
  return (data ?? []).map(fromRow);
}
