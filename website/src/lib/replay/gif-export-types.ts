export type GifExportPhase =
  | "preparing"
  | "rendering"
  | "encoding"
  | "finalizing";

export interface GifExportProgress {
  phase: GifExportPhase;
  progress: number;
  detail: string;
  completedFrames: number;
  totalFrames: number;
}

export type GifExportWorkerRequest =
  | {
      type: "start";
    }
  | {
      type: "frame";
      frameIndex: number;
      width: number;
      height: number;
      delayMs: number;
      pixels: ArrayBuffer;
    }
  | {
      type: "finish";
    }
  | {
      type: "cancel";
    };

export type GifExportWorkerMessage =
  | {
      type: "progress";
      encodedFrames: number;
    }
  | {
      type: "done";
      bytes: ArrayBuffer;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "cancelled";
    };
