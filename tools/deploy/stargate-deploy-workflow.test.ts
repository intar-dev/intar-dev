import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/stargate-deploy.yml"),
  "utf8",
);

describe("Stargate production workflow", () => {
  it("has no downgrade default and requires a valid tag for plan or apply", () => {
    const operationInput = workflow.slice(
      workflow.indexOf("operation:"),
      workflow.indexOf("release_tag:"),
    );
    const releaseInput = workflow.slice(
      workflow.indexOf("release_tag:"),
      workflow.indexOf("rollback_backup:"),
    );
    expect(operationInput).toContain("required: true");
    expect(releaseInput).toContain("required: false");
    expect(releaseInput).not.toContain("default:");
    expect(workflow).toContain(
      '[[ "${RELEASE_TAG}" =~ ^stargate/v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    );
  });

  it("keeps the drain gate, verified backup, and public checks", () => {
    expect(workflow).toContain("intar-stargate-production plan");
    expect(workflow).toContain("backup_id=");
    expect(workflow).toContain("sha256sum --check --strict");
    expect(workflow).toContain("https://ws.intar.app/healthz");
    expect(workflow).toContain(
      "Restore prior release after failed public verification",
    );
  });
});
