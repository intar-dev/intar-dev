import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshEd25519KeyPair } from "./ssh-ed25519";
import {
  buildTemporaryNativeSshRequestScope,
  clearAllTemporaryNativeSshKeys,
  loadTemporaryNativeSshKey,
  markTemporaryNativeSshKeyDownloaded,
  saveProvisionalTemporaryNativeSshKey,
  saveTemporaryNativeSshKey,
  TEMPORARY_NATIVE_SSH_STORAGE_PREFIX,
  temporaryNativeSshKeyWasDownloaded,
} from "./temporary-native-ssh-storage";

const keyPair: SshEd25519KeyPair = {
  publicKeyOpenssh: "ssh-ed25519 AAAATEST temporary@test",
  privateKeyOpenssh:
    "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n",
};

let storage: MemoryStorage;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-25T10:00:00.000Z"));
  storage = new MemoryStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
});

afterEach(() => {
  clearAllTemporaryNativeSshKeys();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildTemporaryNativeSshRequestScope", () => {
  it("binds a request to the signed-in user", () => {
    const request = {
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: '{"mode":"native"}',
    };

    expect(
      buildTemporaryNativeSshRequestScope({ userId: "user-a", ...request }),
    ).not.toBe(
      buildTemporaryNativeSshRequestScope({ userId: "user-b", ...request }),
    );
  });

  it("is stable for the same user and request", () => {
    const input = {
      userId: "user-a",
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: '{"mode":"native"}',
    };

    expect(buildTemporaryNativeSshRequestScope(input)).toBe(
      buildTemporaryNativeSshRequestScope({ ...input }),
    );
  });

  it("keeps a provisional key across reload logic and isolates accounts", () => {
    const request = {
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: '{"vmId":"vm-1"}',
    };
    const userA = buildTemporaryNativeSshRequestScope({
      userId: "user-a",
      ...request,
    });
    const userB = buildTemporaryNativeSshRequestScope({
      userId: "user-b",
      ...request,
    });

    expect(saveProvisionalTemporaryNativeSshKey(userA, keyPair)).toBe(true);
    expect(loadTemporaryNativeSshKey(userA)).toEqual(keyPair);
    expect(loadTemporaryNativeSshKey(userB)).toBeUndefined();
  });

  it("updates to the route expiry and removes the key on time", () => {
    const requestScope = buildTemporaryNativeSshRequestScope({
      userId: "user-a",
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: '{"vmId":"vm-1"}',
    });
    const expiresAt = Date.now() + 10_000;

    expect(
      saveTemporaryNativeSshKey({ requestScope, keyPair, expiresAt }),
    ).toBe(true);
    vi.advanceTimersByTime(10_000);

    expect(loadTemporaryNativeSshKey(requestScope)).toBeUndefined();
    expect(storage.keys()).not.toContainEqual(
      expect.stringContaining(TEMPORARY_NATIVE_SSH_STORAGE_PREFIX),
    );
  });

  it("keeps the download acknowledgement through route refresh", () => {
    const requestScope = buildTemporaryNativeSshRequestScope({
      userId: "user-a",
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: "{}",
    });
    expect(saveProvisionalTemporaryNativeSshKey(requestScope, keyPair)).toBe(
      true,
    );
    expect(markTemporaryNativeSshKeyDownloaded(requestScope)).toBe(true);
    expect(temporaryNativeSshKeyWasDownloaded(requestScope)).toBe(true);

    expect(
      saveTemporaryNativeSshKey({
        requestScope,
        keyPair,
        expiresAt: Date.now() + 60_000,
      }),
    ).toBe(true);

    expect(temporaryNativeSshKeyWasDownloaded(requestScope)).toBe(true);
  });

  it("does not shorten an existing route expiry during reissue", () => {
    const requestScope = buildTemporaryNativeSshRequestScope({
      userId: "user-a",
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: "{}",
    });
    expect(
      saveTemporaryNativeSshKey({
        requestScope,
        keyPair,
        expiresAt: Date.now() + 60 * 60_000,
      }),
    ).toBe(true);

    expect(saveProvisionalTemporaryNativeSshKey(requestScope, keyPair)).toBe(
      true,
    );
    vi.advanceTimersByTime(6 * 60_000);

    expect(loadTemporaryNativeSshKey(requestScope)).toEqual(keyPair);
  });

  it("clears every temporary key on sign-out and preserves other state", () => {
    const requestScope = buildTemporaryNativeSshRequestScope({
      userId: "user-a",
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: "{}",
    });
    storage.setItem("unrelated", "keep");
    expect(saveProvisionalTemporaryNativeSshKey(requestScope, keyPair)).toBe(
      true,
    );

    clearAllTemporaryNativeSshKeys();

    expect(storage.getItem("unrelated")).toBe("keep");
    expect(storage.keys()).toEqual(["unrelated"]);
  });

  it("reports storage denial without throwing", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("blocked");
      },
    });
    const requestScope = buildTemporaryNativeSshRequestScope({
      userId: "user-a",
      url: "/api/scenarios/runs/run-1/ssh",
      bodyJson: "{}",
    });

    expect(saveProvisionalTemporaryNativeSshKey(requestScope, keyPair)).toBe(
      false,
    );
    expect(loadTemporaryNativeSshKey(requestScope)).toBeUndefined();
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return this.keys()[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  keys() {
    return [...this.values.keys()];
  }
}
