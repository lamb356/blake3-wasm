/* tslint:disable */
/* eslint-disable */

export function alloc_input(size: number): number;

export function chunk_len(): number;

export function free_input(ptr: number, size: number): void;

export function hash_chunk(data: Uint8Array, chunk_index: bigint): Uint8Array;

export function hash_single(data: Uint8Array): Uint8Array;

export function hash_subtree(data: Uint8Array, input_offset: bigint): Uint8Array;

export function hash_subtree_ptr(ptr: number, size: number, input_offset: bigint): Uint8Array;

export function left_subtree_len(input_len: bigint): bigint;

export function parent_cv(left_cv: Uint8Array, right_cv: Uint8Array): Uint8Array;

export function root_hash(left_cv: Uint8Array, right_cv: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly alloc_input: (a: number) => number;
    readonly chunk_len: () => number;
    readonly free_input: (a: number, b: number) => void;
    readonly hash_chunk: (a: number, b: number, c: bigint) => [number, number];
    readonly hash_single: (a: number, b: number) => [number, number];
    readonly hash_subtree: (a: number, b: number, c: bigint) => [number, number];
    readonly hash_subtree_ptr: (a: number, b: number, c: bigint) => [number, number];
    readonly left_subtree_len: (a: bigint) => bigint;
    readonly parent_cv: (a: number, b: number, c: number, d: number) => [number, number];
    readonly root_hash: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
