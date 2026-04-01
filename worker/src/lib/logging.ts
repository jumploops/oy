import type { Env } from "./types";

interface RequestLogEvent {
  route: string;
  method: string;
  status_code: number;
  duration_ms: number;
  agent_id?: string;
  target_agent_id?: string;
  request_id?: string;
  message_id?: string;
  duplicate?: boolean;
  error_code?: string;
}

interface ErrorLogEvent {
  route: string;
  error_name: string;
  error_message: string;
}

interface LogMetadata {
  event_type: "request" | "unhandled_error";
  service: "oy-worker";
  deploy_env: string;
  deploy_version: string;
  deploy_git_sha?: string;
}

export function buildLogMetadata(
  env: Pick<Env, "CANONICAL_ORIGIN" | "DEPLOY_ENV" | "DEPLOY_VERSION" | "DEPLOY_GIT_SHA">,
): Omit<LogMetadata, "event_type"> {
  return stripUndefined({
    service: "oy-worker" as const,
    deploy_env: env.DEPLOY_ENV ?? inferDeployEnv(env.CANONICAL_ORIGIN),
    deploy_version: env.DEPLOY_VERSION ?? "unknown",
    deploy_git_sha: env.DEPLOY_GIT_SHA,
  });
}

export function logRequest(
  event: RequestLogEvent,
  metadata: Omit<LogMetadata, "event_type">,
): void {
  console.log(JSON.stringify(stripUndefined({
    event_type: "request",
    ...metadata,
    ...event,
  })));
}

export function logUnhandledError(
  route: string,
  error: unknown,
  metadata: Omit<LogMetadata, "event_type">,
): void {
  const normalized = normalizeError(error);
  const event: ErrorLogEvent & LogMetadata = {
    event_type: "unhandled_error",
    ...metadata,
    route,
    error_name: normalized.name,
    error_message: normalized.message,
  };
  console.error(JSON.stringify(stripUndefined(event)));
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

function inferDeployEnv(canonicalOrigin: string | undefined): string {
  if (!canonicalOrigin) {
    return "unknown";
  }

  try {
    const hostname = new URL(canonicalOrigin).hostname;
    if (hostname.endsWith(".test")) {
      return "test";
    }
  } catch {
    return "unknown";
  }

  return "production";
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) => entryValue !== undefined,
    ),
  ) as T;
}
