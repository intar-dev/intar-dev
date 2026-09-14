import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function workflow(name: string): string {
  return readFileSync(resolve(repositoryRoot, ".github/workflows", name), "utf8");
}

function stepIndex(source: string, name: string): number {
  const index = source.indexOf("- name: " + name);
  expect(index, "missing step: " + name).toBeGreaterThan(-1);
  return index;
}

const deploy = workflow("website-deploy.yml");
const cutover = workflow("website-cutover.yml");
const website = workflow("website.yml");
const promotion = workflow("image-catalog-promotion.yml");

describe("registry cleanup deployment lane", () => {
  it("holds the collector before maintenance closes and before the migration", () => {
    const maintenance = stepIndex(deploy, "Enable maintenance for pending migrations");
    const drain = stepIndex(deploy, "Drain and recheck maintenance");
    const hold = stepIndex(deploy, "Hold the image registry collector before the migration");
    const migration = stepIndex(deploy, "Apply pending D1 migrations");
    // The gate route sits behind the maintenance fence, so the hold must run
    // while the control plane still serves, and the migration follows it.
    expect(maintenance).toBeGreaterThan(hold);
    expect(drain).toBeGreaterThan(hold);
    expect(migration).toBeGreaterThan(hold);
    const holdStep = deploy.slice(hold, maintenance);
    expect(holdStep).not.toContain("if: steps.migrations.outputs.pending");
    expect(holdStep).toContain("if: inputs.maintenance != 'off'");
    expect(holdStep).toContain("tools/deploy/registry-cleanup-gate.sh hold");
  });

  it("deploys the binding-free parent, then the collector, then the binding", () => {
    // A binding to a service that does not exist yet fails a Worker deploy, so
    // the first parent phase omits it. The order is the bootstrap order: the
    // parent MaintenanceState without the binding, the collector, the full
    // parent.
    const probe = stepIndex(deploy, "Inspect the image registry cleanup deployment");
    const bootstrapConfig = stepIndex(deploy, "Prepare the parent bootstrap configuration");
    const bootstrapDeploy = stepIndex(deploy, "Deploy the parent revision for the first cleanup rollout");
    const childDeploy = stepIndex(deploy, "Deploy the image registry cleanup worker");
    const fullParent = stepIndex(deploy, "Deploy production at 100 percent");
    expect(bootstrapConfig).toBeGreaterThan(probe);
    expect(bootstrapDeploy).toBeGreaterThan(bootstrapConfig);
    expect(childDeploy).toBeGreaterThan(bootstrapDeploy);
    expect(fullParent).toBeGreaterThan(childDeploy);
    expect(deploy).toContain("tools/deploy/deploy-registry-cleanup.sh");
    expect(deploy).toContain("REGISTRY_CLEANUP");
    expect(deploy).toContain("MAINTENANCE_FULL_DEPLOYMENT_CONFIG");
  });

  it("releases the collector after the parent gains the binding", () => {
    // The gate route lives on the parent, and the parent only carries the
    // binding to the collector once that collector exists. The release
    // therefore follows the full parent deploy.
    const release = stepIndex(deploy, "Release the image registry collector");
    const parentDeploy = stepIndex(deploy, "Deploy production at 100 percent");
    expect(release).toBeGreaterThan(parentDeploy);
    const step = deploy.slice(release, stepIndex(deploy, "Remove runtime secret file"));
    expect(step).toContain("if: always() && inputs.maintenance != 'on'");
    expect(step).toContain("tools/deploy/registry-cleanup-gate.sh release");
  });

  it("derives the cleanup mode from the tested artifact", () => {
    const childDeploy = stepIndex(deploy, "Deploy the image registry cleanup worker");
    const next = stepIndex(deploy, "Remove runtime secret file");
    const step = deploy.slice(childDeploy, next);
    // The mode is resolved once, against live state, and the deploy step reads
    // the resolved value from the job environment.
    expect(step).not.toContain("${{ inputs.registry_cleanup_mode }}");
    expect(step).toContain('case "${REGISTRY_CLEANUP_MODE}"');
    expect(step).toContain("dist/intar_dev_image_registry_cleanup/wrangler.json");
    expect(step).toContain("wrangler-${REGISTRY_CLEANUP_MODE}.json");
    expect(step).toContain(".vars.REGISTRY_CLEANUP_MODE = $mode");
    // The delete authority is gated by live state inside the deploy tool, not
    // by a repeated phrase in the lane.
    expect(step).not.toContain("ENABLE IMAGE REGISTRY CLEANUP DELETES");
    expect(step).toContain("tools/deploy/deploy-registry-cleanup.sh");
    expect(step).toContain("${DATABASE_ID}");
    expect(step).toContain('.r2_buckets[] | select(.binding == "VM_IMAGE_REGISTRY_BUCKET")');
  });

  it("resolves the mode against live state before anything deploys", () => {
    const inspect = stepIndex(deploy, "Inspect the image registry cleanup deployment");
    const hold = stepIndex(deploy, "Hold the image registry collector before the migration");
    const childDeploy = stepIndex(deploy, "Deploy the image registry cleanup worker");
    const step = deploy.slice(inspect, stepIndex(deploy, "Prepare the parent bootstrap configuration"));
    // A default of preserve must not downgrade a delete-capable collector, and
    // must not read an indeterminate probe as a first rollout.
    expect(step).toContain('REGISTRY_CLEANUP_INTENT: ${{ inputs.registry_cleanup_mode }}');
    expect(step).toContain("tools/deploy/registry-cleanup-state.sh");
    expect(step).toContain("preserve)");
    expect(step).toContain('resolved="${live_mode}"');
    expect(step).toContain('resolved="report-only"');
    expect(step).toContain("registry_cleanup_mode must be preserve, report-only, or delete");
    expect(step).toContain('printf \'REGISTRY_CLEANUP_MODE=%s\\n\' "${resolved}" >> "${GITHUB_ENV}"');
    expect(step).not.toContain("2>/dev/null");
    expect(hold).toBeGreaterThan(inspect);
    expect(childDeploy).toBeGreaterThan(hold);
    expect(deploy).toContain("registry-cleanup-mode.json");
  });

  it("runs the delete campaign after the release, and only in delete mode", () => {
    const release = stepIndex(deploy, "Release the image registry collector");
    const run = stepIndex(deploy, "Run the image registry cleanup to completion");
    const evidence = stepIndex(deploy, "Retain deployment evidence");
    expect(run).toBeGreaterThan(release);
    expect(evidence).toBeGreaterThan(run);
    const step = deploy.slice(run, stepIndex(deploy, "Remove runtime secret file"));
    // The campaign runs on the same condition as the release: a cutover keeps
    // the control plane closed, and its reopen releases and then runs.
    expect(step).toContain("if: always() && inputs.maintenance != 'on'");
    expect(step).toContain("env.REGISTRY_CLEANUP_MODE == 'delete'");
    expect(step).toContain("tools/deploy/registry-cleanup-gate.sh run delete");
    expect(step).toContain("registry-cleanup-run.json");
    // The run step must not carry the learner-run CLI rollout variable.
    expect(step).not.toContain("LEARNER_RUN_CLI_V1_ENFORCEMENT");
  });

  it("activates the D1 admission switch only for an explicit delete release", () => {
    const drained = stepIndex(cutover, "Verify the runtime cutover gate is drained");
    const checkout = stepIndex(cutover, "Checkout cutover revision");
    const activation = stepIndex(
      cutover,
      "Activate the D1 upload admission switch for a delete release",
    );
    const deployJob = cutover.indexOf("uses: ./.github/workflows/website-deploy.yml");
    // The registry API sits behind the maintenance fence, so the activation
    // belongs to the verify job: the drained check proves the plane still
    // serves there, and the deploy job is what closes it.
    expect(activation).toBeGreaterThan(drained);
    // It also needs the checkout, because it runs a repository script.
    expect(activation).toBeGreaterThan(checkout);
    expect(deployJob).toBeGreaterThan(activation);
    const step = cutover.slice(activation, stepIndex(cutover, "Verify the guest tools release run"));
    // Explicit mode only: the caller's input, never the resolved mode, so the
    // default preserve can not turn the switch on.
    expect(step).toContain(
      "if: inputs.operation == 'cutover' && inputs.registry_cleanup_mode == 'delete'",
    );
    expect(step).toContain("tools/deploy/registry-cleanup-activation.sh enforce");
    expect(step).toContain("REGISTRY_PUBLISH_TOKEN: ${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}");
    expect(step).toContain("registry-cleanup-activation.json");
    expect(step).not.toContain("LEARNER_RUN_CLI_V1_ENFORCEMENT");
    // A reopen runs after the cutover already activated the switch, and its
    // request would be fenced, so no reopen path carries the step.
    expect(step).toContain("inputs.operation == 'cutover'");
    expect(cutover).toContain("registry-cleanup-activation.json");
    // The web deploy workflow keeps no registry credential of its own.
    expect(deploy).not.toContain("INTAR_IMAGE_PUBLISH_TOKEN");
  });

  it("reports a report-only release as unchanged", () => {
    // The initial report-only deploy takes no activation: nothing there
    // deletes, and the step is scoped to an explicit delete release alone.
    const step = cutover.slice(
      stepIndex(cutover, "Activate the D1 upload admission switch for a delete release"),
      stepIndex(cutover, "Verify the guest tools release run"),
    );
    const condition = step
      .split("\n")
      .filter((line) => line.trim().startsWith("if:"))
      .join("\n");
    expect(condition).toContain("delete");
    // Neither the default mode nor a report-only request turns the switch on,
    // so an emergency D1 disable stays in force.
    expect(condition).not.toContain("preserve");
    expect(condition).not.toContain("report-only");
  });

  it("never couples the cleanup lane to the learner-run CLI rollout", () => {
    // The learner-run CLI variable selects an unrelated feature and stays off.
    // The only upload admission authority for this lane is the shared D1 row,
    // which the collector reports through its own status.
    for (const source of [deploy, cutover, website]) {
      expect(source).not.toContain("LEARNER_RUN_CLI_V1_ENFORCEMENT");
      expect(source).not.toContain("learner_run_cli");
    }
    expect(deploy).toContain("registry-cleanup-state.sh");
  });

  it("refuses an artifact without the auxiliary worker configuration", () => {
    const pin = stepIndex(deploy, "Pin and verify production configuration");
    const pinStep = deploy.slice(
      pin,
      stepIndex(deploy, "Inject the verified ABI 2 guest-tools pin"),
    );
    expect(pinStep).toContain('test -f "${cleanup_config}"');
    expect(pinStep).toContain("intar-dev-image-registry-cleanup");
    expect(pinStep).toContain("17 */6 * * *");
    // The built configuration normalises emptiness: Wrangler emits
    // "migrations": [] and a durable_objects object with no bindings, so a
    // comparison to null would refuse the artifact the build produces.
    expect(pinStep).toContain("(((.migrations // []) | length) == 0)");
    expect(pinStep).toContain("(((.durable_objects.bindings // []) | length) == 0)");
    expect(pinStep).not.toContain(".migrations == null");
    expect(pinStep).toContain(".assets == null");
  });

  it("retains the cleanup deployment and gate evidence", () => {
    for (const evidence of [
      "registry-cleanup-hold.json",
      "registry-cleanup-release.json",
      "registry-cleanup-deploy.json",
      "intar-registry-cleanup-deploy-",
      "intar-registry-cleanup-gate-",
    ]) {
      expect(deploy).toContain(evidence);
    }
  });
});

