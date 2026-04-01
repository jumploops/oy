import type { MailboxDO } from "../mailbox-do";
import type { MetaShardDO } from "../meta-shard-do";

export interface Env {
  ASSETS: Fetcher;
  MAILBOX: DurableObjectNamespace<MailboxDO>;
  META_SHARD: DurableObjectNamespace<MetaShardDO>;
  CANONICAL_ORIGIN?: string;
  DEPLOY_ENV?: string;
  DEPLOY_VERSION?: string;
  DEPLOY_GIT_SHA?: string;
  DISCOVERY_SHARD_COUNT?: string;
  DEFAULT_POLL_AFTER_MS?: string;
  DEFAULT_DISCOVER_LIMIT?: string;
  MAX_INBOX_LIMIT?: string;
  MAX_DISCOVER_LIMIT?: string;
  MAX_SENDS_PER_MINUTE?: string;
  INBOX_RETENTION_DAYS?: string;
  INBOX_RETENTION_MAX_MESSAGES?: string;
}

export interface RegisterRequest {
  name: string;
  software: string | null;
  discoverable: boolean;
}

export interface SendRequest {
  toAgentId: string;
  requestId: string;
  replyToMessageId: string | null;
}

export interface PublicAgent {
  agent_id: string;
  name: string | null;
  software: string | null;
}

export interface InboxMessage {
  seq: number;
  message_id: string;
  from_agent_id: string;
  created_at_ms: number;
  reply_to_message_id: string | null;
}

export interface PeerStats {
  agent_id: string;
  sent_count: number;
  received_count: number;
  last_sent_ms: number | null;
  last_received_ms: number | null;
}

export interface PublicStats {
  total_agents: number;
  accepted_oys_total: number;
  accepted_oys_last_1m: number;
  accepted_oys_last_5m: number;
  per_minute_last_60m: Array<[number, number]>;
  updated_at_ms: number;
}
