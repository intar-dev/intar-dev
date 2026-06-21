declare module "asciinema-player" {
  export interface AsciinemaPlayerSource {
    url?: string | string[];
    data?:
      | string
      | ArrayBuffer
      | Response
      | Promise<string | ArrayBuffer | Response>;
    parser?: string;
  }

  export interface AsciinemaPlayerOptions {
    autoPlay?: boolean;
    controls?: boolean | "auto";
    preload?: boolean;
    fit?: "width" | "height" | "both" | "none";
    idleTimeLimit?: number;
    poster?: string;
    speed?: number;
    theme?: string;
    terminalFontFamily?: string;
    logger?: Console;
  }

  export interface AsciinemaPlayerInstance {
    el: Element;
    dispose: () => void;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    seek: (position: number) => Promise<void>;
    getCurrentTime: () => Promise<number>;
    getDuration: () => Promise<number>;
    addEventListener: (
      name: string,
      callback: (event: unknown) => void,
    ) => unknown;
  }

  export function create(
    source: string | AsciinemaPlayerSource,
    element: Element,
    options?: AsciinemaPlayerOptions,
  ): AsciinemaPlayerInstance;
}
