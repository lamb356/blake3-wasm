/* tslint:disable */
/* eslint-disable */

/**
 * Allocate raw bytes in Wasm linear memory and return the pointer.
 *
 * Intended usage:
 * - call this during init on one thread,
 * - keep the region for the lifetime of the hasher,
 * - let JS write directly into `memory.buffer` at this pointer.
 */
export function alloc(bytes: number): number;

/**
 * Free a region previously returned by `alloc`.
 *
 * `bytes` must match the original capacity passed to `alloc`.
 */
export function dealloc(ptr_u32: number, bytes: number): void;

export function hash_subtree_cv_bytes(input: Uint8Array, offset_lo: number, offset_hi: number): Uint8Array;

/**
 * Hash a legal non-root subtree at `input_offset` and write its 32-byte CV to `out_ptr`.
 *
 * Panics if the subtree is illegal for that offset; that is intentional, matching the
 * low-level core API contract.
 */
export function hash_subtree_cv_from_ptr(input_ptr: number, input_len: number, offset_lo: number, offset_hi: number, out_ptr: number): void;

export function hash_whole_message_root_bytes(input: Uint8Array): Uint8Array;

/**
 * Hash the entire message at `input_ptr,input_len` and write the final 32-byte root hash.
 *
 * This should only be used when the bytes at `input_ptr..input_ptr+input_len` are the
 * whole message, not an internal subtree.
 */
export function hash_whole_message_root_from_ptr(input_ptr: number, input_len: number, out_ptr: number): void;

export function out_len(): number;

export function parent_cv_bytes(left: Uint8Array, right: Uint8Array): Uint8Array;

/**
 * Merge two child CVs into a non-root parent CV.
 */
export function parent_cv_from_ptrs(left_ptr: number, right_ptr: number, out_ptr: number): void;

export function root_hash_bytes(left: Uint8Array, right: Uint8Array): Uint8Array;

/**
 * Merge two child CVs and finalize them as the root hash.
 */
export function root_hash_from_ptrs(left_ptr: number, right_ptr: number, out_ptr: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly alloc: (a: number) => number;
    readonly dealloc: (a: number, b: number) => void;
    readonly hash_subtree_cv_bytes: (a: number, b: number, c: number, d: number) => [number, number];
    readonly hash_subtree_cv_from_ptr: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly hash_whole_message_root_bytes: (a: number, b: number) => [number, number];
    readonly hash_whole_message_root_from_ptr: (a: number, b: number, c: number) => void;
    readonly out_len: () => number;
    readonly parent_cv_bytes: (a: number, b: number, c: number, d: number) => [number, number];
    readonly parent_cv_from_ptrs: (a: number, b: number, c: number) => void;
    readonly root_hash_bytes: (a: number, b: number, c: number, d: number) => [number, number];
    readonly root_hash_from_ptrs: (a: number, b: number, c: number) => void;
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
