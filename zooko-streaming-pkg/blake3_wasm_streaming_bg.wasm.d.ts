/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const alloc: (a: number) => number;
export const dealloc: (a: number, b: number) => void;
export const hash_subtree_cv_bytes: (a: number, b: number, c: number, d: number) => [number, number];
export const hash_subtree_cv_from_ptr: (a: number, b: number, c: number, d: number, e: number) => void;
export const hash_whole_message_root_bytes: (a: number, b: number) => [number, number];
export const hash_whole_message_root_from_ptr: (a: number, b: number, c: number) => void;
export const out_len: () => number;
export const parent_cv_bytes: (a: number, b: number, c: number, d: number) => [number, number];
export const parent_cv_from_ptrs: (a: number, b: number, c: number) => void;
export const root_hash_bytes: (a: number, b: number, c: number, d: number) => [number, number];
export const root_hash_from_ptrs: (a: number, b: number, c: number) => void;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
