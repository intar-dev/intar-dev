// `cuenv task md-links`: every relative link in a tracked Markdown file must
// name a file or directory that exists. Web links and #anchors are not checked.
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// The docs site's pages link by site route, not by file.
const SKIPPED = /^docs\/src\//;

/** The link targets in `markdown` that are paths in the repository. */
export function relativeLinks(markdown: string): string[] {
  const prose = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))/g)]
    .map((match) => (match[1] ?? match[2]).split("#")[0])
    .filter((target) => target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

/** `target`, as written in `file`, as a path from the repository root. */
export function resolve(file: string, target: string): string {
  const path = decodeURIComponent(target);
  return normalize(path.startsWith("/") ? path.slice(1) : join(dirname(file), path));
}

if (import.meta.main) {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"]);
  const files = listed.stdout.toString().split("\0").filter((file) => file && !SKIPPED.test(file));
  const broken: string[] = [];
  for (const file of files) {
    for (const target of relativeLinks(await Bun.file(file).text())) {
      if (!existsSync(resolve(file, target))) broken.push(`${file}: ${target}`);
    }
  }
  if (broken.length > 0) {
    console.error(`Markdown links to files that do not exist:\n${broken.join("\n")}`);
    process.exit(1);
  }
  console.log(`${files.length} Markdown files, no broken relative links.`);
}
