import { claimHostEnrollment } from "@/lib/host-enrollment";

export async function handleHostEnrollment(request: Request, env: Cloudflare.Env): Promise<Response> {
  const respond = (body: object, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  const gate = await env.DB.prepare(
    "SELECT state FROM runtime_operation_gates WHERE key IN ('personal_metal_registration', 'platform_metal_registration') AND state = 'open' LIMIT 1",
  ).first<{ state: string }>();
  if (gate?.state !== "open") return respond({ error: "Server registration is not available yet" }, 503);
  const input = await request.json().catch(() => null) as { enrollmentToken?: unknown; credential?: unknown } | null;
  if (!input || typeof input.enrollmentToken !== "string" || typeof input.credential !== "string") {
    return respond({ error: "Invalid enrollment" }, 400);
  }
  const claim = await claimHostEnrollment(env.DB, input.enrollmentToken, input.credential);
  return claim ? respond(claim, 200) : respond({ error: "Enrollment expired, used, or revoked" }, 401);
}
