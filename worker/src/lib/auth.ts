export interface ParsedApiKey {
  agentId: string;
  secret: string;
}

export function parseBearerApiKey(header: string | null): ParsedApiKey | null {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  if (!token.startsWith("oy.")) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [, agentId, secret] = parts;
  if (!agentId || !secret) {
    return null;
  }

  return { agentId, secret };
}
