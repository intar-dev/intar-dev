import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ProviderCapabilities,
  ProviderOperationResult,
  ProviderRpcResult,
  ServiceErrorShape,
} from "@intar/provider-contracts";
import type {
  ConnectGcpProjectRequest,
  ConnectGcpProjectResult,
  RotateGcpCredentialRequest,
  RotateGcpCredentialResult,
  RunGcpOperationRequest,
} from "@intar/provider-contracts/gcp";
import {
  SerializedOperationQueue,
  assertConnectionId,
} from "@intar/provider-worker-core";
import { GCP_PROVIDER_CAPABILITIES } from "./capabilities";
import {
  connectProject as connectProjectWithProvider,
  rotateCredential as rotateCredentialWithProvider,
  runOperation as runProviderOperation,
} from "./provider";
import { safeUnknownError } from "./redaction";

export { GCP_PROVIDER_CAPABILITIES } from "./capabilities";

export class GcpConnectionDO extends DurableObject<Env> {
  readonly #operations = new SerializedOperationQueue();

  async #execute<T>(operation: () => Promise<T>): Promise<ProviderRpcResult<T>> {
    try {
      return { ok: true, value: await this.#operations.run(operation) };
    } catch (error) {
      return { ok: false, error: safeUnknownError(error) };
    }
  }

  connectProject(
    request: ConnectGcpProjectRequest,
  ): Promise<ProviderRpcResult<ConnectGcpProjectResult>> {
    return this.#execute(() =>
      connectProjectWithProvider(
        request,
        this.env.GCP_PROVIDER_CREDENTIAL_KEK_V1,
        this.env.GCP_CATALOG_API_KEY,
      ),
    );
  }

  rotateCredential(
    request: RotateGcpCredentialRequest,
  ): Promise<ProviderRpcResult<RotateGcpCredentialResult>> {
    return this.#execute(() =>
      rotateCredentialWithProvider(
        request,
        this.env.GCP_PROVIDER_CREDENTIAL_KEK_V1,
      ),
    );
  }

  runOperation(
    request: RunGcpOperationRequest,
  ): Promise<ProviderRpcResult<ProviderOperationResult>> {
    return this.#execute(() =>
      runProviderOperation(
        request,
        this.env.GCP_PROVIDER_CREDENTIAL_KEK_V1,
        this.env.GCP_CATALOG_API_KEY,
      ),
    );
  }
}

export class GcpProviderService extends WorkerEntrypoint<Env> {
  capabilities(): ProviderCapabilities<"gcp_compute"> {
    return GCP_PROVIDER_CAPABILITIES;
  }

  #connection(connectionId: string): DurableObjectStub<GcpConnectionDO> {
    assertConnectionId(connectionId);
    return this.env.GCP_CONNECTIONS.getByName(`gcp:${connectionId}`);
  }

  async #call<T>(
    connectionId: string,
    call: (connection: DurableObjectStub<GcpConnectionDO>) => PromiseLike<ProviderRpcResult<T>>,
  ): Promise<ProviderRpcResult<T>> {
    let connection: DurableObjectStub<GcpConnectionDO>;
    try {
      connection = this.#connection(connectionId);
    } catch (error) {
      return { ok: false, error: safeUnknownError(error) };
    }
    try {
      return await call(connection);
    } catch {
      return { ok: false, error: rpcUnavailableError() };
    }
  }

  connectProject(
    request: ConnectGcpProjectRequest,
  ): Promise<ProviderRpcResult<ConnectGcpProjectResult>> {
    return this.#call(request.connectionId, (connection) => connection.connectProject(request));
  }

  rotateCredential(
    request: RotateGcpCredentialRequest,
  ): Promise<ProviderRpcResult<RotateGcpCredentialResult>> {
    return this.#call(request.connectionId, (connection) => connection.rotateCredential(request));
  }

  runOperation(
    request: RunGcpOperationRequest,
  ): Promise<ProviderRpcResult<ProviderOperationResult>> {
    return this.#call(request.connectionId, (connection) => connection.runOperation(request));
  }
}

function rpcUnavailableError(): ServiceErrorShape {
  return {
    code: "provider_rpc_unavailable",
    message: "GCP provider coordination is temporarily unavailable",
    retryable: true,
  };
}

export default GcpProviderService;
