import { describe, expect, it } from "vitest";
import {
  HttpResponseError,
  isAccessResponseError,
  pollingIntervalUnlessAccessError,
  retryHttpResponseError,
} from "./http-response-error";

describe("HTTP response errors", () => {
  it("identifies access failures without treating ordinary outages as access changes", () => {
    expect(isAccessResponseError(new HttpResponseError(401, "signed out"))).toBe(
      true,
    );
    expect(isAccessResponseError(new HttpResponseError(403, "revoked"))).toBe(
      true,
    );
    expect(isAccessResponseError(new HttpResponseError(404, "hidden"))).toBe(
      false,
    );
    expect(
      isAccessResponseError(new HttpResponseError(404, "hidden"), true),
    ).toBe(true);
    expect(isAccessResponseError(new HttpResponseError(503, "offline"))).toBe(
      false,
    );
  });

  it("does not retry access failures and bounds ordinary retries", () => {
    expect(retryHttpResponseError(0, new HttpResponseError(403, "revoked"))).toBe(
      false,
    );
    expect(retryHttpResponseError(0, new HttpResponseError(404, "hidden"))).toBe(
      false,
    );
    expect(retryHttpResponseError(2, new HttpResponseError(503, "offline"))).toBe(
      true,
    );
    expect(retryHttpResponseError(3, new HttpResponseError(503, "offline"))).toBe(
      false,
    );
  });

  it("stops access-denied polling but keeps ordinary recovery polling", () => {
    expect(
      pollingIntervalUnlessAccessError(
        new HttpResponseError(403, "revoked"),
        1_500,
      ),
    ).toBe(false);
    expect(
      pollingIntervalUnlessAccessError(
        new HttpResponseError(404, "hidden"),
        1_500,
      ),
    ).toBe(false);
    expect(
      pollingIntervalUnlessAccessError(
        new HttpResponseError(503, "offline"),
        1_500,
      ),
    ).toBe(1_500);
  });
});
