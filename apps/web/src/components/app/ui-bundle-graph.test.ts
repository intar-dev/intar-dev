import { describe, expect, it } from "vitest";
import {
  collectStaticImportClosure,
  staticChunkImports,
  subtractChunks,
} from "../../../scripts/check-ui-bundle";

describe("UI bundle static-import graph", () => {
  it("follows only static JavaScript imports through a chunk closure", () => {
    const chunks = new Map([
      [
        "App.hash.js",
        'import{shared}from"./shared.hash.js";const lazy=()=>import("./lazy.hash.js");',
      ],
      [
        "shared.hash.js",
        'import"./nested.hash.js";export{nested}from"./exported.hash.js";',
      ],
      ["nested.hash.js", "export const nested = true;"],
      ["exported.hash.js", "export const exported = true;"],
      ["lazy.hash.js", "export const lazy = true;"],
    ]);

    expect([...collectStaticImportClosure("App.hash.js", chunks)]).toEqual([
      "App.hash.js",
      "shared.hash.js",
      "exported.hash.js",
      "nested.hash.js",
    ]);
  });

  it("parses static imports and subtracts the shared App baseline", () => {
    expect(
      [...staticChunkImports('import"./side.hash.js";import("./lazy.hash.js");')],
    ).toEqual(["side.hash.js"]);

    expect(
      [
        ...subtractChunks(
          new Set(["App.hash.js", "route.hash.js"]),
          new Set(["App.hash.js"]),
        ),
      ],
    ).toEqual(["route.hash.js"]);
  });
});
