import { AppError, toErrorResponse } from "@/lib/app-error";
import { NO_STORE_HEADERS } from "@/lib/request-security";

export function accessInviteJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function accessInviteNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function accessInviteError(
  error: unknown,
  fallbackMessage: string,
): Response {
  const result = toErrorResponse(error, fallbackMessage);
  const headers = new Headers(NO_STORE_HEADERS);
  if (error instanceof AppError && error.status === 429) {
    headers.set("retry-after", "60");
  }
  return accessInviteJson(result.body, { status: result.status, headers });
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError({
      status: 400,
      code: "invalid_json",
      message: "a JSON object is required",
    });
  }
  return body as Record<string, unknown>;
}
