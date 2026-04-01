import { describe, expect, it } from "vitest";
import {
  buildApiKey,
  mailboxObjectName,
  messageIdFromRequest,
  metaShardObjectName,
} from "../src/lib/ids";
import { buildLogMetadata } from "../src/lib/logging";
import { parseBearerApiKey } from "../src/lib/auth";
import { validateRegisterBody, validateSendBody } from "../src/lib/validation";

describe("auth parsing", () => {
  it("parses a valid Oy bearer token", () => {
    expect(
      parseBearerApiKey("Bearer oy.agt_123.secret_456"),
    ).toEqual({
      agentId: "agt_123",
      secret: "secret_456",
    });
  });

  it("rejects malformed bearer tokens", () => {
    expect(parseBearerApiKey("Bearer not-oy")).toBeNull();
    expect(parseBearerApiKey(null)).toBeNull();
  });
});

describe("id helpers", () => {
  it("builds deterministic object names", () => {
    expect(mailboxObjectName("agt_1")).toBe("agent:agt_1");
    expect(metaShardObjectName(3)).toBe("meta:3");
    expect(buildApiKey("agt_1", "secret")).toBe("oy.agt_1.secret");
  });

  it("creates deterministic message ids", async () => {
    const first = await messageIdFromRequest("agt_1", "req_12345678");
    const second = await messageIdFromRequest("agt_1", "req_12345678");
    expect(first).toBe(second);
  });
});

describe("request validation", () => {
  it("normalizes register payloads", () => {
    expect(
      validateRegisterBody({
        name: "  echo-bot ",
        software: " custom-script ",
      }),
    ).toEqual({
      name: "echo-bot",
      software: "custom-script",
      discoverable: true,
    });
  });

  it("validates send payloads", () => {
    expect(
      validateSendBody({
        to_agent_id: "agt_target",
        request_id: "req_12345678",
        reply_to_message_id: "msg_abc",
      }),
    ).toEqual({
      toAgentId: "agt_target",
      requestId: "req_12345678",
      replyToMessageId: "msg_abc",
    });
  });
});

describe("logging metadata", () => {
  it("includes deploy metadata when provided", () => {
    expect(
      buildLogMetadata({
        DEPLOY_ENV: "production",
        DEPLOY_VERSION: "0.1.0+abc123",
        DEPLOY_GIT_SHA: "abc123def456",
      }),
    ).toEqual({
      service: "oy-worker",
      deploy_env: "production",
      deploy_version: "0.1.0+abc123",
      deploy_git_sha: "abc123def456",
    });
  });

  it("falls back to inferred env and unknown version", () => {
    expect(
      buildLogMetadata({
        CANONICAL_ORIGIN: "https://oy-agent.test",
      }),
    ).toEqual({
      service: "oy-worker",
      deploy_env: "test",
      deploy_version: "unknown",
    });
  });
});
