export type D1Value = string | number | boolean | null;
export type D1Row = Record<string, D1Value>;

export interface D1Statement {
  readonly sql: string;
  readonly params?: readonly D1Value[];
}

export interface D1StatementResult {
  readonly rows: readonly D1Row[];
  readonly changes: number | null;
}

export interface D1ReadClient {
  query(sql: string, params?: readonly D1Value[]): Promise<D1StatementResult>;
  batchRead?(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]>;
}

export interface D1WriteClient extends D1ReadClient {
  batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]>;
}

interface ApiError {
  code?: number;
  message?: string;
}

interface ApiQueryResult {
  results?: D1Row[];
  success?: boolean;
  meta?: { changes?: number };
  error?: string;
}

interface ApiEnvelope {
  success?: boolean;
  result?: ApiQueryResult[];
  errors?: ApiError[];
  messages?: ApiError[];
}

export class CloudflareD1RestClient implements D1WriteClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(input: {
    accountId: string;
    databaseId: string;
    token: string;
    fetch?: typeof fetch;
  }) {
    this.#url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}/query`;
    this.#token = input.token;
    this.#fetch = input.fetch ?? fetch;
  }

  async query(
    sql: string,
    params: readonly D1Value[] = [],
  ): Promise<D1StatementResult> {
    const results = await this.#request([{ sql, params }], true);
    const result = results[0];
    if (!result) throw new Error("D1 returned no result for a query");
    return result;
  }

  async batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    if (statements.length === 0) return [];
    return this.#request(statements, false);
  }

  async batchRead(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    if (statements.length === 0) return [];
    return this.#request(statements, true);
  }

  async #request(
    statements: readonly D1Statement[],
    retryReads: boolean,
  ): Promise<readonly D1StatementResult[]> {
    const body = JSON.stringify(
      statements.length === 1
        ? statementBody(statements[0]!)
        : { batch: statements.map(statementBody) },
    );
    const attempts = retryReads ? 3 : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        throw new Error(`D1 request failed: ${errorMessage(error)}`);
      }

      const payload = await parseEnvelope(response);
      if (
        !response.ok &&
        attempt < attempts &&
        (response.status === 429 || response.status >= 500)
      ) {
        await backoff(attempt);
        continue;
      }

      if (!response.ok || payload.success !== true) {
        throw new Error(
          `D1 API rejected the request (${response.status}): ${formatErrors(payload)}`,
        );
      }

      const apiResults = payload.result;
      if (
        !Array.isArray(apiResults) ||
        apiResults.length !== statements.length
      ) {
        throw new Error(
          `D1 returned ${apiResults?.length ?? 0} results for ${statements.length} statements`,
        );
      }

      return apiResults.map((result, index) => {
        if (result.success !== true) {
          throw new Error(
            `D1 statement ${index + 1} failed: ${result.error ?? "unknown error"}`,
          );
        }
        return {
          rows: Array.isArray(result.results) ? result.results : [],
          changes:
            typeof result.meta?.changes === "number"
              ? result.meta.changes
              : null,
        };
      });
    }

    throw new Error("D1 request retry loop terminated unexpectedly");
  }
}

function statementBody(statement: D1Statement): {
  sql: string;
  params: readonly D1Value[];
} {
  return { sql: statement.sql, params: statement.params ?? [] };
}

async function parseEnvelope(response: Response): Promise<ApiEnvelope> {
  const text = await response.text();
  try {
    return JSON.parse(text) as ApiEnvelope;
  } catch {
    throw new Error(
      `D1 API returned a non-JSON response (${response.status}, ${text.length} bytes)`,
    );
  }
}

function formatErrors(payload: ApiEnvelope): string {
  const errors = [...(payload.errors ?? []), ...(payload.messages ?? [])]
    .map(({ code, message }) =>
      [code, message].filter((part) => part !== undefined).join(": "),
    )
    .filter(Boolean);
  return errors.join("; ") || "unknown API error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function backoff(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, attempt * 250));
}
