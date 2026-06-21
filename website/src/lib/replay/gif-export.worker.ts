/// <reference lib="webworker" />

import { GIFEncoder, applyPalette, quantize } from "gifenc";

import type {
  GifExportWorkerMessage,
  GifExportWorkerRequest,
} from "@/lib/replay/gif-export-types";

const workerScope = self as DedicatedWorkerGlobalScope;

let encoder: ReturnType<typeof GIFEncoder> | null = null;
let encodedFrames = 0;

workerScope.onmessage = (event: MessageEvent<GifExportWorkerRequest>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case "start": {
        encoder = GIFEncoder();
        encodedFrames = 0;
        return;
      }
      case "frame": {
        if (!encoder) {
          throw new Error("GIF encoder is not initialized");
        }

        const rgba = new Uint8ClampedArray(message.pixels);
        const palette = quantize(rgba, 256, { format: "rgb565" });
        const index = applyPalette(rgba, palette, "rgb565");
        const frameOptions =
          message.frameIndex === 0
            ? {
                palette,
                delay: message.delayMs,
                repeat: 0,
              }
            : {
                palette,
                delay: message.delayMs,
              };

        encoder.writeFrame(index, message.width, message.height, frameOptions);

        encodedFrames += 1;
        postWorkerMessage({
          type: "progress",
          encodedFrames,
        });
        return;
      }
      case "finish": {
        if (!encoder) {
          throw new Error("GIF encoder is not initialized");
        }

        encoder.finish();
        const bytes = encoder.bytes();
        const output = cloneArrayBuffer(bytes);

        postWorkerMessage(
          {
            type: "done",
            bytes: output,
          },
          [output],
        );
        encoder = null;
        encodedFrames = 0;
        return;
      }
      case "cancel": {
        encoder = null;
        encodedFrames = 0;
        postWorkerMessage({
          type: "cancelled",
        });
        return;
      }
    }
  } catch (error) {
    encoder = null;
    encodedFrames = 0;
    postWorkerMessage({
      type: "error",
      message:
        error instanceof Error ? error.message : "failed to encode GIF",
    });
  }
};

function postWorkerMessage(
  message: GifExportWorkerMessage,
  transfer?: Transferable[],
) {
  if (transfer) {
    workerScope.postMessage(message, transfer);
    return;
  }

  workerScope.postMessage(message);
}

function cloneArrayBuffer(view: Uint8Array) {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(view);
  return bytes.buffer;
}
