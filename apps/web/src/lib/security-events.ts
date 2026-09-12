import { isIP } from "node:net";

type SecurityEvent = {
  event:
    | "security.auth_request"
    | "security.session_created"
    | "security.request_rejected"
    | "security.agent_auth";
  outcome: "accepted" | "rejected" | "error";
  status?: number;
  userId?: string;
  admission?: "active" | "restricted";
};

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Keep attacker-controlled paths and authentication material out of audit logs. */
export function securityRoute(path: string): string {
  if (path.includes("%")) return "invalid-path";
  if (/^\/(?:api\/)?agent\/bootstrap$/u.test(path)) return "agent/bootstrap";
  if (/^\/(?:api\/)?agent\/connect$/u.test(path)) return "agent/connect";
  if (path.startsWith("/api/auth/")) {
    for (const operation of [
      "sign-in/social", "sign-in/sso", "sign-out", "get-session",
      "callback/github", "sso/callback", "oauth2/token", "oauth2/authorize",
      "oauth2/introspect", "oauth2/userinfo",
    ]) {
      if (path === `/api/auth/${operation}` || path.startsWith(`/api/auth/${operation}/`)) {
        return `auth/${operation}`;
      }
    }
    return "auth/other";
  }
  if (path.startsWith("/api/admin/")) return "admin";
  if (path.startsWith("/api/scenarios/")) return "scenarios";
  if (path.startsWith("/api/organizations/")) return "organizations";
  if (path.startsWith("/api/access/")) return "access";
  if (path.startsWith("/agent/")) return "agent";
  return path.startsWith("/api/") ? "api" : "page";
}

export function securityEventRecord(request: Request | undefined, event: SecurityEvent) {
  const ip = request?.headers.get("cf-connecting-ip")?.trim();
  const ray = request?.headers.get("cf-ray");
  const cf = request?.cf;
  return {
    schema_version: 1,
    event: event.event,
    outcome: event.outcome,
    ...(event.status === undefined ? {} : { http_status: event.status }),
    ...(event.admission ? { admission: event.admission } : {}),
    ...(event.userId && /^[a-zA-Z0-9_-]{1,128}$/u.test(event.userId)
      ? { user_id: event.userId } : {}),
    ...(request ? {
      route: securityRoute(new URL(request.url).pathname),
      method: METHODS.has(request.method) ? request.method : "OTHER",
    } : {}),
    ...(ip && isIP(ip) ? { client_ip: ip } : {}),
    ...(ray && /^[a-f0-9]{16}-[A-Z]{3}$/u.test(ray) ? { ray_id: ray } : {}),
    ...(typeof cf?.country === "string" && /^[A-Z]{2}$/u.test(cf.country)
      ? { client_country: cf.country } : {}),
    ...(typeof cf?.asn === "number" && Number.isSafeInteger(cf.asn)
      ? { client_asn: cf.asn } : {}),
  };
}

export function recordSecurityEvent(request: Request | undefined, event: SecurityEvent): void {
  const record = JSON.stringify(securityEventRecord(request, event));
  if (event.outcome === "accepted") console.info(record);
  else console.warn(record);
}

/** A 2xx auth response can start a redirect flow; session creation is separate. */
export function recordSecurityResponse(request: Request, response: Response): void {
  const route = securityRoute(new URL(request.url).pathname);
  let authRedirectError = false;
  if (route.startsWith("auth/") && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      try { authRedirectError = new URL(location, request.url).searchParams.has("error"); }
      catch { /* An invalid redirect cannot supply audit fields. */ }
    }
  }
  const outcome = response.status >= 500 ? "error"
    : response.status >= 400 || authRedirectError ? "rejected" : "accepted";
  const event = route.startsWith("auth/") && route !== "auth/get-session"
    ? "security.auth_request"
    : route === "agent/bootstrap" || route === "agent/connect"
    ? "security.agent_auth"
    : [401, 403, 429].includes(response.status) ? "security.request_rejected" : null;
  if (event) recordSecurityEvent(request, { event, outcome, status: response.status });
}
