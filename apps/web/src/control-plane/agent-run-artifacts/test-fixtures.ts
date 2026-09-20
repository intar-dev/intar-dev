import { drizzle } from "drizzle-orm/d1";
import { resolveRunVm } from "./storage";

/** Current runtime identity for artifact tests; historical read fixtures stay untouched. */
export async function seedArtifactRuntime(d1: D1Database, runId = "run-1") {
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO runtime_executions
      (id, user_id, host_id, domain_kind, domain_id, generation, state)
      SELECT run_id, user_id, host_id, 'scenario', run_id, 1,
        CASE WHEN state = 'completed' THEN 'archived' ELSE 'archiving' END
      FROM scenario_runs WHERE run_id = ?`,
      )
      .bind(runId),
    d1
      .prepare(
        `INSERT INTO runtime_vms
      (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256,
       cpu_millis, memory_mib, disk_mib, artifact_writes_sealed, archive_stage_rank)
      SELECT 'runtime-' || json_extract(vm.value, '$.id'), run.run_id,
        json_extract(vm.value, '$.id'), vm.key, json_extract(vm.value, '$.runtimeVmName'),
        '{}', ?, 1000, 512, 4096,
        CASE WHEN json_extract(vm.value, '$.phase') = 'completed' THEN 1 ELSE 0 END, 1
      FROM scenario_runs run, json_each(run.state_json, '$.vms') vm WHERE run.run_id = ?`,
      )
      .bind("a".repeat(64), runId),
    d1
      .prepare(
        "UPDATE scenario_runs SET runtime_execution_id = run_id WHERE run_id = ?",
      )
      .bind(runId),
  ]);
}

export async function platformArtifactFixture(d1: D1Database, vmName: string) {
  await d1.batch([
    d1.prepare(
      "UPDATE agent_hosts SET scope = 'platform', credential_generation = 1 WHERE id = 'host-1'",
    ),
    d1.prepare(
      "INSERT INTO agent_bootstrap_tokens (id,host_id,token_hash,credential_generation) VALUES ('artifact-fixture','host-1','fixture',1)",
    ),
  ]);
  await seedArtifactRuntime(d1);
  const runVm = await resolveRunVm({
    db: drizzle(d1),
    runId: "run-1",
    vmName,
    agent: {
      scope: "platform",
      credentialGeneration: 1,
      hostId: "host-1",
      userId: "user-1",
      role: "agent",
      betaSourceInviteId: null,
      betaSourceLeaseId: null,
      betaAdmissionGrantedAt: null,
    },
  });
  if (!runVm) throw new Error("missing artifact fixture");
  return runVm;
}
