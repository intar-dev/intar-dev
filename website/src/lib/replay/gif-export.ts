import { Terminal, type IBufferCell } from "@xterm/xterm";

import {
  effectiveEventDelayMs,
  parseAsciicastV2,
  prepareAsciicastRenderPlan,
  quantizeFrameDelayMs,
  type ParsedAsciicastVisibleEvent,
} from "@/lib/replay/asciicast";
import {
  ASCIINEMA_THEME_PALETTE,
  GIF_EXPORT_FINAL_FRAME_DELAY_MS,
  GIF_EXPORT_MAX_WIDTH_PX,
  GIF_EXPORT_MIN_PLAYABLE_DELAY_MS,
  REPLAY_TERMINAL_FONT_FAMILY,
  REPLAY_TERMINAL_FONT_SIZE_PX,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_PADDING_PX,
} from "@/lib/replay/config";
import type {
  GifExportProgress,
  GifExportWorkerMessage,
  GifExportWorkerRequest,
} from "@/lib/replay/gif-export-types";

export interface ExportAsciicastGifOptions {
  signal?: AbortSignal;
  onProgress?: (progress: GifExportProgress) => void;
}

interface CanvasSurface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

interface RenderSurface {
  surface: CanvasSurface;
  pixelWidth: number;
  pixelHeight: number;
  logicalWidth: number;
  logicalHeight: number;
  cellWidth: number;
  rowHeight: number;
  textAscent: number;
  scale: number;
}

