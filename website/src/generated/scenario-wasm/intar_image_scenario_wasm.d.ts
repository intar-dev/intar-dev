/* tslint:disable */
/* eslint-disable */

/**
 * Compute the build content hash for in-memory scenario files. Input is a
 * JSON string: `{ scenario_id, base_definition, kino_version, target_arch?,
 * entries: [{ path, content }] }`. Returns the hex hash, or throws.
 */
export function content_hash(input_json: string): string;

/**
 * Validate a scenario and compute everything a source-bundle upload needs:
 * `{ ok, errors, scenario_id, content_hash, kino_version, target_arch,
 * image_arch }`. The hash covers exactly one file, `scenario.hcl`, matching
 * how the in-app build endpoint assembles its bundle.
 */
export function prepare_build(scenario_hcl: string): string;

/**
 * Validate a scenario HCL document. Returns a JSON string:
 * `{ ok, errors: string[], preview: Scenario | null }`.
 */
export function validate(scenario_hcl: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly content_hash: (a: number, b: number) => [number, number, number, number];
    readonly prepare_build: (a: number, b: number) => [number, number];
    readonly validate: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
