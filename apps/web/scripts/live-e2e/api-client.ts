import { HttpError } from "./types";
import { parseResponseBody, parseResponseText } from "./utils";

export class ApiClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly cookie: string;

  constructor(baseUrl: string, cookie: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.origin = new URL(this.baseUrl).origin;
    this.cookie = cookie;
  }

  async json<T = unknown>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const response = await this.raw(path, init);
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new HttpError(`request failed: ${path}`, response.status, body);
    }
    return body as T;
  }

  async text(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    const response = await this.raw(path, init);
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(
        `request failed: ${path}`,
        response.status,
        parseResponseText(text),
      );
    }
    return text;
  }

  async raw(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookie);
    headers.set("accept", "application/json");
    // Astro's CSRF protection rejects form-like POSTs without a same-site
    // Origin; bodyless mutations (e.g. run destroy) need it explicitly.
    if ((init.method ?? "GET") !== "GET") {
      headers.set("origin", this.origin);
    }
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const requestInit: RequestInit = {
      method: init.method ?? "GET",
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.origin) {
      throw new Error(`refused cross-origin API request: ${url.origin}`);
    }
    return fetch(url, requestInit);
  }
}