interface BufferedFrame {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

export async function exportAsciicastGif(
  content: string,
  options: ExportAsciicastGifOptions = {},
) {
  const reportProgress = options.onProgress ?? (() => {});
  const signal = options.signal;

  throwIfAborted(signal);
  reportProgress({
    phase: "preparing",
    progress: 0.05,
    detail: "Parsing recording",
    completedFrames: 0,
    totalFrames: 1,
  });

  const cast = parseAsciicastV2(content);
  const plan = prepareAsciicastRenderPlan(cast);

  await ensureReplayFontsReady();
  throwIfAborted(signal);

  const renderSurface = createRenderSurface(plan.maxCols, plan.maxRows);
  const terminal = new Terminal({
    allowTransparency: false,
    cols: cast.header.width,
    rows: cast.header.height,
    drawBoldTextInBrightColors: true,
    fontFamily: REPLAY_TERMINAL_FONT_FAMILY,
    fontSize: REPLAY_TERMINAL_FONT_SIZE_PX,
    lineHeight: REPLAY_TERMINAL_LINE_HEIGHT,
    scrollback: 0,
  });

  const workerClient = new GifWorkerClient();
  workerClient.start();

  const abortListener = () => {
    workerClient.cancel();
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  try {
    let previousEventTimeMs = 0;
    let elapsedSinceCapturedFrameMs = 0;
    let currentFrame: BufferedFrame | null = null;
    let currentCols = cast.header.width;
    let currentRows = cast.header.height;
    let pendingEvents: ParsedAsciicastVisibleEvent[] = [];
    let processedEvents = 0;
    let encodedFrames = 0;

    const captureCurrentFrame = async (delayMs: number) => {
      throwIfAborted(signal);
      const frame = renderTerminalFrame(
        terminal,
        renderSurface,
        currentCols,
        currentRows,
      );

      if (currentFrame) {
        reportProgress({
          phase: "encoding",
          progress:
            plan.visibleEventCount > 0
              ? 0.15 + 0.75 * (processedEvents / plan.visibleEventCount)
              : 0.85,
          detail: `Encoding frame ${Math.min(encodedFrames + 1, plan.estimatedFrameCount)} of ${plan.estimatedFrameCount}`,
          completedFrames: encodedFrames,
          totalFrames: plan.estimatedFrameCount,
        });

        await workerClient.writeFrame({
          frameIndex: encodedFrames,
          width: currentFrame.width,
          height: currentFrame.height,
          delayMs: normalizeGifDelay(delayMs),
          pixels: toArrayBuffer(currentFrame.pixels),
        });
        encodedFrames += 1;
      }

      currentFrame = frame;
    };

    reportProgress({
      phase: "rendering",
      progress: 0.1,
      detail:
        plan.visibleEventCount > 0
          ? `Rendering recording frames`
          : "Rendering initial terminal frame",
      completedFrames: 0,
      totalFrames: plan.estimatedFrameCount,
    });

    for (const event of cast.events) {
      const effectiveDelayMs = effectiveEventDelayMs(
        event.timeMs,
        previousEventTimeMs,
      );
      previousEventTimeMs = event.timeMs;

      if (currentFrame) {
        elapsedSinceCapturedFrameMs += effectiveDelayMs;
      }

      pendingEvents.push(event);

      const shouldCapture =
        currentFrame === null ||
        elapsedSinceCapturedFrameMs >= plan.minFrameDelayMs;

      if (!shouldCapture) {
        continue;
      }

      const processedBatchCount = pendingEvents.length;
      for (const pendingEvent of pendingEvents) {
        if (pendingEvent.kind === "output") {
          await writeTerminal(terminal, pendingEvent.data);
        } else {
          terminal.resize(pendingEvent.cols, pendingEvent.rows);
          currentCols = pendingEvent.cols;
          currentRows = pendingEvent.rows;
        }
      }
      pendingEvents = [];
      processedEvents += processedBatchCount;

      reportProgress({
        phase: "rendering",
        progress:
          plan.visibleEventCount > 0
            ? 0.1 + 0.5 * (processedEvents / plan.visibleEventCount)
            : 0.6,
        detail: `Rendering frame ${Math.min(processedEvents, plan.estimatedFrameCount)} of ${plan.estimatedFrameCount}`,
        completedFrames: encodedFrames,
        totalFrames: plan.estimatedFrameCount,
      });

      await captureCurrentFrame(elapsedSinceCapturedFrameMs);
      elapsedSinceCapturedFrameMs = 0;
    }

    if (pendingEvents.length > 0) {
      for (const pendingEvent of pendingEvents) {
        if (pendingEvent.kind === "output") {
          await writeTerminal(terminal, pendingEvent.data);
        } else {
          terminal.resize(pendingEvent.cols, pendingEvent.rows);
          currentCols = pendingEvent.cols;
          currentRows = pendingEvent.rows;
        }
      }

      processedEvents = plan.visibleEventCount;
      await captureCurrentFrame(elapsedSinceCapturedFrameMs);
      elapsedSinceCapturedFrameMs = 0;
    }

    if (!currentFrame) {
      currentFrame = renderTerminalFrame(
        terminal,
        renderSurface,
        currentCols,
        currentRows,
      );
    }

    reportProgress({
      phase: "finalizing",
      progress: 0.95,
      detail: "Finalizing GIF",
      completedFrames: encodedFrames,
      totalFrames: plan.estimatedFrameCount,
    });

    await workerClient.writeFrame({
      frameIndex: encodedFrames,
      width: currentFrame.width,
      height: currentFrame.height,
      delayMs: GIF_EXPORT_FINAL_FRAME_DELAY_MS,
      pixels: toArrayBuffer(currentFrame.pixels),
    });

    const bytes = await workerClient.finish();
    reportProgress({
      phase: "finalizing",
      progress: 1,
      detail: "GIF ready",
      completedFrames: encodedFrames + 1,
      totalFrames: Math.max(plan.estimatedFrameCount, encodedFrames + 1),
    });

    return new Blob([bytes], { type: "image/gif" });
  } finally {
    signal?.removeEventListener("abort", abortListener);
    workerClient.dispose();
    terminal.dispose();
  }
}

function createRenderSurface(maxCols: number, maxRows: number): RenderSurface {
  const measurementSurface = createCanvasSurface(1, 1);
  const measurementContext = measurementSurface.context;
  measurementContext.font = `${REPLAY_TERMINAL_FONT_SIZE_PX}px ${REPLAY_TERMINAL_FONT_FAMILY}`;
  const metrics = measurementContext.measureText("M");

  const cellWidth = Math.max(8, Math.ceil(metrics.width));
  const rowHeight = Math.ceil(
    REPLAY_TERMINAL_FONT_SIZE_PX * REPLAY_TERMINAL_LINE_HEIGHT,
  );
  const textAscent =
    metrics.actualBoundingBoxAscent > 0
      ? Math.ceil(
          (rowHeight -
            (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)) /
            2 +
            metrics.actualBoundingBoxAscent,
        )
      : Math.ceil(rowHeight * 0.78);

  const logicalWidth =
    REPLAY_TERMINAL_PADDING_PX * 2 + maxCols * cellWidth;
  const logicalHeight =
    REPLAY_TERMINAL_PADDING_PX * 2 + maxRows * rowHeight;
  const scale =
    logicalWidth > GIF_EXPORT_MAX_WIDTH_PX
      ? GIF_EXPORT_MAX_WIDTH_PX / logicalWidth
      : 1;

  const pixelWidth = Math.max(1, Math.round(logicalWidth * scale));
  const pixelHeight = Math.max(1, Math.round(logicalHeight * scale));
  const surface = createCanvasSurface(pixelWidth, pixelHeight);
  surface.context.setTransform(scale, 0, 0, scale, 0, 0);
  surface.context.textAlign = "left";
  surface.context.textBaseline = "alphabetic";

  return {
    surface,
    pixelWidth,
    pixelHeight,
    logicalWidth,
    logicalHeight,
    cellWidth,
    rowHeight,
    textAscent,
    scale,
  };
}

function renderTerminalFrame(
  terminal: Terminal,
  surface: RenderSurface,
  currentCols: number,
  currentRows: number,
): BufferedFrame {
  const context = surface.surface.context;
  context.save();
  context.setTransform(surface.scale, 0, 0, surface.scale, 0, 0);
  context.fillStyle = ASCIINEMA_THEME_PALETTE.background;
  context.fillRect(0, 0, surface.logicalWidth, surface.logicalHeight);

  const buffer = terminal.buffer.active;
  const viewportY = buffer.viewportY;
  const nullCell = buffer.getNullCell();

  for (let rowIndex = 0; rowIndex < currentRows; rowIndex += 1) {
    const line = buffer.getLine(viewportY + rowIndex);
    if (!line) {
      continue;
    }

    const y = REPLAY_TERMINAL_PADDING_PX + rowIndex * surface.rowHeight;
    let runColor = ASCIINEMA_THEME_PALETTE.background;
    let runStart = 0;
    let runWidth = 0;

    for (let columnIndex = 0; columnIndex < currentCols; columnIndex += 1) {
      const cell = line.getCell(columnIndex, nullCell);
      const cellWidth = Math.max(1, cell?.getWidth() ?? 1);
      const background = cell
        ? resolveCellBackground(cell)
        : ASCIINEMA_THEME_PALETTE.background;

      if (columnIndex === 0) {
        runColor = background;
        runStart = 0;
        runWidth = cellWidth;
      } else if (background === runColor) {
        runWidth += cellWidth;
      } else {
        if (runColor !== ASCIINEMA_THEME_PALETTE.background) {
          context.fillStyle = runColor;
          context.fillRect(
            REPLAY_TERMINAL_PADDING_PX + runStart * surface.cellWidth,
            y,
            runWidth * surface.cellWidth,
            surface.rowHeight,
          );
        }

        runColor = background;
        runStart = columnIndex;
        runWidth = cellWidth;
      }
    }

    if (runWidth > 0 && runColor !== ASCIINEMA_THEME_PALETTE.background) {
      context.fillStyle = runColor;
      context.fillRect(
        REPLAY_TERMINAL_PADDING_PX + runStart * surface.cellWidth,
        y,
        runWidth * surface.cellWidth,
        surface.rowHeight,
      );
    }

    for (let columnIndex = 0; columnIndex < currentCols; columnIndex += 1) {
      const cell = line.getCell(columnIndex, nullCell);
      if (!cell || cell.getWidth() === 0 || cell.isInvisible()) {
        continue;
      }

      const chars = cell.getChars();
      if (!chars) {
        continue;
      }

      const fontStyle = cell.isItalic() ? "italic " : "";
      const fontWeight = cell.isBold() ? "700 " : "";
      context.font = `${fontStyle}${fontWeight}${REPLAY_TERMINAL_FONT_SIZE_PX}px ${REPLAY_TERMINAL_FONT_FAMILY}`;
      context.fillStyle = resolveCellForeground(cell);

      const x = REPLAY_TERMINAL_PADDING_PX + columnIndex * surface.cellWidth;
      const baseline = y + surface.textAscent;
      const maxWidth = Math.max(
        surface.cellWidth,
        surface.cellWidth * cell.getWidth(),
      );

      context.fillText(chars, x, baseline, maxWidth);

      if (cell.isUnderline()) {
        context.fillRect(x, y + surface.rowHeight - 2, maxWidth, 1);
      }
      if (cell.isStrikethrough()) {
        context.fillRect(x, y + Math.floor(surface.rowHeight / 2), maxWidth, 1);
      }
    }
  }

  context.restore();
  const pixels = context.getImageData(
    0,
    0,
    surface.pixelWidth,
    surface.pixelHeight,
  ).data;

  return {
    pixels: new Uint8ClampedArray(pixels),
    width: surface.pixelWidth,
    height: surface.pixelHeight,
  };
}

function resolveCellForeground(cell: IBufferCell) {
  let foreground = resolveCellColor(cell, "foreground");
  if (cell.isInverse()) {
    foreground = resolveCellColor(cell, "background");
  }
  if (cell.isDim()) {
    return withOpacity(foreground, 0.75);
  }
  return foreground;
}

function resolveCellBackground(cell: IBufferCell) {
  return cell.isInverse()
    ? resolveCellColor(cell, "foreground")
    : resolveCellColor(cell, "background");
}

function resolveCellColor(
  cell: IBufferCell,
  layer: "foreground" | "background",
) {
  const isDefault =
    layer === "foreground" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return layer === "foreground"
      ? ASCIINEMA_THEME_PALETTE.foreground
      : ASCIINEMA_THEME_PALETTE.background;
  }

  const isRgb = layer === "foreground" ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    const value = layer === "foreground" ? cell.getFgColor() : cell.getBgColor();
    return `#${value.toString(16).padStart(6, "0")}`;
  }

