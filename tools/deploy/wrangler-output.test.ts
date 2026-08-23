import { describe, expect, it } from "vitest";

import {
  assertWranglerDeploy,
  assertWranglerVersionDeploy,
  assertWranglerVersionUpload,
  parseWranglerNdjson,
} from "./wrangler-output";

const versionId = "11111111-2222-4333-8444-555555555555";
const deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const session = {
  type: "wrangler-session",
  version: 1,
  wrangler_version: "4.118.0",
};

describe("structured Wrangler deployment output", () => {
  it("extracts an exact uploaded version", () => {
    expect(
      assertWranglerVersionUpload(
        [
          session,
          {
            type: "version-upload",
            version: 1,
            worker_name: "intar-dev",
            worker_name_overridden: false,
            version_id: versionId,
          },
        ],
        "intar-dev",
      ),
    ).toEqual({ versionId });
  });

  it("extracts the deployment identity without trusting version_traffic", () => {
    expect(
      assertWranglerVersionDeploy(
        [
          session,
          {
            type: "version-deploy",
            version: 1,
            worker_name: "intar-dev",
            deployment_id: deploymentId,
            version_traffic: {},
          },
        ],
        "intar-dev",
      ),
    ).toEqual({ deploymentId });
  });

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

  it("rejects failed, duplicate, spoofed, and malformed upload events", () => {
    const upload = {
      type: "version-upload",
      version: 1,
      worker_name: "intar-dev",
      worker_name_overridden: false,
      version_id: versionId,
    };
    expect(() =>
      assertWranglerVersionUpload(
        [upload, { type: "command-failed", version: 1 }],
        "intar-dev",
      ),
    ).toThrow(/failed command/);
    expect(() => assertWranglerVersionUpload([upload, upload], "intar-dev")).toThrow(
      /exactly one/,
    );
    expect(() =>
      assertWranglerVersionUpload([{ ...upload, worker_name: "intar-dev.example" }], "intar-dev"),
    ).toThrow(/unexpected Worker/);
    expect(() =>
      assertWranglerVersionUpload([{ ...upload, worker_name_overridden: true }], "intar-dev"),
    ).toThrow(/overrode/);
    expect(() =>
      assertWranglerVersionUpload([{ ...upload, version_id: `${versionId}.example` }], "intar-dev"),
    ).toThrow(/lowercase UUID/);
  });

  it("rejects failed, duplicate, spoofed, and malformed deploy events", () => {
    const deploy = {
      type: "version-deploy",
      version: 1,
      worker_name: "intar-dev",
      deployment_id: deploymentId,
      version_traffic: {},
    };
    expect(() =>
      assertWranglerVersionDeploy(
        [deploy, { type: "command-failed", version: 1 }],
        "intar-dev",
      ),
    ).toThrow(/failed command/);
    expect(() =>
      assertWranglerVersionDeploy([deploy, deploy], "intar-dev"),
    ).toThrow(/exactly one/);
    expect(() =>
      assertWranglerVersionDeploy(
        [{ ...deploy, worker_name: "intar-dev.example" }],
        "intar-dev",
      ),
    ).toThrow(/unexpected Worker/);
    expect(() =>
      assertWranglerVersionDeploy(
        [{ ...deploy, deployment_id: `${deploymentId}.example` }],
        "intar-dev",
      ),
    ).toThrow(/lowercase UUID/);
  });

  it("rejects failed, duplicate, and spoofed full deployment events", () => {
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
      assertWranglerDeploy(
        [{ ...deploy, worker_name_overridden: true }],
        "intar-dev",
      ),
    ).toThrow(/overrode/);
  });

  it("parses a canonical session and command event without trusting session metadata", () => {
    const events = parseWranglerNdjson(
      `${JSON.stringify(session)}\n${JSON.stringify({
        type: "version-deploy",
        version: 1,
        worker_name: "intar-dev",
        deployment_id: deploymentId,
        version_traffic: {},
      })}\n`,
    );
    expect(events).toHaveLength(2);
    expect(assertWranglerVersionDeploy(events, "intar-dev")).toEqual({
      deploymentId,
    });
  });

  it("rejects invalid NDJSON and unsupported event versions", () => {
    expect(() => parseWranglerNdjson("\n")).toThrow(/must not be empty/);
    expect(() => parseWranglerNdjson('{"type":"wrangler-session"}\nnot-json\n')).toThrow(
      /line 2/,
    );
    expect(() =>
      assertWranglerVersionDeploy(
        [
          {
            type: "version-deploy",
            version: 2,
            worker_name: "intar-dev",
            deployment_id: deploymentId,
          },
        ],
        "intar-dev",
      ),
    ).toThrow(/unsupported/);
  });
});
