import { describe, expect, it } from "vitest";
import {
  buildTemporaryNativeSshCommand,
  temporaryNativeSshKeyFilename,
} from "@/lib/native-ssh";
import { parseNativeSshSessionResponse } from "./NativeSshConnectPanel";

describe("native SSH response validation", () => {
  it("accepts the exact temporary route contract", () => {
    const response = temporarySessionResponse();

    expect(
      parseNativeSshSessionResponse(
        response as unknown as Record<string, unknown>,
      ),
    ).toEqual(response);
  });

  it.each([
    ["zero authorized keys", (value: MutableSessionResponse) => {
      value.native.authorizedKeyCount = 0;
    }],
    ["invalid port", (value: MutableSessionResponse) => {
      value.native.port = 0;
    }],
    ["mismatched username", (value: MutableSessionResponse) => {
      value.native.username = "another-route";
    }],
    ["unsafe filename", (value: MutableSessionResponse) => {
      value.native.keyFilename = "../../private.key";
    }],
    ["changed shell command", (value: MutableSessionResponse) => {
      value.native.command += "\necho changed";
    }],
  ])("rejects %s", (_label, change) => {
    const response = temporarySessionResponse();
    change(response);

    expect(() =>
      parseNativeSshSessionResponse(
        response as unknown as Record<string, unknown>,
      ),
    ).toThrow("native SSH session returned an invalid payload");
  });
});

interface MutableSessionResponse {
  routeUsername: string;
  expiresAt: number;
  native: {
    authMode: "issued_key";
    authorizedKeyCount: number;
    host: string;
    port: number;
    username: string;
    command: string;
    publicHostKeyOpenssh: string;
    publicHostKeyFingerprintSha256: string;
    knownHostsLine: string;
    keyFilename: string;
  };
}

function temporarySessionResponse(): MutableSessionResponse {
  const routeUsername = "run-web-ssh-issued";
  const host = "intar.app";
  const port = 22;
  const knownHostsLine = "intar.app ssh-ed25519 AAAATEST";
  const keyFilename = temporaryNativeSshKeyFilename(routeUsername);

  return {
    routeUsername,
    expiresAt: Date.now() + 60_000,
    native: {
      authMode: "issued_key",
      authorizedKeyCount: 1,
      host,
      port,
      username: routeUsername,
      command: buildTemporaryNativeSshCommand({
        username: routeUsername,
        host,
        port,
        knownHostsLine,
        keyFilename,
      }),
      publicHostKeyOpenssh: "ssh-ed25519 AAAATEST",
      publicHostKeyFingerprintSha256: "SHA256:test",
      knownHostsLine,
      keyFilename,
    },
  };
}