describe("cutover and reopen with the registry cleanup worker", () => {
  it("validates the cleanup mode with the other cutover inputs", () => {
    const validate = stepIndex(cutover, "Validate cutover inputs");
    const step = cutover.slice(
      validate,
      stepIndex(cutover, "Verify the runtime cutover gate is drained"),
    );
    expect(step).toContain(
      "registry_cleanup_mode must be preserve, report-only, or delete",
    );
    // A routine cutover must not silently downgrade a delete-capable collector.
    expect(step).toContain("preserve|report-only|delete");
    expect(step).toContain('REGISTRY_CLEANUP_MODE="${REGISTRY_CLEANUP_MODE:-preserve}"');
    expect(step).not.toContain("ENABLE IMAGE REGISTRY CLEANUP DELETES");
    expect(cutover).not.toContain("registry_cleanup_confirmation");
    expect(step).toContain("printf 'registry_cleanup_mode=%s");
    expect(cutover).toContain(
      "registry_cleanup_mode: ${{ steps.cutover-inputs.outputs.registry_cleanup_mode }}",
    );
    expect(cutover).toContain(
      "registry_cleanup_mode: ${{ needs.verify-release.outputs.registry_cleanup_mode }}",
    );
  });

  it("does not reopen while a registry cleanup run still holds the collector", () => {
    // A paused collector retires nothing and refuses no learner, so the reopen
    // does not hold it before the control plane serves again. The cutover lane
    // calls no gate script at all; the deploy lane releases the collector after
    // its maintenance-off deploy and proves no hold survives.
    expect(cutover).not.toContain("tools/deploy/registry-cleanup-gate.sh");
    expect(cutover).not.toContain("reopen-registry-cleanup.json");
    expect(cutover).not.toContain("intar-registry-cleanup-gate-");
    const deployJob = cutover.indexOf("uses: ./.github/workflows/website-deploy.yml");
    expect(deployJob).toBeGreaterThan(-1);
    expect(cutover.slice(deployJob)).toContain(
      "registry_cleanup_mode: ${{ needs.verify-release.outputs.registry_cleanup_mode }}",
    );
  });
});

