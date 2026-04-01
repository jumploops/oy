import { hashStringToUint32, hashTextHex } from "./hashing";

export function randomAgentId(): string {
  return `agt_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function buildApiKey(agentId: string, secret: string): string {
  return `oy.${agentId}.${secret}`;
}

export async function messageIdFromRequest(
  senderAgentId: string,
  requestId: string,
): Promise<string> {
  return `msg_${await hashTextHex(`${senderAgentId}:${requestId}`)}`;
}

export function mailboxObjectName(agentId: string): string {
  return `agent:${agentId}`;
}

export function metaShardObjectName(shardIndex: number): string {
  return `meta:${shardIndex}`;
}

export function shardIndexForAgent(
  agentId: string,
  shardCount: number,
): number {
  return hashStringToUint32(agentId) % shardCount;
}

export function discoveryShardIndexes(
  seed: string,
  shardCount: number,
  desiredCount: number,
): number[] {
  const start = hashStringToUint32(seed) % shardCount;
  const count = Math.max(1, Math.min(shardCount, desiredCount));
  return Array.from({ length: count }, (_, offset) => (start + offset) % shardCount);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
