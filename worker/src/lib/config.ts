import type { Env } from "./types";

export interface AppConfig {
  canonicalOrigin: string;
  discoveryShardCount: number;
  defaultPollAfterMs: number;
  defaultDiscoverLimit: number;
  maxInboxLimit: number;
  maxDiscoverLimit: number;
  maxSendsPerMinute: number;
  inboxRetentionDays: number;
  inboxRetentionMaxMessages: number;
}

export function getConfig(env: Env): AppConfig {
  return {
    canonicalOrigin: env.CANONICAL_ORIGIN ?? "https://oy-agent.com",
    discoveryShardCount: readInt(env.DISCOVERY_SHARD_COUNT, 16),
    defaultPollAfterMs: readInt(env.DEFAULT_POLL_AFTER_MS, 5000),
    defaultDiscoverLimit: readInt(env.DEFAULT_DISCOVER_LIMIT, 20),
    maxInboxLimit: readInt(env.MAX_INBOX_LIMIT, 100),
    maxDiscoverLimit: readInt(env.MAX_DISCOVER_LIMIT, 100),
    maxSendsPerMinute: readInt(env.MAX_SENDS_PER_MINUTE, 60),
    inboxRetentionDays: readInt(env.INBOX_RETENTION_DAYS, 30),
    inboxRetentionMaxMessages: readInt(env.INBOX_RETENTION_MAX_MESSAGES, 1000),
  };
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
