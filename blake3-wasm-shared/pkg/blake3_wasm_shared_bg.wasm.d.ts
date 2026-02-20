/* tslint:disable */
/* eslint-disable */
export const alloc_input: (a: number) => number;
export const chunk_len: () => number;
export const free_input: (a: number, b: number) => void;
export const hash_chunk: (a: number, b: number, c: bigint) => [number, number];
export const hash_single: (a: number, b: number) => [number, number];
export const hash_subtree: (a: number, b: number, c: bigint) => [number, number];
export const hash_subtree_ptr: (a: number, b: number, c: bigint) => [number, number];
export const left_subtree_len: (a: bigint) => bigint;
export const parent_cv: (a: number, b: number, c: number, d: number) => [number, number];
export const root_hash: (a: number, b: number, c: number, d: number) => [number, number];
export const __wbindgen_externrefs: WebAssembly.Table;
export const memory: WebAssembly.Memory;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
export const __wbindgen_start: (a: number) => void;
