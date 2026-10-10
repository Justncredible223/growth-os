export type LiveHostPlatform = "youtube" | "tiktok";
export type LiveHostDesiredState = "on" | "off";
export type LiveHostMessageStatus = "pending" | "answered" | "skipped" | "blocked";
export type LiveHostUtteranceKind = "reply" | "segment";

/** What the character's face does while a line is spoken. The stage maps each to an expression. */
export const LIVE_HOST_MOODS = ["neutral", "smirk", "shocked", "tilted", "proud", "thinking", "sad"] as const;
export type LiveHostMood = (typeof LIVE_HOST_MOODS)[number];

export interface LiveHostSettings {
  desiredState: LiveHostDesiredState;
  youtubeVideoId: string | null;
  tiktokChatEnabled: boolean;
  tiktokUsername: string | null;
  idleSeconds: number;
  dailyBudgetUsd: number;
  updatedAt: string;
}

export interface LiveHostSession {
  id: string;
  status: "live" | "ended";
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  lastHeartbeatAt: string;
  youtubeLiveChatId: string | null;
  youtubePageToken: string | null;
  youtubeNextPollAt: string | null;
  lastUtteranceAt: string | null;
  lastSegment: string | null;
}

export interface LiveHostMessage {
  id: string;
  sessionId: string;
  platform: LiveHostPlatform;
  externalId: string;
  authorName: string;
  body: string;
  receivedAt: string;
  status: LiveHostMessageStatus;
  statusReason: string | null;
  utteranceId: string | null;
}

/** An on-screen card shown while a line is spoken, e.g. the Roast My Trade verdict. */
export interface LiveHostCard {
  title: string;
  lines: string[];
}

export interface LiveHostUtterance {
  id: string;
  sessionId: string;
  kind: LiveHostUtteranceKind;
  segment: string | null;
  spokenText: string;
  mood: LiveHostMood;
  card: LiveHostCard | null;
  mentionsFillbook: boolean;
  status: "queued" | "spoken" | "dropped";
  createdAt: string;
  spokenAt: string | null;
}

/** A chat message as the worker (TikTok) or the YouTube adapter hands it in, before it is stored. */
export interface IncomingChatMessage {
  platform: LiveHostPlatform;
  externalId: string;
  authorName: string;
  body: string;
  receivedAt?: string;
}

/**
 * Duo mode (TikTok): the owner is on camera next to Tilt and types what Tilt should react to. Those rows are
 * stored with these external-id prefixes so the server can tell the co-host apart from a viewer. The prefixes
 * are reserved: chat read from a platform that carries one is dropped.
 */
export const DUO_HOST_ID_PREFIX = "duo-host-";
/** A viewer question the owner typed in to relay (read in TikTok's own chat). Treated as a viewer message. */
export const DUO_RELAY_ID_PREFIX = "duo-relay-";
