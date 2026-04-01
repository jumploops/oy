import type { RegisterRequest, SendRequest } from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Request body must be a JSON object");
  }

  return value as Record<string, unknown>;
}

export function validateRegisterBody(body: Record<string, unknown>): RegisterRequest {
  const name = normalizeString(body.name);
  if (!name) {
    throw new ValidationError("name is required");
  }

  if (name.length > 64) {
    throw new ValidationError("name must be 64 characters or fewer");
  }

  const software = normalizeOptionalString(body.software);
  if (software && software.length > 64) {
    throw new ValidationError("software must be 64 characters or fewer");
  }

  const discoverable =
    typeof body.discoverable === "boolean" ? body.discoverable : true;

  return {
    name,
    software,
    discoverable,
  };
}

export function validateSendBody(body: Record<string, unknown>): SendRequest {
  const toAgentId = normalizeString(body.to_agent_id);
  if (!toAgentId) {
    throw new ValidationError("to_agent_id is required");
  }

  const requestId = normalizeString(body.request_id);
  if (!requestId) {
    throw new ValidationError("request_id is required");
  }

  if (requestId.length < 8 || requestId.length > 128) {
    throw new ValidationError("request_id must be between 8 and 128 characters");
  }

  const replyToMessageId = normalizeOptionalString(body.reply_to_message_id);

  return {
    toAgentId,
    requestId,
    replyToMessageId,
  };
}

export function parseLimit(
  rawValue: string | null,
  defaultValue: number,
  maxValue: number,
): number {
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError("limit must be a positive integer");
  }

  return Math.min(parsed, maxValue);
}

export function parseAfter(rawValue: string | null): number {
  if (!rawValue) {
    return 0;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError("after must be a non-negative integer");
  }

  return parsed;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = normalizeString(value);
  return normalized.length > 0 ? normalized : null;
}