  const paletteIndex =
    layer === "foreground" ? cell.getFgColor() : cell.getBgColor();
  return resolvePaletteColor(paletteIndex);
}

function resolvePaletteColor(index: number) {
  if (index < ASCIINEMA_THEME_PALETTE.colors.length) {
    return ASCIINEMA_THEME_PALETTE.colors[index] ?? ASCIINEMA_THEME_PALETTE.foreground;
  }

  if (index >= 16 && index <= 231) {
    const colorIndex = index - 16;
    const r = Math.floor(colorIndex / 36);
    const g = Math.floor((colorIndex % 36) / 6);
    const b = colorIndex % 6;

    return rgbToHex(
      cubeChannelValue(r),
      cubeChannelValue(g),
      cubeChannelValue(b),
    );
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return rgbToHex(gray, gray, gray);
  }

  return ASCIINEMA_THEME_PALETTE.foreground;
}

function cubeChannelValue(index: number) {
  return index === 0 ? 0 : 55 + index * 40;
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function withOpacity(hexColor: string, opacity: number) {
  const alpha = Math.max(0, Math.min(1, opacity));
  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function createCanvasSurface(width: number, height: number): CanvasSurface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) {
      throw new Error("failed to create 2D render context");
    }
    return { canvas, context };
  }

  if (typeof document === "undefined") {
    throw new Error("canvas rendering is unavailable in this environment");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context) {
    throw new Error("failed to create 2D render context");
  }
  return { canvas, context };
}

