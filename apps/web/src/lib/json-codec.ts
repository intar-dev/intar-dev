export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export function parseJsonValue(raw: string | ArrayBuffer): JsonValue | null {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

export function parseJsonObject(raw: string | ArrayBuffer): JsonObject | null {
  return asJsonObject(parseJsonValue(raw));
}

export function parseJsonUnknown(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function getString(
  value: JsonObject,
  key: string,
): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export function getNullableString(
  value: JsonObject,
  key: string,
): string | null | undefined {
  const candidate = value[key];
  if (candidate === null) {
    return null;
  }
  return typeof candidate === "string" ? candidate : undefined;
}

export function getInteger(
  value: JsonObject,
  key: string,
): number | null {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return null;
  }
  return Math.floor(candidate);
}

export function getBoolean(
  value: JsonObject,
  key: string,
): boolean | null {
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : null;
}

export function getStringArray(
  value: JsonObject,
  key: string,
): string[] | null {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return null;
  }

  const strings = candidate.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return strings.length === candidate.length ? strings : null;
}