describe("image catalog promotion and the registry cleanup", () => {
  it("waits for the cleanup the promotion endpoint owes before it finishes", () => {
    const promote = stepIndex(promotion, "Promote catalog");
    const verify = stepIndex(
      promotion,
      "Require the promoted catalog and no pending registry cleanup",
    );
    expect(verify).toBeGreaterThan(promote);
    const step = promotion.slice(promote, verify);
    expect(step).toContain(".catalog_promoted == true and .retry == true");
    expect(step).toContain("--write-out '%{http_code}'");
    expect(step).toContain("sleep 15");
    expect(step).toContain("The registry cleanup did not finish within fifteen minutes.");
    expect(step).not.toContain("--fail");
  });

  it("never opens the fleet gate", () => {
    expect(promotion).not.toContain('{"state":"open"}');
    expect(promotion).toContain('{"state":"drained"}');
    expect(promotion).toContain("intar-image-catalog-promotion");
  });
});

describe("website validation and the auxiliary worker artifact", () => {
  it("resolves the deployed auxiliary configuration from the build listing", () => {
    const check = stepIndex(website, "Verify the image registry cleanup worker artifact");
    const upload = stepIndex(website, "Upload tested deployment artifact");
    expect(upload).toBeGreaterThan(check);
    const step = website.slice(check, upload);
    expect(step).toContain(".wrangler/deploy/config.json");
    expect(step).toContain(".auxiliaryWorkers[].configPath");
    expect(step).toContain("../../dist/intar_dev_image_registry_cleanup/wrangler.json");
    expect(step).toContain("17 */6 * * *");
    expect(step).toContain("MaintenanceState");
    expect(step).toContain('.name == "intar-dev-image-registry-cleanup"');
  });

  it("resolves the auxiliary config against the directory that holds the listing", () => {
    // wrangler resolves a configPath against the directory holding the file
    // that names it, which is .wrangler/deploy. Joining it against the project
    // root lands on <repo>/dist, a directory that holds no such artifact, so the
    // step aborts and the deploy lane never gets its tested artifact.
    const check = stepIndex(website, "Verify the image registry cleanup worker artifact");
    const step = website.slice(check, stepIndex(website, "Upload tested deployment artifact"));
    expect(step).toContain("apps/web/.wrangler/deploy");
    expect(step).toContain(
      'cleanup_config="${GITHUB_WORKSPACE}/apps/web/.wrangler/deploy/${listed}"',
    );
    expect(step).not.toContain('cleanup_config="${GITHUB_WORKSPACE}/apps/web/${listed}"');

    // Resolve the join for real when a build listing exists, so a wrong base can
    // not stay green behind a text assertion.
    const listing = resolve(repositoryRoot, "apps/web/.wrangler/deploy/config.json");
    if (!existsSync(listing)) return;
    const config = JSON.parse(readFileSync(listing, "utf8")) as {
      auxiliaryWorkers?: { configPath?: string }[];
    };
    const expectedRelative =
      "../../dist/intar_dev_image_registry_cleanup/wrangler.json";
    const listed = (config.auxiliaryWorkers ?? []).map((entry) => entry.configPath);
    expect(listed).toContain(expectedRelative);
    const deployLanePath = resolve(
      repositoryRoot,
      "apps/web/dist/intar_dev_image_registry_cleanup/wrangler.json",
    );
    expect(existsSync(deployLanePath)).toBe(true);
    expect(
      resolve(resolve(listing, ".."), expectedRelative),
      "the listing base must be the directory holding config.json",
    ).toBe(deployLanePath);
  });

  it("names the same auxiliary directory in the build lane and the deploy lane", () => {
    expect(website).toContain("../../dist/intar_dev_image_registry_cleanup/wrangler.json");
    expect(deploy).toContain("dist/intar_dev_image_registry_cleanup/wrangler.json");
    expect(deploy).toContain('.vars.REGISTRY_CLEANUP_MODE == "report-only"');
    expect(website).toContain('.vars.REGISTRY_CLEANUP_MODE == "report-only"');
  });
});
