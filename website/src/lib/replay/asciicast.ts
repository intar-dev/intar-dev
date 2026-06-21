import {
  GIF_EXPORT_FRAME_DELAY_QUANTUM_MS,
  GIF_EXPORT_MAX_FRAME_DELAY_MS,
  GIF_EXPORT_MIN_FRAME_DELAY_MS,
  GIF_EXPORT_TARGET_MAX_FRAMES,
  REPLAY_IDLE_TIME_LIMIT_SECONDS,
} from "@/lib/replay/config";

export interface ParsedAsciicastHeaderV2 {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  command?: string;
  env?: Record<string, string>;
}

export type ParsedAsciicastVisibleEvent =
  | {
      kind: "output";
      timeMs: number;
      data: string;
    }
  | {
      kind: "resize";
      timeMs: number;
      cols: number;
      rows: number;
    };

export interface ParsedAsciicastV2 {
  header: ParsedAsciicastHeaderV2;
  events: ParsedAsciicastVisibleEvent[];
}

export interface AsciicastRenderPlan {
  maxCols: number;
  maxRows: number;
  effectiveDurationMs: number;
  minFrameDelayMs: number;
  visibleEventCount: number;
  estimatedFrameCount: number;
}

export function parseAsciicastV2(content: string): ParsedAsciicastV2 {
  const lines = content
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error("cast file is empty");
  }

  const headerLine = lines[0];
  if (!headerLine) {
    throw new Error("cast file is empty");
  }

  const headerValue = JSON.parse(headerLine) as Record<string, unknown>;
  const version = Number(headerValue.version);
  const width = Number(headerValue.width);
  const height = Number(headerValue.height);
  const timestamp = Number(headerValue.timestamp ?? 0);

  if (version !== 2) {
    throw new Error(`unsupported asciicast version ${String(headerValue.version)}`);
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("cast header has invalid terminal dimensions");
  }
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("cast header has an invalid timestamp");
  }

  const header: ParsedAsciicastHeaderV2 = {
    version: 2,
    width,
    height,
    timestamp,
  };
  if (typeof headerValue.command === "string") {
    header.command = headerValue.command;
  }
  if (isStringMap(headerValue.env)) {
    header.env = headerValue.env;
  }

  const events: ParsedAsciicastVisibleEvent[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    if (!rawLine) {
      continue;
    }
    const rawEvent = JSON.parse(rawLine) as unknown;
    if (!Array.isArray(rawEvent) || rawEvent.length < 3) {
      throw new Error(`invalid event format on line ${lineNumber}`);
    }

    const [rawTime, rawKind, rawPayload] = rawEvent;
    const timeMs = Math.max(0, Number(rawTime) * 1000);
    if (!Number.isFinite(timeMs)) {
      throw new Error(`invalid event time on line ${lineNumber}`);
    }

    if (rawKind === "o") {
      if (typeof rawPayload !== "string") {
        throw new Error(`invalid output payload on line ${lineNumber}`);
      }
      if (rawPayload.length > 0) {
        events.push({
          kind: "output",
          timeMs,
          data: rawPayload,
        });
      }
      continue;
    }

    if (rawKind === "r") {
      if (typeof rawPayload !== "string") {
        throw new Error(`invalid resize payload on line ${lineNumber}`);
      }
      const resize = parseResize(rawPayload);
      if (!resize) {
        throw new Error(`invalid resize payload on line ${lineNumber}`);
      }
      events.push({
        kind: "resize",
        timeMs,
        cols: resize.cols,
        rows: resize.rows,
      });
    }
  }

  return { header, events };
}

export function prepareAsciicastRenderPlan(
  cast: ParsedAsciicastV2,
): AsciicastRenderPlan {
  let maxCols = cast.header.width;
  let maxRows = cast.header.height;
  let effectiveDurationMs = 0;
  let previousEventTimeMs = 0;

  for (const event of cast.events) {
    effectiveDurationMs += effectiveEventDelayMs(event.timeMs, previousEventTimeMs);
    previousEventTimeMs = event.timeMs;

    if (event.kind === "resize") {
      maxCols = Math.max(maxCols, event.cols);
      maxRows = Math.max(maxRows, event.rows);
    }
  }

  const targetDelayMs =
    effectiveDurationMs > 0
      ? roundUpToQuantum(
          effectiveDurationMs / GIF_EXPORT_TARGET_MAX_FRAMES,
          GIF_EXPORT_FRAME_DELAY_QUANTUM_MS,
        )
      : GIF_EXPORT_MIN_FRAME_DELAY_MS;

  const minFrameDelayMs = clamp(
    targetDelayMs,
    GIF_EXPORT_MIN_FRAME_DELAY_MS,
    GIF_EXPORT_MAX_FRAME_DELAY_MS,
  );

  const estimatedFrameCount = Math.max(
    1,
    cast.events.length === 0
      ? 1
      : Math.min(
          cast.events.length,
          Math.max(1, Math.ceil(effectiveDurationMs / minFrameDelayMs)),
        ),
  );

  return {
    maxCols,
    maxRows,
    effectiveDurationMs,
    minFrameDelayMs,
    visibleEventCount: cast.events.length,
    estimatedFrameCount,
  };
}

export function effectiveEventDelayMs(timeMs: number, previousTimeMs: number) {
  return Math.min(
    Math.max(0, timeMs - previousTimeMs),
    REPLAY_IDLE_TIME_LIMIT_SECONDS * 1000,
  );
}

export function quantizeFrameDelayMs(delayMs: number) {
  return roundUpToQuantum(delayMs, GIF_EXPORT_FRAME_DELAY_QUANTUM_MS);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundUpToQuantum(value: number, quantum: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return quantum;
  }
  return Math.ceil(value / quantum) * quantum;
}

function parseResize(value: string) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    return null;
  }

  return { cols, rows };
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
