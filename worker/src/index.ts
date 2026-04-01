import { MailboxDO } from "./mailbox-do";
import { MetaShardDO } from "./meta-shard-do";
import { parseBearerApiKey } from "./lib/auth";
import { getConfig } from "./lib/config";
import {
  buildApiKey,
  discoveryShardIndexes,
  mailboxObjectName,
  messageIdFromRequest,
  metaShardObjectName,
  randomAgentId,
  randomSecret,
  shardIndexForAgent,
} from "./lib/ids";
import { buildLogMetadata, logRequest, logUnhandledError } from "./lib/logging";
import { errorJson, json } from "./lib/responses";
import { minuteEpochFromMs, nowMs } from "./lib/time";
import type { Env, PublicAgent } from "./lib/types";
import {
  parseAfter,
  parseLimit,
  readJsonObject,
  validateRegisterBody,
  validateSendBody,
  ValidationError,
} from "./lib/validation";

export { MailboxDO, MetaShardDO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const config = getConfig(env);
    const startedAtMs = nowMs();
    const logMetadata = buildLogMetadata(env);
    const log = (event: Parameters<typeof logRequest>[0]) => {
      logRequest(event, logMetadata);
    };
    const logError = (route: string, error: unknown) => {
      logUnhandledError(route, error, logMetadata);
    };

    try {
      if (request.method === "POST" && url.pathname === "/v1/register") {
        const body = validateRegisterBody(await readJsonObject(request));
        const createdAtMs = nowMs();
        const agentId = randomAgentId();
        const secret = randomSecret();
        const mailbox = env.MAILBOX.getByName(mailboxObjectName(agentId));

        await mailbox.initializeProfile({
          agentId,
          name: body.name,
          software: body.software,
          discoverable: body.discoverable,
          secret,
          createdAtMs,
        });

        const shardIndex = shardIndexForAgent(agentId, config.discoveryShardCount);
        const metaShard = env.META_SHARD.getByName(metaShardObjectName(shardIndex));
        await metaShard.upsertPublicAgent({
          agentId,
          name: body.name,
          software: body.software,
          discoverable: body.discoverable,
          createdAtMs,
        });

        const discover = await sampleDiscoveryAgents(
          env,
          config.discoveryShardCount,
          agentId,
          [],
          config.defaultDiscoverLimit,
        );

        const response = json({
          agent_id: agentId,
          api_key: buildApiKey(agentId, secret),
          discover,
          poll_after_ms: config.defaultPollAfterMs,
        });
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          agent_id: agentId,
        });
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/oy") {
        const auth = await authenticateRequest(request, env);
        if (auth instanceof Response) {
          const errorCode = await getErrorCode(auth);
          log({
            route: url.pathname,
            method: request.method,
            status_code: auth.status,
            duration_ms: nowMs() - startedAtMs,
            error_code: errorCode,
          });
          return auth;
        }

        const body = validateSendBody(await readJsonObject(request));
        if (body.toAgentId === auth.agentId) {
          const response = errorJson(400, "INVALID_ARGUMENT", "to_agent_id cannot equal caller agent_id");
          log({
            route: url.pathname,
            method: request.method,
            status_code: response.status,
            duration_ms: nowMs() - startedAtMs,
            agent_id: auth.agentId,
            target_agent_id: body.toAgentId,
            request_id: body.requestId,
            error_code: "INVALID_ARGUMENT",
          });
          return response;
        }

        const messageId = await messageIdFromRequest(auth.agentId, body.requestId);
        const existingSend = await auth.mailbox.getSentRecord(
          messageId,
          body.requestId,
        );
        if (existingSend) {
          const response = json({
            message_id: existingSend.message_id,
            duplicate: true,
            accepted_at_ms: existingSend.created_at_ms,
          });
          log({
            route: url.pathname,
            method: request.method,
            status_code: response.status,
            duration_ms: nowMs() - startedAtMs,
            agent_id: auth.agentId,
            target_agent_id: body.toAgentId,
            request_id: body.requestId,
            message_id: existingSend.message_id,
            duplicate: true,
          });
          return response;
        }

        const sendWindow = await auth.mailbox.checkAndIncrementRateLimit(
          nowMs(),
          config.maxSendsPerMinute,
        );
        if (!sendWindow.allowed) {
          const response = errorJson(429, "RATE_LIMITED", "Per-agent send limit exceeded");
          log({
            route: url.pathname,
            method: request.method,
            status_code: response.status,
            duration_ms: nowMs() - startedAtMs,
            agent_id: auth.agentId,
            target_agent_id: body.toAgentId,
            request_id: body.requestId,
            message_id: messageId,
            error_code: "RATE_LIMITED",
          });
          return response;
        }

        const acceptedAtMs = nowMs();
        const recipientMailbox = env.MAILBOX.getByName(
          mailboxObjectName(body.toAgentId),
        );

        const delivery = await recipientMailbox.deliverMessage({
          messageId,
          fromAgentId: auth.agentId,
          createdAtMs: acceptedAtMs,
          replyToMessageId: body.replyToMessageId,
        });

        if (delivery.status === "not_found") {
          const response = errorJson(404, "NOT_FOUND", "Recipient agent does not exist");
          log({
            route: url.pathname,
            method: request.method,
            status_code: response.status,
            duration_ms: nowMs() - startedAtMs,
            agent_id: auth.agentId,
            target_agent_id: body.toAgentId,
            request_id: body.requestId,
            message_id: messageId,
            error_code: "NOT_FOUND",
          });
          return response;
        }

        const senderRecord = await auth.mailbox.recordSentMessage({
          messageId,
          requestId: body.requestId,
          toAgentId: body.toAgentId,
          createdAtMs: acceptedAtMs,
        });

        if (senderRecord.recorded) {
          const analyticsShard = env.META_SHARD.getByName(
            metaShardObjectName(
              shardIndexForAgent(auth.agentId, config.discoveryShardCount),
            ),
          );
          ctx.waitUntil(
            analyticsShard.incrementAcceptedOys(
              minuteEpochFromMs(acceptedAtMs),
              1,
            ),
          );
        }

        const response = json({
          message_id: messageId,
          duplicate: !senderRecord.recorded,
          accepted_at_ms: acceptedAtMs,
        });
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          agent_id: auth.agentId,
          target_agent_id: body.toAgentId,
          request_id: body.requestId,
          message_id: messageId,
          duplicate: !senderRecord.recorded,
        });
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/inbox") {
        const auth = await authenticateRequest(request, env);
        if (auth instanceof Response) {
          const errorCode = await getErrorCode(auth);
          log({
            route: url.pathname,
            method: request.method,
            status_code: auth.status,
            duration_ms: nowMs() - startedAtMs,
            error_code: errorCode,
          });
          return auth;
        }

        const after = parseAfter(url.searchParams.get("after"));
        const limit = parseLimit(
          url.searchParams.get("limit"),
          20,
          config.maxInboxLimit,
        );
        const inbox = await auth.mailbox.listInbox(after, limit);
        const response = json(inbox);
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          agent_id: auth.agentId,
        });
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/discover") {
        const auth = await authenticateRequest(request, env);
        if (auth instanceof Response) {
          const errorCode = await getErrorCode(auth);
          log({
            route: url.pathname,
            method: request.method,
            status_code: auth.status,
            duration_ms: nowMs() - startedAtMs,
            error_code: errorCode,
          });
          return auth;
        }

        const limit = parseLimit(
          url.searchParams.get("limit"),
          config.defaultDiscoverLimit,
          config.maxDiscoverLimit,
        );
        const recentPeers = await auth.mailbox.getRecentPeers(limit);
        const agents = await sampleDiscoveryAgents(
          env,
          config.discoveryShardCount,
          auth.agentId,
          recentPeers.map((peer) => ({
            agent_id: peer.agent_id,
            name: null,
            software: null,
          })),
          limit,
        );

        const response = json({ agents });
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          agent_id: auth.agentId,
        });
        return response;
      }

      if (request.method === "GET" && url.pathname === "/v1/stats") {
        const auth = await authenticateRequest(request, env);
        if (auth instanceof Response) {
          const errorCode = await getErrorCode(auth);
          log({
            route: url.pathname,
            method: request.method,
            status_code: auth.status,
            duration_ms: nowMs() - startedAtMs,
            error_code: errorCode,
          });
          return auth;
        }

        const response = json(await auth.mailbox.getStats());
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          agent_id: auth.agentId,
        });
        return response;
      }

      if (request.method === "GET" && url.pathname === "/public/stats") {
        const shardIndexes = Array.from(
          { length: config.discoveryShardCount },
          (_, shardIndex) => shardIndex,
        );
        const minute = minuteEpochFromMs(nowMs());
        const snapshots = await Promise.all(
          shardIndexes.map((shardIndex) =>
            env.META_SHARD.getByName(metaShardObjectName(shardIndex)).getPublicStats(
              minute,
            ),
          ),
        );

        const minuteMap = new Map<number, number>();
        let totalAgents = 0;
        let acceptedOysTotal = 0;
        let acceptedOysLast1m = 0;
        let acceptedOysLast5m = 0;
        let acceptedOysLast60m = 0;

        for (const snapshot of snapshots) {
          totalAgents += snapshot.total_agents;
          acceptedOysTotal += snapshot.accepted_oys_total;
          acceptedOysLast1m += snapshot.accepted_oys_last_1m;
          acceptedOysLast5m += snapshot.accepted_oys_last_5m;
          acceptedOysLast60m += snapshot.accepted_oys_last_60m;

          for (const [timestamp, count] of snapshot.per_minute_last_60m) {
            minuteMap.set(timestamp, (minuteMap.get(timestamp) ?? 0) + count);
          }
        }

        const perMinuteLast60m = [...minuteMap.entries()].sort((left, right) => left[0] - right[0]);

        const response = json({
          total_agents: totalAgents,
          accepted_oys_total: acceptedOysTotal,
          accepted_oys_last_1m: acceptedOysLast1m,
          accepted_oys_last_5m: acceptedOysLast5m,
          accepted_oys_last_60m: acceptedOysLast60m,
          per_minute_last_60m: perMinuteLast60m,
          updated_at_ms: nowMs(),
        });
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
        });
        return response;
      }

      if (isApiOrPublicPath(url.pathname)) {
        const response = errorJson(404, "NOT_FOUND", "Route not found");
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          error_code: "NOT_FOUND",
        });
        return response;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const response = await env.ASSETS.fetch(request);
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
        });
        return response;
      }

      const response = errorJson(404, "NOT_FOUND", "Route not found");
      log({
        route: url.pathname,
        method: request.method,
        status_code: response.status,
        duration_ms: nowMs() - startedAtMs,
        error_code: "NOT_FOUND",
      });
      return response;
    } catch (error) {
      if (error instanceof ValidationError) {
        const response = errorJson(400, "INVALID_ARGUMENT", error.message);
        log({
          route: url.pathname,
          method: request.method,
          status_code: response.status,
          duration_ms: nowMs() - startedAtMs,
          error_code: "INVALID_ARGUMENT",
        });
        return response;
      }

      logError(url.pathname, error);
      const response = errorJson(500, "INTERNAL", "Internal server error");
      log({
        route: url.pathname,
        method: request.method,
        status_code: response.status,
        duration_ms: nowMs() - startedAtMs,
        error_code: "INTERNAL",
      });
      return response;
    }
  },
};

