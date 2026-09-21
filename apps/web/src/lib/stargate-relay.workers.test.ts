/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, drizzle, seedHost, seedRun, seedEnabledScenario, desiredRunningVm, resetHostRuntimeTestDatabase } from "@/control-plane/host-runtime-do/test-fixtures";
import { HOST_DESIRED_STATE_SCHEMA_VERSION } from "@/generated/constants";
const mocks=vi.hoisted(()=>({admin:vi.fn()}));
vi.mock("@/lib/stargate",()=>({stargateRelayAdminRequest:mocks.admin}));
import { refreshStargateHostRelay, revokeStargateHostRelayCredentials, loadStargateSshTransport } from "./stargate-relay";
import { loadOrCreateHostDesiredState } from "./desired-state-store";
const session={hostId:"host-1",sessionId:"session-1",credentialGeneration:1};
const target={host:{host_id:"host-1",session_id:"session-1",credential_generation:1},owner_id:"user-1",execution_id:"run-1",execution_generation:1,vm_id:"vm-1",service:"ssh"};

describe("host relay lease",()=>{
  beforeEach(async()=>{
    await resetHostRuntimeTestDatabase();vi.clearAllMocks();
    const now=Date.now();const db=drizzle(env.DB);
    await seedHost("host-1");await seedEnabledScenario(db,now);
    await seedRun({db,hostId:"host-1",runId:"run-1",now});
    await env.DB.prepare("UPDATE agent_hosts SET connected=1, connected_at=?1, active_session_id=?2 WHERE id=?3").bind(now-1_000,session.sessionId,session.hostId).run();
    await env.DB.prepare("UPDATE scenario_runs SET course_scope_key='public', course_id='linux-operations', lecture_id='01-broken-nginx' WHERE run_id='run-1'").run();
    const vm={...desiredRunningVm("run-1","runtime-web",now),vm_id:"vm-1",owner_user_id:"user-1",runtime_execution_id:"run-1",generation:1,lease_expires_at_unix_ms:now+300_000};
    await env.DB.prepare("INSERT INTO host_desired_state(host_id,version,doc_json,updated_at) VALUES(?1,1,?2,?3)").bind("host-1",JSON.stringify({schema_version:HOST_DESIRED_STATE_SCHEMA_VERSION,scope:"personal",owner_user_id:"user-1",host_id:"host-1",version:1,generated_at_unix_ms:now,cached_images:[],vms:[vm],builds:[]}),now).run();
    mocks.admin.mockImplementation(async(action,body)=>action==="grant"?Response.json({identity:body.identity,token:"1".repeat(64),websocket_url:"wss://gateway.example.test/v1/host-relay/ws",gateway_host_key_openssh:"ssh-ed25519 test",expires_at_unix_ms:body.expires_at_unix_ms}):new Response(null,{status:204}));
  });
  it("binds one host grant to current owner, control session, credentials, execution and VM",async()=>{
    const credentials=await refreshStargateHostRelay(session);
    expect(credentials?.identity).toEqual(target.host);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.admin.mock.calls[0]![1].targets).toEqual([target]);
    expect(mocks.admin.mock.calls[0]![1].expires_at_unix_ms-mocks.admin.mock.calls[0]![1].issued_at_unix_ms).toBe(120_000);
    expect(await loadStargateSshTransport({hostId:"host-1",ownerId:"user-1",executionId:"run-1",executionGeneration:1,vmId:"vm-1",directHost:"203.0.113.10",directPort:2222})).toEqual({kind:"relay",target});
  });
  it("relays organization member workloads after the enrollment creator loses access", async () => {
    await env.DB.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org-1','Org','org-1',1),('org-2','Other','org-2',1)").run();
    await env.DB.prepare("INSERT INTO user(id,name,email,banned,deleted_at) VALUES('creator','Creator','creator@example.test',1,1)").run();
    await env.DB.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member-1','org-1','user-1','member',1)").run();
    await env.DB.prepare("UPDATE agent_hosts SET scope='organization', organization_id='org-1', user_id='creator' WHERE id='host-1'").run();
    await env.DB.prepare("UPDATE scenario_runs SET organization_id='org-1' WHERE run_id='run-1'").run();
    await env.DB.prepare("UPDATE host_desired_state SET doc_json=json_set(doc_json,'$.scope','organization','$.owner_user_id','creator') WHERE host_id='host-1'").run();
    const state = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
    expect(state).toMatchObject({ scope: "organization", owner_user_id: "creator", vms: [{ owner_user_id: "user-1" }] });
    const transport = () => loadStargateSshTransport({hostId:"host-1",ownerId:"user-1",executionId:"run-1",executionGeneration:1,vmId:"vm-1",directHost:"203.0.113.10",directPort:2222});
    expect(await transport()).toEqual({ kind: "relay", target });
    await refreshStargateHostRelay(session);
    expect(mocks.admin.mock.calls.at(-1)![1].targets).toEqual([target]);
    for (const organizationId of ["org-2", null]) {
      await env.DB.prepare("UPDATE scenario_runs SET organization_id=? WHERE run_id='run-1'").bind(organizationId).run();
      await refreshStargateHostRelay(session);
      expect(mocks.admin.mock.calls.at(-1)![1].targets).toEqual([]);
      await expect(transport()).rejects.toThrow("organization relay target");
    }
    await env.DB.prepare("UPDATE scenario_runs SET organization_id='org-1' WHERE run_id='run-1'").run();
    await env.DB.prepare("DELETE FROM member WHERE id='member-1'").run();
    await refreshStargateHostRelay(session);
    expect(mocks.admin.mock.calls.at(-1)![1].targets).toEqual([]);
    await expect(transport()).rejects.toThrow("organization relay target");
    expect(await refreshStargateHostRelay({...session, sessionId: "stale"})).toBeNull();
    expect(mocks.admin).toHaveBeenLastCalledWith("revoke", {...target.host, session_id: "stale"});
  });

  it("removes a workload when its content or desired execution no longer permits access",async()=>{
    await env.DB.prepare("UPDATE vm_scenarios SET enabled=0 WHERE scenario_id='broken-nginx'").run();
    await refreshStargateHostRelay(session);
    expect(mocks.admin.mock.calls[0]![1].targets).toEqual([]);
    await env.DB.prepare("UPDATE vm_scenarios SET enabled=1 WHERE scenario_id='broken-nginx'").run();
    await env.DB.prepare("UPDATE host_desired_state SET doc_json=json_set(doc_json,'$.vms[0].generation',2)").run();
    await refreshStargateHostRelay(session);
    expect(mocks.admin.mock.calls[1]![1].targets).toEqual([]);
  });
  it("issues after the ordered session clock when reconnects share one millisecond", async () => {
    const now = Date.now();
    await env.DB.prepare("UPDATE agent_hosts SET connected_at = ? WHERE id = 'host-1'").bind(now + 1).run();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try { await refreshStargateHostRelay(session); } finally { clock.mockRestore(); }
    expect(mocks.admin.mock.calls[0]![1]).toMatchObject({
      session_started_at_unix_ms: now + 1, issued_at_unix_ms: now + 1,
    });
  });
  it("revokes the issued grant if access changes during the admin call",async()=>{
    const original=mocks.admin.getMockImplementation()!;
    mocks.admin.mockImplementation(async(action,body)=>{
      if(action==="grant")await env.DB.prepare("DELETE FROM access_allowlist WHERE user_id='user-1'").run();
      return original(action,body);
    });
    await expect(refreshStargateHostRelay(session)).rejects.toThrow("authorization changed");
    expect(mocks.admin).toHaveBeenLastCalledWith("revoke",target.host);
  });
  it("does not use the gateway for platform hosts, including a stale platform session",async()=>{
    await env.DB.prepare("UPDATE agent_hosts SET scope='platform'").run();
    expect(await refreshStargateHostRelay(session)).toBeNull();
    expect(await refreshStargateHostRelay({...session,sessionId:"old-session"})).toBeNull();
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("cannot issue for stale credentials and fences host-wide revocation by generation",async()=>{
    expect(await refreshStargateHostRelay({...session,credentialGeneration:2})).toBeNull();
    expect(mocks.admin).toHaveBeenLastCalledWith("revoke",{...target.host,credential_generation:2});
    await revokeStargateHostRelayCredentials({hostId:"host-1",credentialGeneration:1});
    expect(mocks.admin).toHaveBeenLastCalledWith("revoke-credentials",{host_id:"host-1",credential_generation:1});
  });
});