function normalizeGifDelay(delayMs: number) {
  return Math.max(
    GIF_EXPORT_MIN_PLAYABLE_DELAY_MS,
    quantizeFrameDelayMs(delayMs),
  );
}

function toArrayBuffer(view: Uint8Array | Uint8ClampedArray) {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return bytes.buffer;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("The GIF export was aborted", "AbortError");
  }
}

function writeTerminal(terminal: Terminal, data: string) {
  return new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

async function ensureReplayFontsReady() {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return;
  }

  const fontFaceSet = document.fonts;
  await fontFaceSet.load(
    `${REPLAY_TERMINAL_FONT_SIZE_PX}px ${REPLAY_TERMINAL_FONT_FAMILY}`,
  );
  await fontFaceSet.ready;
}

class GifWorkerClient {
  private worker = new Worker(
    new URL("./gif-export.worker.ts", import.meta.url),
    { type: "module" },
  );

  private frameResolver: (() => void) | null = null;
  private finishResolver: ((bytes: ArrayBuffer) => void) | null = null;
  private rejectionHandler: ((reason?: unknown) => void) | null = null;

  constructor() {
    this.worker.onmessage = (
      event: MessageEvent<GifExportWorkerMessage>,
    ) => {
      const message = event.data;
      switch (message.type) {
        case "progress": {
          this.frameResolver?.();
          this.frameResolver = null;
          this.rejectionHandler = null;
          return;
        }
        case "done": {
          this.finishResolver?.(message.bytes);
          this.finishResolver = null;
          this.rejectionHandler = null;
          return;
        }
        case "cancelled": {
          this.rejectionHandler?.(
            new DOMException("The GIF export was aborted", "AbortError"),
          );
          this.frameResolver = null;
          this.finishResolver = null;
          this.rejectionHandler = null;
          return;
        }
        case "error": {
          const error = new Error(message.message);
          this.rejectionHandler?.(error);
          this.frameResolver = null;
          this.finishResolver = null;
          this.rejectionHandler = null;
          return;
        }
      }
    };
    this.worker.onerror = (event) => {
      this.rejectionHandler?.(
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "GIF worker failed"),
      );
      this.frameResolver = null;
      this.finishResolver = null;
      this.rejectionHandler = null;
    };
  }

  start() {
    this.postMessage({
      type: "start",
    });
  }

  writeFrame(frame: {
    frameIndex: number;
    width: number;
    height: number;
    delayMs: number;
    pixels: ArrayBuffer;
  }) {
    return new Promise<void>((resolve, reject) => {
      this.frameResolver = resolve;
      this.rejectionHandler = reject;
      this.postMessage(
        {
          type: "frame",
          ...frame,
        },
        [frame.pixels],
      );
    });
  }

  finish() {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.finishResolver = resolve;
      this.rejectionHandler = reject;
      this.postMessage({
        type: "finish",
      });
    });
  }

  cancel() {
    this.rejectionHandler?.(
      new DOMException("The GIF export was aborted", "AbortError"),
    );
    this.frameResolver = null;
    this.finishResolver = null;
    this.rejectionHandler = null;
    this.worker.terminate();
  }

  dispose() {
    this.worker.terminate();
  }

  private postMessage(
    message: GifExportWorkerRequest,
    transfer?: Transferable[],
  ) {
    if (transfer) {
      this.worker.postMessage(message, transfer);
      return;
    }

    this.worker.postMessage(message);
  }
}
