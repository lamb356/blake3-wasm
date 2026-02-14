/* tslint:disable */
/* eslint-disable */

/**
 * Returns the BLAKE3 chunk size (1024 bytes).
 */
export function chunk_len(): number;

/**
 * Hash one chunk (up to 1024 bytes) at the given chunk index.
 * Returns a 32-byte non-root chaining value.
 */
export function hash_chunk(data: Uint8Array, chunk_index: bigint): Uint8Array;

/**
 * Standard full hash for any input size (including single-chunk files).
 * Returns a 32-byte BLAKE3 hash.
 */
export function hash_single(data: Uint8Array): Uint8Array;

/**
 * Hash a multi-chunk subtree starting at the given byte offset.
 * This is the recommended Worker entry point — send each Worker a
 * slice of the file and its byte offset within the whole input.
 * Returns a 32-byte non-root chaining value.
 */
export function hash_subtree(data: Uint8Array, input_offset: bigint): Uint8Array;

/**
 * Returns the byte count for the left child subtree given the total input length.
 * Use this to correctly split input for tree hashing.
 */
export function left_subtree_len(input_len: bigint): bigint;

/**
 * Merge two child chaining values into a non-root parent chaining value.
 */
export function parent_cv(left_cv: Uint8Array, right_cv: Uint8Array): Uint8Array;

/**
 * Merge two child chaining values as the root node.
 * Returns the final 32-byte BLAKE3 hash.
 */
export function root_hash(left_cv: Uint8Array, right_cv: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly chunk_len: () => number;
    readonly hash_chunk: (a: number, b: number, c: bigint) => [number, number];
    readonly hash_single: (a: number, b: number) => [number, number];
    readonly hash_subtree: (a: number, b: number, c: bigint) => [number, number];
    readonly left_subtree_len: (a: bigint) => bigint;
    readonly parent_cv: (a: number, b: number, c: number, d: number) => [number, number];
    readonly root_hash: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
