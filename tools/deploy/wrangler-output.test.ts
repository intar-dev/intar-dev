import { describe, expect, it } from "vitest";

import { assertWranglerDeploy, parseWranglerNdjson } from "./wrangler-output";

const versionId = "11111111-2222-4333-8444-555555555555";
const session = {
  type: "wrangler-session",
  version: 1,
  wrangler_version: "4.118.0",
};

describe("structured Wrangler deployment output", () => {
  it("extracts the version created by a full deployment", () => {
    expect(
      assertWranglerDeploy(
        [
          session,
          {
            type: "deploy",
            version: 1,
            worker_name: "intar-dev",
            worker_name_overridden: false,
            worker_tag: "worker-tag",
            version_id: versionId,
            targets: ["https://intar.dev"],
          },
        ],
        "intar-dev",
      ),
    ).toEqual({ versionId });
  });

  it("rejects failed, duplicate, spoofed, and malformed full deployment events", () => {
    const deploy = {
      type: "deploy",
      version: 1,
      worker_name: "intar-dev",
      worker_name_overridden: false,
      version_id: versionId,
    };
    expect(() =>
      assertWranglerDeploy(
        [deploy, { type: "command-failed", version: 1 }],
        "intar-dev",
      ),
    ).toThrow(/failed command/);
    expect(() => assertWranglerDeploy([deploy, deploy], "intar-dev")).toThrow(
      /exactly one/,
    );
    expect(() =>
      assertWranglerDeploy([{ ...deploy, worker_name: "intar-dev.example" }], "intar-dev"),
    ).toThrow(/unexpected Worker/);
    expect(() =>
      assertWranglerDeploy([{ ...deploy, worker_name_overridden: true }], "intar-dev"),
    ).toThrow(/overrode/);
    expect(() =>
      assertWranglerDeploy([{ ...deploy, version_id: `${versionId}.example` }], "intar-dev"),
    ).toThrow(/lowercase UUID/);
  });

  it("parses a canonical session and deployment event without trusting session metadata", () => {
    const events = parseWranglerNdjson(
      `${JSON.stringify(session)}\n${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "intar-dev",
        worker_name_overridden: false,
        version_id: versionId,
      })}\n`,
    );
    expect(events).toHaveLength(2);
    expect(assertWranglerDeploy(events, "intar-dev")).toEqual({ versionId });
  });

  it("rejects invalid NDJSON and unsupported event versions", () => {
    expect(() => parseWranglerNdjson("\n")).toThrow(/must not be empty/);
    expect(() => parseWranglerNdjson('{"type":"wrangler-session"}\nnot-json\n')).toThrow(
      /line 2/,
    );
    expect(() =>
      assertWranglerDeploy(
        [
          {
            type: "deploy",
            version: 2,
            worker_name: "intar-dev",
            worker_name_overridden: false,
            version_id: versionId,
          },
        ],
        "intar-dev",
      ),
    ).toThrow(/unsupported/);
  });
});
