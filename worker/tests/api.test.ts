import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mailboxObjectName } from "../src/lib/ids";
import type { Env } from "../src/lib/types";
import type { MailboxDO } from "../src/mailbox-do";

interface RegisterResponse {
  agent_id: string;
  api_key: string;
  discover: Array<{
    agent_id: string;
    name: string | null;
    software: string | null;
  }>;
  poll_after_ms: number;
}

interface SendResponse {
  message_id: string;
  duplicate: boolean;
  accepted_at_ms: number;
}

interface InboxResponse {
  messages: Array<{
    seq: number;
    message_id: string;
    from_agent_id: string;
    created_at_ms: number;
    reply_to_message_id: string | null;
  }>;
  next_after: number;
}

interface StatsResponse {
  agent_id: string;
  sent_count: number;
  received_count: number;
  returned_count: number;
  recent_peers: Array<{
    agent_id: string;
    sent_count: number;
    received_count: number;
    last_sent_ms: number | null;
    last_received_ms: number | null;
  }>;
}

interface PublicStatsResponse {
  total_agents: number;
  accepted_oys_total: number;
  accepted_oys_last_1m: number;
  accepted_oys_last_5m: number;
  per_minute_last_60m: Array<[number, number]>;
  updated_at_ms: number;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

describe("Oy API", () => {
  it("supports register, send, retry, reply, and stats flows", async () => {
    const alpha = await registerAgent("alpha-bot");
    const beta = await registerAgent("beta-bot");

    expect(alpha.agent_id).not.toBe(beta.agent_id);
    expect(alpha.api_key.startsWith(`oy.${alpha.agent_id}.`)).toBe(true);
    expect(beta.api_key.startsWith(`oy.${beta.agent_id}.`)).toBe(true);

    const firstSend = await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_alpha_to_beta_0001",
    });
    expect(firstSend.duplicate).toBe(false);

    const duplicateSend = await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_alpha_to_beta_0001",
    });
    expect(duplicateSend.message_id).toBe(firstSend.message_id);
    expect(duplicateSend.duplicate).toBe(true);

    const betaInbox = await getJson<InboxResponse>("/v1/inbox?after=0&limit=20", {
      headers: authHeaders(beta.api_key),
    });
    expect(betaInbox.messages).toHaveLength(1);
    expect(betaInbox.messages[0]?.from_agent_id).toBe(alpha.agent_id);
    expect(betaInbox.messages[0]?.message_id).toBe(firstSend.message_id);

    const replyMessage = betaInbox.messages[0]!;
    const betaReply = await sendOy(beta.api_key, {
      to_agent_id: alpha.agent_id,
      request_id: "req_beta_to_alpha_0001",
      reply_to_message_id: replyMessage.message_id,
    });
    expect(betaReply.duplicate).toBe(false);

    const alphaInbox = await getJson<InboxResponse>("/v1/inbox?after=0&limit=20", {
      headers: authHeaders(alpha.api_key),
    });
    expect(alphaInbox.messages).toHaveLength(1);
    expect(alphaInbox.messages[0]?.reply_to_message_id).toBe(replyMessage.message_id);

    const alphaStats = await getJson<StatsResponse>("/v1/stats", {
      headers: authHeaders(alpha.api_key),
    });
    expect(alphaStats.sent_count).toBe(1);
    expect(alphaStats.received_count).toBe(1);
    expect(alphaStats.returned_count).toBe(1);

    const betaStats = await getJson<StatsResponse>("/v1/stats", {
      headers: authHeaders(beta.api_key),
    });
    expect(betaStats.sent_count).toBe(1);
    expect(betaStats.received_count).toBe(1);

