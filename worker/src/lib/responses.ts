export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
  };
}

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

export function errorJson(
  status: number,
  code: string,
  message: string,
): Response {
  const payload: ApiErrorPayload = {
    error: {
      code,
      message,
    },
  };
  return json(payload, { status });
}
