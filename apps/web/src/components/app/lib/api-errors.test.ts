import { describe, expect, it } from "vitest";
import { apiErrorMessage, describeApiError, sentence } from "./api-errors";
import { HttpResponseError } from "./http-response-error";

const options = {
  fallback: "Couldn't save the organization. Try again.",
  fields: { name: /name/i, slug: /slug/i },
} as const;

describe("describeApiError", () => {
  it("says nothing when there is no error", () => {
    expect(describeApiError(null, options)).toBeNull();
    expect(apiErrorMessage(undefined, "Couldn't save.")).toBeNull();
  });

  it("routes a refusal to the field its message names and keeps the server's words", () => {
    const failure = describeApiError(
      HttpResponseError.fromBody(409, { error: "Organization name is taken" }, "x"),
      options,
    );
    expect(failure).toEqual({
      kind: "rejected",
      message: "Organization name is taken.",
      field: "name",
    });
  });

  it("matches the app's code as well as the message", () => {
    const failure = describeApiError(
      HttpResponseError.fromBody(400, { error: "Invalid", code: "invalid_slug" }, "x"),
      options,
    );
    expect(failure?.field).toBe("slug");
  });

  it("falls back to the default field for a 4xx that names none, and to the form without one", () => {
    const refusal = HttpResponseError.fromBody(422, { error: "Not allowed" }, "x");
    expect(describeApiError(refusal, { ...options, defaultField: "name" })?.field).toBe(
      "name",
    );
    expect(describeApiError(refusal, options)?.field).toBeNull();
  });

  it("keeps a permission refusal on the form", () => {
    const failure = describeApiError(
      HttpResponseError.fromBody(403, { error: "Only owners can do this" }, "x"),
      { ...options, defaultField: "name" },
    );
    expect(failure).toMatchObject({
      message: "Only owners can do this.",
      field: null,
    });
  });

  it("uses fixed wording where the server's text is not for people", () => {
    expect(
      describeApiError(new TypeError("Failed to fetch"), options),
    ).toMatchObject({ kind: "network", field: null });
    expect(
      describeApiError(new HttpResponseError(401, "unauthorized"), options)?.kind,
    ).toBe("signed-out");
    expect(
      describeApiError(new HttpResponseError(429, "slow down"), options)?.kind,
    ).toBe("rate-limited");
    expect(
      describeApiError(new HttpResponseError(503, "do binding"), options)?.kind,
    ).toBe("unavailable");
    const server = describeApiError(
      HttpResponseError.fromBody(500, { error: "SQLITE_ERROR: no such table" }, "x"),
      { ...options, defaultField: "name" },
    );
    expect(server).toMatchObject({ kind: "server", field: null });
    expect(server?.message).not.toContain("SQLITE");
  });

  it("keeps a server fault's words when the app wrote them for people", () => {
    expect(
      describeApiError(
        HttpResponseError.fromBody(
          503,
          { error: "Access revoked. Cleanup is pending. Try again." },
          "x",
        ),
        options,
      ),
    ).toMatchObject({
      kind: "unavailable",
      message: "Access revoked. Cleanup is pending. Try again.",
    });
    expect(
      describeApiError(
        HttpResponseError.fromBody(
          503,
          { error: "membership was removed", code: "organization_run_cleanup_pending" },
          "x",
        ),
        options,
      )?.message,
    ).toBe("Membership was removed.");
  });

  it("uses the fallback for a refusal with no words of its own", () => {
    const bare = new HttpResponseError(400, "Failed to rename (400)");
    expect(describeApiError(bare, options)?.message).toBe(
      "Couldn't save the organization. Try again.",
    );
    expect(
      describeApiError(HttpResponseError.fromBody(404, { error: "Not found" }, "x"), options)
        ?.message,
    ).toBe("That no longer exists. Refresh and try again.");
  });

  it("prefers the wording the page gives an app code", () => {
    const failure = describeApiError(
      HttpResponseError.fromBody(409, { error: "x", code: "last_server" }, "x"),
      { ...options, codes: { last_server: "This is your last server." } },
    );
    expect(failure?.message).toBe("This is your last server.");
  });

  it("routes an error the page raised itself by its words", () => {
    expect(
      describeApiError(new Error("Organization slug is invalid"), options),
    ).toMatchObject({ field: "slug", message: "Organization slug is invalid." });
  });

  it("never writes in the first person plural", () => {
    for (const status of [401, 429, 500, 503]) {
      expect(
        describeApiError(new HttpResponseError(status, "x"), options)?.message,
      ).not.toMatch(/\b(we|our|us)\b/i);
    }
    expect(describeApiError(new TypeError("Failed to fetch"), options)?.message).not.toMatch(
      /\b(we|our|us)\b/i,
    );
  });
});

describe("sentence", () => {
  it("capitalizes and ends the sentence once", () => {
    expect(sentence("name is taken")).toBe("Name is taken.");
    expect(sentence("Already there.")).toBe("Already there.");
    expect(sentence("Really?")).toBe("Really?");
  });
});
