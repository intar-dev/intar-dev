import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportItemType, type TransportItem } from "@grafana/faro-web-sdk";
import { BlockableFetchTransport } from "./browser-telemetry-transport";

const item: TransportItem = {
  type: TransportItemType.EVENT,
  meta: {},
  payload: { name: "probe", timestamp: "2026-09-26T00:00:00Z", attributes: {} },
};

function transport() {
  const instance = new BlockableFetchTransport({ url: "https://collector.example/collect/app" });
  instance.metas = { value: {} } as BlockableFetchTransport["metas"];
  const logged = vi.fn();
  instance.internalLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logged, prefix: "" };
  return { instance, logged };
}

describe("blockable telemetry transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stops sending quietly once a content blocker rejects the collector", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    const { instance, logged } = transport();
    await instance.send([item]);
    const attempts = fetch.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    await instance.send([item]);
    await instance.send([item]);
    expect(fetch).toHaveBeenCalledTimes(attempts);
    expect(logged).not.toHaveBeenCalled();
  });

  it("keeps sending and logging when the collector answers with an error", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const { instance } = transport();
    await instance.send([item]);
    await instance.send([item]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
