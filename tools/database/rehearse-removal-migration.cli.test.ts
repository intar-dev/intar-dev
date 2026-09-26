import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = join(
  repositoryRoot,
  "tools/database/rehearse-removal-migration.ts",
);
const fakeApi = join(
  repositoryRoot,
  "tools/database/rehearse-removal-migration.fake-d1.ts",
);

describe("rehearsal entrypoint", () => {
  test("runs the real CLI against the fake D1 REST API", () => {
    const root = mkdtempSync(join(tmpdir(), "intar-rehearsal-cli-"));
    const evidencePath = join(root, "evidence.json");
    const requestLog = join(root, "requests.json");
    try {
      const result = Bun.spawnSync(
        [
          "bun",
          "--preload",
          fakeApi,
          entrypoint,
          "--applied",
          "15",
          "--evidence",
          evidencePath,
        ],
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: "acct",
            CLOUDFLARE_API_TOKEN: "token",
            GITHUB_RUN_ID: "1",
            GITHUB_RUN_ATTEMPT: "1",
            REHEARSAL_REQUEST_LOG: requestLog,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = result.stderr.toString();
      expect(stderr).toBe("");
      expect(result.exitCode).toBe(0);

      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        databaseId: string;
        appliedTags: string[];
        baselineTags: string[];
        appliedMigrationCount: number;
        committedMigrationCount: number;
        foreignKeyViolations: number;
        scenarioCounts: number[];
      };
      expect(evidence.baselineTags).toHaveLength(15);
      expect(evidence.appliedTags).toEqual([
        "0015_parched_captain_marvel",
        "0016_salty_shiver_man",
        "0017_narrow_angel",
        "0018_exotic_deathbird",
        "0019_military_lightspeed",
        "0020_noisy_plazm",
        "0021_greedy_trish_tilby",
        "0022_petite_colleen_wing",
        "0023_fuzzy_mastermind",
        "0024_white_masque",
        "0025_cheerful_sway",
        "0026_groovy_doctor_octopus",
        "0027_real_big_bertha",
        "0028_married_rogue",
        "0029_powerful_zzzax",
        "0030_gifted_miek",
        "0031_open_mariko_yashida",
        "0032_cuddly_cloak",
        "0033_third_zeigeist",
        "0034_mean_doctor_octopus",
      ]);
      expect(evidence.appliedMigrationCount).toBe(35);
      expect(evidence.committedMigrationCount).toBe(35);
      expect(evidence.foreignKeyViolations).toBe(0);
      expect(evidence.scenarioCounts).toEqual([1, 1, 1]);

      const log = JSON.parse(readFileSync(requestLog, "utf8")) as {
        requests: string[];
        ledgerRows: number;
      };
      expect(log.requests[0]).toContain("POST");
      expect(log.requests.some((entry) => entry.includes("/query"))).toBe(true);
      // The disposable database is deleted in the entrypoint's finally block,
      // so the run leaves nothing behind.
      expect(log.requests.some((entry) => entry.startsWith("DELETE"))).toBe(true);
      expect(log.ledgerRows).toBe(35);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing evidence file", () => {
    const root = mkdtempSync(join(tmpdir(), "intar-rehearsal-cli-"));
    const evidencePath = join(root, "evidence.json");
    try {
      Bun.write(evidencePath, "{}\n");
      const result = Bun.spawnSync(
        [
          "bun",
          "--preload",
          fakeApi,
          entrypoint,
          "--applied",
          "14",
          "--evidence",
          evidencePath,
        ],
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: "acct",
            CLOUDFLARE_API_TOKEN: "token",
            GITHUB_RUN_ID: "1",
            GITHUB_RUN_ATTEMPT: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("evidence path already exists");
      expect(readFileSync(evidencePath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
