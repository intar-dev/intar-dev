import { describe, expect, it } from "vitest";
import { machineBuildLogUrl, scenarioUrl } from "@/components/app/admin/scenario-revisions";
import { scenarioStartPath } from "@/components/app/lib/scenario-start";
import { courseLecturePath } from "@/components/app/pages/learn/course-wire";
import { guardCanonicalRequestPath, sensitiveRateLimitActionFor } from "@/lib/request-security";

// Paths the UI builds from ids that carry `/` or `:`. The Worker refuses any
// encoded path, so each must reach it as plain segments.
const scenarioId = "intar/broken-web";
const buildKey = `sha256:${"a".repeat(64)}`;
const paths = [
  scenarioStartPath(scenarioId),
  scenarioUrl(scenarioId),
  machineBuildLogUrl(buildKey),
  courseLecturePath({ scope: "public", courseId: "linux-basics", organizationId: null } as never, "01-intro.v2"),
];

describe("client-built API paths", () => {
  it.each(paths)("%s passes the canonical path guard", (path) => {
    const result = guardCanonicalRequestPath(new Request(`https://intar.test${path}`));
    expect(result).toMatchObject({ ok: true });
  });

  it("keeps the scenario start rate limit", () => {
    const request = new Request(`https://intar.test${scenarioStartPath(scenarioId)}`, { method: "POST" });
    expect(sensitiveRateLimitActionFor(request)).toBe("scenario-start");
  });
});
