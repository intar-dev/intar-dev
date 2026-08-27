import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = fileURLToPath(new URL("../..", import.meta.url));
const webPackageJson = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);
const astroConfig = fileURLToPath(
  new URL("../../../astro.config.ts", import.meta.url),
);
const rootLockfile = fileURLToPath(
  new URL("../../../../../bun.lock", import.meta.url),
);
const forbiddenReference = /codemirror/i;
const searchableExtensions = [".astro", ".css", ".json", ".jsonc", ".ts", ".tsx"];

describe("CodeMirror removal", () => {
  it("keeps CodeMirror out of the web package, source, config, and lockfile", async () => {
    const files = [
      webPackageJson,
      astroConfig,
      rootLockfile,
      ...(await sourceFiles(sourceDirectory)),
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");
      const match = contents.match(forbiddenReference);

      expect(
        match,
        `${relative(sourceDirectory, file)} still references CodeMirror`,
      ).toBeNull();
    }
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name !== "no-codemirror.test.ts" &&
      searchableExtensions.some((extension) => path.endsWith(extension))
    ) {
      files.push(path);
    }
  }

  return files;
}