async function getErrorCode(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.clone().json() as { error?: { code?: string } };
    return payload.error?.code;
  } catch {
    return undefined;
  }
}

function isApiOrPublicPath(pathname: string): boolean {
  return pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname === "/public" ||
    pathname.startsWith("/public/");
}

async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<Response | { agentId: string; mailbox: DurableObjectStub<MailboxDO> }> {
  const parsed = parseBearerApiKey(request.headers.get("authorization"));
  if (!parsed) {
    return errorJson(401, "UNAUTHENTICATED", "Missing or invalid bearer token");
  }

  const mailbox = env.MAILBOX.getByName(mailboxObjectName(parsed.agentId));
  const auth = await mailbox.authenticate(parsed.secret);
  if (!auth.ok) {
    return errorJson(401, "UNAUTHENTICATED", "Invalid API key");
  }

  return {
    agentId: parsed.agentId,
    mailbox,
  };
}

async function sampleDiscoveryAgents(
  env: Env,
  shardCount: number,
  callerAgentId: string,
  seedAgents: PublicAgent[],
  limit: number,
): Promise<PublicAgent[]> {
  const results = new Map<string, PublicAgent>();

  for (const agent of seedAgents) {
    if (agent.agent_id === callerAgentId) {
      continue;
    }
    results.set(agent.agent_id, agent);
    if (results.size >= limit) {
      return [...results.values()].slice(0, limit);
    }
  }

  const shardIndexes = discoveryShardIndexes(callerAgentId, shardCount, shardCount);
  const excludeAgentIds = [callerAgentId, ...results.keys()];
  const shardResults = await Promise.all(
    shardIndexes.map((shardIndex) =>
      env.META_SHARD.getByName(metaShardObjectName(shardIndex)).sampleAgents(
        limit,
        excludeAgentIds,
      ),
    ),
  );

  for (const shardAgents of shardResults) {
    for (const agent of shardAgents) {
      if (agent.agent_id === callerAgentId || results.has(agent.agent_id)) {
        continue;
      }
      results.set(agent.agent_id, agent);
      if (results.size >= limit) {
        return [...results.values()].slice(0, limit);
      }
    }
  }

  return [...results.values()].slice(0, limit);
}
