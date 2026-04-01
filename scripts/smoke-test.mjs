#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.OY_BASE_URL ?? "https://oy-agent.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runId = buildRunId();

  console.log(`Smoke testing ${baseUrl}`);
  console.log(`Run id: ${runId}`);

  await assertPage(baseUrl, "/", "Oy!", timeoutMs);
  await assertPage(baseUrl, "/skill.md", "# Oy Skill", timeoutMs);
  await assertPage(baseUrl, "/docs/api", "Oy Protocol v1", timeoutMs);
  await assertPage(baseUrl, "/status", "Oy Network Status", timeoutMs);

  const initialPublicStats = await fetchJson(baseUrl, "/public/stats", {}, timeoutMs);
  assertPublicStats(initialPublicStats, "initial /public/stats");

  const sender = await registerAgent(baseUrl, `smoke-sender-${runId}`, timeoutMs);
  const recipient = await registerAgent(baseUrl, `smoke-recipient-${runId}`, timeoutMs);

  console.log(`Registered sender ${sender.agent_id}`);
  console.log(`Registered recipient ${recipient.agent_id}`);

  const sendResponse = await fetchJson(
    baseUrl,
    "/v1/oy",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${sender.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to_agent_id: recipient.agent_id,
        request_id: `req_smoke_${runId}_0001`,
      }),
    },
    timeoutMs,
  );

  assert(typeof sendResponse.message_id === "string" && sendResponse.message_id.length > 0, "send response is missing message_id");
  assert(sendResponse.duplicate === false, "first smoke-test send unexpectedly returned duplicate=true");
  assert(typeof sendResponse.accepted_at_ms === "number", "send response is missing accepted_at_ms");
  console.log(`Accepted message ${sendResponse.message_id}`);

  const inbox = await pollUntil(
    async () => {
      const response = await fetchJson(
        baseUrl,
        "/v1/inbox?after=0&limit=20",
        {
          headers: {
            authorization: `Bearer ${recipient.api_key}`,
          },
        },
        timeoutMs,
      );

      const messages = Array.isArray(response.messages) ? response.messages : [];
      return messages.find((message) => message.message_id === sendResponse.message_id) ?? null;
    },
    timeoutMs,
    pollIntervalMs,
    "recipient inbox did not receive the smoke-test oy",
  );

  assert(inbox.from_agent_id === sender.agent_id, "inbox message sender did not match the registered sender");
  console.log(`Recipient inbox received seq ${inbox.seq}`);

  const senderStats = await fetchJson(
    baseUrl,
    "/v1/stats",
    {
      headers: {
        authorization: `Bearer ${sender.api_key}`,
      },
    },
    timeoutMs,
  );
  const recipientStats = await fetchJson(
    baseUrl,
    "/v1/stats",
    {
      headers: {
        authorization: `Bearer ${recipient.api_key}`,
      },
    },
    timeoutMs,
  );

  assert(senderStats.agent_id === sender.agent_id, "sender stats returned the wrong agent_id");
  assert(recipientStats.agent_id === recipient.agent_id, "recipient stats returned the wrong agent_id");
  assert(senderStats.sent_count >= 1, "sender stats did not record the smoke-test send");
  assert(recipientStats.received_count >= 1, "recipient stats did not record the smoke-test receive");
  console.log("Agent stats reflect the send and receive flow");

  const updatedPublicStats = await pollUntil(
    async () => {
      const stats = await fetchJson(baseUrl, "/public/stats", {}, timeoutMs);
      assertPublicStats(stats, "updated /public/stats");
      return stats.accepted_oys_total >= initialPublicStats.accepted_oys_total + 1 ? stats : null;
    },
    timeoutMs,
    pollIntervalMs,
    "public stats did not reflect the accepted oy in time",
  );

  console.log(
    `Public stats updated from ${initialPublicStats.accepted_oys_total} to ${updatedPublicStats.accepted_oys_total} accepted oys`,
  );
  console.log("Smoke test passed");
}

function parseArgs(argv) {
  const options = {
    help: false,
    baseUrl: undefined,
    timeoutMs: undefined,
    pollIntervalMs: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }

    if (value === "--base-url") {
      options.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }

    if (value.startsWith("--base-url=")) {
      options.baseUrl = value.slice("--base-url=".length);
      continue;
    }

    if (value === "--timeout-ms") {
      options.timeoutMs = parseInteger(argv[index + 1], "--timeout-ms");
      index += 1;
      continue;
    }

    if (value.startsWith("--timeout-ms=")) {
      options.timeoutMs = parseInteger(value.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }

    if (value === "--poll-interval-ms") {
      options.pollIntervalMs = parseInteger(argv[index + 1], "--poll-interval-ms");
      index += 1;
      continue;
    }

    if (value.startsWith("--poll-interval-ms=")) {
      options.pollIntervalMs = parseInteger(value.slice("--poll-interval-ms=".length), "--poll-interval-ms");
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: pnpm smoke [--base-url <url>] [--timeout-ms <ms>] [--poll-interval-ms <ms>]

Options:
  --base-url           Override the default base URL (env: OY_BASE_URL)
  --timeout-ms         Total poll timeout for eventual checks
  --poll-interval-ms   Delay between poll attempts
  -h, --help           Show this help output`);
}

function normalizeBaseUrl(rawUrl) {
  assert(typeof rawUrl === "string" && rawUrl.length > 0, "base URL is required");
  const url = new URL(rawUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function assertPage(baseUrl, path, expectedText, timeoutMs) {
  const response = await fetchWithTimeout(new URL(path, baseUrl), {}, timeoutMs);
  const body = await response.text();

  assert(response.ok, `${path} returned ${response.status}`);
  assert(body.includes(expectedText), `${path} did not include expected text: ${expectedText}`);
  console.log(`Verified ${path}`);
}

async function registerAgent(baseUrl, name, timeoutMs) {
  const response = await fetchJson(
    baseUrl,
    "/v1/register",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        software: "smoke-test",
        discoverable: true,
      }),
    },
    timeoutMs,
  );

  assert(typeof response.agent_id === "string" && response.agent_id.startsWith("agt_"), "register response is missing agent_id");
  assert(typeof response.api_key === "string" && response.api_key.startsWith("oy."), "register response is missing api_key");
  assert(Array.isArray(response.discover), "register response is missing discover");
  assert(typeof response.poll_after_ms === "number", "register response is missing poll_after_ms");

  return response;
}

async function fetchJson(baseUrl, path, init, timeoutMs) {
  const response = await fetchWithTimeout(new URL(path, baseUrl), init, timeoutMs);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function pollUntil(fn, timeoutMs, pollIntervalMs, message) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) {
      return result;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(message);
}

function assertPublicStats(stats, label) {
  assert(typeof stats.total_agents === "number", `${label} is missing total_agents`);
  assert(typeof stats.accepted_oys_total === "number", `${label} is missing accepted_oys_total`);
  assert(typeof stats.accepted_oys_last_1m === "number", `${label} is missing accepted_oys_last_1m`);
  assert(typeof stats.accepted_oys_last_5m === "number", `${label} is missing accepted_oys_last_5m`);
  assert(Array.isArray(stats.per_minute_last_60m), `${label} is missing per_minute_last_60m`);
  assert(typeof stats.updated_at_ms === "number", `${label} is missing updated_at_ms`);
}

function buildRunId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseInteger(value, flagName) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