    const publicStats = await waitForPublicStats((stats) => stats.accepted_oys_total >= 2);
    expect(publicStats.total_agents).toBe(2);
    expect(publicStats.accepted_oys_total).toBe(2);
    expect(publicStats.accepted_oys_last_1m).toBeGreaterThanOrEqual(2);
    expect(publicStats.accepted_oys_last_5m).toBeGreaterThanOrEqual(2);
  });

  it("rejects self-send", async () => {
    const alpha = await registerAgent("self-check-bot");

    const response = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: alpha.agent_id,
        request_id: "req_self_send_0001",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "to_agent_id cannot equal caller agent_id",
      },
    });
  });

  it("rejects missing bearer auth on authenticated routes", async () => {
    const response = await SELF.fetch("https://oy-agent.test/v1/stats");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing or invalid bearer token",
      },
    });
  });

  it("rejects malformed bearer auth on authenticated routes", async () => {
    const response = await SELF.fetch("https://oy-agent.test/v1/stats", {
      headers: {
        authorization: "Bearer definitely-not-an-oy-token",
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing or invalid bearer token",
      },
    });
  });

  it("rejects bearer tokens with the wrong secret", async () => {
    const alpha = await registerAgent("bad-secret-alpha");

    const response = await SELF.fetch("https://oy-agent.test/v1/stats", {
      headers: {
        authorization: `Bearer oy.${alpha.agent_id}.not_the_real_secret`,
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "UNAUTHENTICATED",
        message: "Invalid API key",
      },
    });
  });

  it("rejects malformed JSON request bodies", async () => {
    const response = await SELF.fetch("https://oy-agent.test/v1/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{ this is not valid json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "Request body must be valid JSON",
      },
    });
  });

  it("rejects non-object JSON request bodies", async () => {
    const response = await SELF.fetch("https://oy-agent.test/v1/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(["not", "an", "object"]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "Request body must be a JSON object",
      },
    });
  });

  it("validates required register fields", async () => {
    const response = await SELF.fetch("https://oy-agent.test/v1/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        software: "vitest",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "name is required",
      },
    });
  });

  it("validates required send fields", async () => {
    const alpha = await registerAgent("missing-request-id-alpha");
    const beta = await registerAgent("missing-request-id-beta");

    const response = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: beta.agent_id,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "request_id is required",
      },
    });
  });

  it("validates request_id length on send", async () => {
    const alpha = await registerAgent("short-request-id-alpha");
    const beta = await registerAgent("short-request-id-beta");

    const response = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: beta.agent_id,
        request_id: "short",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "request_id must be between 8 and 128 characters",
      },
    });
  });

  it("returns not found for unknown recipients without incrementing sender stats", async () => {
    const alpha = await registerAgent("unknown-recipient-bot");

    const response = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: "agt_missing_recipient",
        request_id: "req_missing_target_0001",
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Recipient agent does not exist",
      },
    });

    const stats = await getJson<StatsResponse>("/v1/stats", {
      headers: authHeaders(alpha.api_key),
    });
    expect(stats.sent_count).toBe(0);
    expect(stats.received_count).toBe(0);
    expect(stats.returned_count).toBe(0);
  });

  it("repeats not-found responses for the same missing recipient request without creating sender state", async () => {
    const alpha = await registerAgent("repeat-missing-recipient-alpha");
    const payload = {
      to_agent_id: "agt_missing_repeat_target",
      request_id: "req_missing_repeat_target_0001",
    };

    const first = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const second = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);

    const stats = await getJson<StatsResponse>("/v1/stats", {
      headers: authHeaders(alpha.api_key),
    });
    expect(stats.sent_count).toBe(0);
  });

  it("does not count duplicate retries toward the per-agent send limit", async () => {
    const alpha = await registerAgent("rate-limit-alpha");
    const beta = await registerAgent("rate-limit-beta");

    const firstSend = await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_rate_limit_base_0001",
    });
    expect(firstSend.duplicate).toBe(false);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const duplicate = await sendOy(alpha.api_key, {
        to_agent_id: beta.agent_id,
        request_id: "req_rate_limit_base_0001",
      });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.message_id).toBe(firstSend.message_id);
    }

    for (let index = 0; index < 59; index += 1) {
      const accepted = await sendOy(alpha.api_key, {
        to_agent_id: beta.agent_id,
        request_id: `req_rate_limit_unique_${index.toString().padStart(4, "0")}`,
      });
      expect(accepted.duplicate).toBe(false);
    }

    const limitedResponse = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: beta.agent_id,
        request_id: "req_rate_limit_overflow_0001",
      }),
    });

    expect(limitedResponse.status).toBe(429);
    expect(await limitedResponse.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Per-agent send limit exceeded",
      },
    });

    const stats = await getJson<StatsResponse>("/v1/stats", {
      headers: authHeaders(alpha.api_key),
    });
    expect(stats.sent_count).toBe(60);
  });

  it("still returns duplicate for an already accepted message after the sender is rate limited", async () => {
    const alpha = await registerAgent("post-limit-duplicate-alpha");
    const beta = await registerAgent("post-limit-duplicate-beta");

    const firstSend = await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_post_limit_duplicate_seed_0001",
    });
    expect(firstSend.duplicate).toBe(false);

    for (let index = 0; index < 59; index += 1) {
      await sendOy(alpha.api_key, {
        to_agent_id: beta.agent_id,
        request_id: `req_post_limit_unique_${index.toString().padStart(4, "0")}`,
      });
    }

    const duplicateResponse = await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_post_limit_duplicate_seed_0001",
    });
    expect(duplicateResponse.duplicate).toBe(true);
    expect(duplicateResponse.message_id).toBe(firstSend.message_id);

    const limitedResponse = await SELF.fetch("https://oy-agent.test/v1/oy", {
      method: "POST",
      headers: {
        ...authHeaders(alpha.api_key),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: beta.agent_id,
        request_id: "req_post_limit_overflow_0001",
      }),
    });
    expect(limitedResponse.status).toBe(429);
  });

  it("does not leak hidden agents through inline registration discovery", async () => {
    const hidden = await registerAgent("hidden-inline-bot", { discoverable: false });
    const visible = await registerAgent("visible-inline-bot");
    const newcomer = await registerAgent("newcomer-inline-bot");

    expect(newcomer.discover.some((agent) => agent.agent_id === visible.agent_id)).toBe(true);
    expect(newcomer.discover.some((agent) => agent.agent_id === hidden.agent_id)).toBe(false);
    expect(newcomer.discover.some((agent) => agent.agent_id === newcomer.agent_id)).toBe(false);
  });

  it("returns recent peers from discover and excludes hidden agents and self", async () => {
    const hidden = await registerAgent("hidden-bot", { discoverable: false });
    const alpha = await registerAgent("discover-alpha");
    const beta = await registerAgent("discover-beta");

    await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_discover_recent_peer_0001",
    });

    const discover = await getJson<{ agents: RegisterResponse["discover"] }>("/v1/discover?limit=20", {
      headers: authHeaders(alpha.api_key),
    });

    expect(discover.agents.some((agent) => agent.agent_id === beta.agent_id)).toBe(true);
    expect(discover.agents.some((agent) => agent.agent_id === hidden.agent_id)).toBe(false);
    expect(discover.agents.some((agent) => agent.agent_id === alpha.agent_id)).toBe(false);
  });

  it("paginates inbox results in ascending sequence order", async () => {
    const alpha = await registerAgent("pagination-alpha");
    const beta = await registerAgent("pagination-beta");

    for (let index = 0; index < 3; index += 1) {
      await sendOy(alpha.api_key, {
        to_agent_id: beta.agent_id,
        request_id: `req_inbox_page_${index.toString().padStart(4, "0")}`,
      });
    }

    const firstPage = await getJson<InboxResponse>("/v1/inbox?after=0&limit=2", {
      headers: authHeaders(beta.api_key),
    });
    expect(firstPage.messages).toHaveLength(2);
    expect(firstPage.messages[0]!.seq).toBeLessThan(firstPage.messages[1]!.seq);
    expect(firstPage.next_after).toBe(firstPage.messages[1]!.seq);

    const secondPage = await getJson<InboxResponse>(
      `/v1/inbox?after=${firstPage.next_after}&limit=2`,
      {
        headers: authHeaders(beta.api_key),
      },
    );
    expect(secondPage.messages).toHaveLength(1);
    expect(secondPage.messages[0]!.seq).toBeGreaterThan(firstPage.next_after);
  });

  it("validates inbox query parameters", async () => {
    const alpha = await registerAgent("bad-inbox-query-alpha");

    const afterResponse = await SELF.fetch("https://oy-agent.test/v1/inbox?after=-1", {
      headers: authHeaders(alpha.api_key),
    });
    expect(afterResponse.status).toBe(400);
    expect(await afterResponse.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "after must be a non-negative integer",
      },
    });

    const limitResponse = await SELF.fetch("https://oy-agent.test/v1/inbox?limit=0", {
      headers: authHeaders(alpha.api_key),
    });
    expect(limitResponse.status).toBe(400);
    expect(await limitResponse.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "limit must be a positive integer",
      },
    });
  });

  it("validates discover query parameters", async () => {
    const alpha = await registerAgent("bad-discover-query-alpha");

    const response = await SELF.fetch("https://oy-agent.test/v1/discover?limit=0", {
      headers: authHeaders(alpha.api_key),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "INVALID_ARGUMENT",
        message: "limit must be a positive integer",
      },
    });
  });

  it("runs mailbox retention when the scheduled alarm fires", async () => {
    const beta = await registerAgent("retention-beta");
    const mailbox = (env as unknown as Env).MAILBOX.getByName(
      mailboxObjectName(beta.agent_id),
    ) as DurableObjectStub<MailboxDO>;

    const seededInbox = await runInDurableObject(mailbox, async (instance: MailboxDO) => {
      await instance.deliverMessage({
        messageId: "msg_old_alarm_seed",
        fromAgentId: "agt_sender_seed",
        createdAtMs: 1,
        replyToMessageId: null,
      });

      return instance.listInbox(0, 20);
    });

    expect(seededInbox.messages).toHaveLength(1);

    const ranAlarm = await runDurableObjectAlarm(mailbox);
    expect(ranAlarm).toBe(true);

    const retainedInbox = await runInDurableObject(mailbox, async (instance: MailboxDO) =>
      instance.listInbox(0, 20),
    );
    expect(retainedInbox.messages).toHaveLength(0);
  });

  it("returns a 60-point ascending minute series from public stats", async () => {
    const alpha = await registerAgent("minute-series-alpha");
    const beta = await registerAgent("minute-series-beta");

    await sendOy(alpha.api_key, {
      to_agent_id: beta.agent_id,
      request_id: "req_minute_series_0001",
    });

    const publicStats = await waitForPublicStats((stats) => stats.accepted_oys_total >= 1);
    expect(publicStats.per_minute_last_60m).toHaveLength(60);
    expect(publicStats.updated_at_ms).toBeGreaterThan(0);

    for (let index = 1; index < publicStats.per_minute_last_60m.length; index += 1) {
      const previous = publicStats.per_minute_last_60m[index - 1]!;
      const current = publicStats.per_minute_last_60m[index]!;
      expect(current[0] - previous[0]).toBe(60_000);
      expect(current[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns the standard not found envelope for unknown routes", async () => {
    const response = await SELF.fetch("https://oy-agent.test/v1/not-a-route");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
      },
    });
  });
});

async function registerAgent(
  name: string,
  options?: { discoverable?: boolean; software?: string },
): Promise<RegisterResponse> {
  return getJson<RegisterResponse>("/v1/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name,
      software: options?.software ?? "vitest",
      discoverable: options?.discoverable ?? true,
    }),
  });
}

async function sendOy(
  apiKey: string,
  body: Record<string, string>,
): Promise<SendResponse> {
  return getJson<SendResponse>("/v1/oy", {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await SELF.fetch(`https://oy-agent.test${path}`, init);
  if (!response.ok) {
    throw new Error(`Unexpected ${response.status} for ${path}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    authorization: `Bearer ${apiKey}`,
  };
}

async function waitForPublicStats(
  predicate: (stats: PublicStatsResponse) => boolean,
): Promise<PublicStatsResponse> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const stats = await getJson<PublicStatsResponse>("/public/stats");
    if (predicate(stats)) {
      return stats;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for public stats to reflect accepted sends");
}
