/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { selectCandidateRevision } from "@/lib/machine-builds";
import { resetD1Database } from "@/test/d1-migrations";

const candidateOf = (id: string) => env.DB.prepare("SELECT candidate_rev FROM scenarios WHERE id = ?1").bind(id).first("candidate_rev");

describe("candidate revision", () => {
  beforeEach(resetD1Database);

  async function revision(rev: string, state: string, createdAt: number) {
    await env.DB.prepare(`INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
      VALUES ('intar/web', ?1, 3, '{}', ?2, ?3)`).bind(rev, state, createdAt).run();
  }
  const select = (rev: string) => selectCandidateRevision(env.DB, "intar/web", rev).run();

  it("is the newest revision once it is ready or verified, never an older one that settles later", async () => {
    await env.DB.prepare(`INSERT INTO scenarios (id, namespace, slug, scope_key, enabled, play)
      VALUES ('intar/web', 'intar', 'web', 'public', 1, 0)`).run();
    await revision("r1", "ready", 1);
    await revision("r2", "building", 2);
    await select("r1");
    expect(await candidateOf("intar/web")).toBeNull();
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = 'r2'").run();
    await select("r2");
    expect(await candidateOf("intar/web")).toBe("r2");
    await revision("r0", "ready", 0);
    await select("r0");
    expect(await candidateOf("intar/web")).toBe("r2");
    // A newer head that failed keeps the last candidate.
    await revision("r3", "failed", 3);
    await select("r3");
    expect(await candidateOf("intar/web")).toBe("r2");
    // Two revisions of one millisecond: the greater rev is the head.
    await revision("r5", "ready", 5);
    await revision("r4", "ready", 5);
    await select("r4");
    expect(await candidateOf("intar/web")).toBe("r2");
    await select("r5");
    expect(await candidateOf("intar/web")).toBe("r5");
  });
});
