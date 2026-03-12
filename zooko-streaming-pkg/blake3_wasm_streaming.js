/* @ts-self-types="./blake3_wasm_streaming.d.ts" */

/**
 * Allocate raw bytes in Wasm linear memory and return the pointer.
 *
 * Intended usage:
 * - call this during init on one thread,
 * - keep the region for the lifetime of the hasher,
 * - let JS write directly into `memory.buffer` at this pointer.
 * @param {number} bytes
 * @returns {number}
 */
export function alloc(bytes) {
    const ret = wasm.alloc(bytes);
    return ret >>> 0;
}

/**
 * Free a region previously returned by `alloc`.
 *
 * `bytes` must match the original capacity passed to `alloc`.
 * @param {number} ptr_u32
 * @param {number} bytes
 */
export function dealloc(ptr_u32, bytes) {
    wasm.dealloc(ptr_u32, bytes);
}

/**
 * @param {Uint8Array} input
 * @param {number} offset_lo
 * @param {number} offset_hi
 * @returns {Uint8Array}
 */
export function hash_subtree_cv_bytes(input, offset_lo, offset_hi) {
    const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hash_subtree_cv_bytes(ptr0, len0, offset_lo, offset_hi);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Hash a legal non-root subtree at `input_offset` and write its 32-byte CV to `out_ptr`.
 *
 * Panics if the subtree is illegal for that offset; that is intentional, matching the
 * low-level core API contract.
 * @param {number} input_ptr
 * @param {number} input_len
 * @param {number} offset_lo
 * @param {number} offset_hi
 * @param {number} out_ptr
 */
export function hash_subtree_cv_from_ptr(input_ptr, input_len, offset_lo, offset_hi, out_ptr) {
    wasm.hash_subtree_cv_from_ptr(input_ptr, input_len, offset_lo, offset_hi, out_ptr);
}

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function hash_whole_message_root_bytes(input) {
    const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hash_whole_message_root_bytes(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Hash the entire message at `input_ptr,input_len` and write the final 32-byte root hash.
 *
 * This should only be used when the bytes at `input_ptr..input_ptr+input_len` are the
 * whole message, not an internal subtree.
 * @param {number} input_ptr
 * @param {number} input_len
 * @param {number} out_ptr
 */
export function hash_whole_message_root_from_ptr(input_ptr, input_len, out_ptr) {
    wasm.hash_whole_message_root_from_ptr(input_ptr, input_len, out_ptr);
}

/**
 * @returns {number}
 */
export function out_len() {
    const ret = wasm.out_len();
    return ret >>> 0;
}

/**
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {Uint8Array}
 */
export function parent_cv_bytes(left, right) {
    const ptr0 = passArray8ToWasm0(left, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(right, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.parent_cv_bytes(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Merge two child CVs into a non-root parent CV.
 * @param {number} left_ptr
 * @param {number} right_ptr
 * @param {number} out_ptr
 */
export function parent_cv_from_ptrs(left_ptr, right_ptr, out_ptr) {
    wasm.parent_cv_from_ptrs(left_ptr, right_ptr, out_ptr);
}

/**
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {Uint8Array}
 */
export function root_hash_bytes(left, right) {
    const ptr0 = passArray8ToWasm0(left, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(right, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.root_hash_bytes(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Merge two child CVs and finalize them as the root hash.
 * @param {number} left_ptr
 * @param {number} right_ptr
 * @param {number} out_ptr
 */
export function root_hash_from_ptrs(left_ptr, right_ptr, out_ptr) {
    wasm.root_hash_from_ptrs(left_ptr, right_ptr, out_ptr);
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./blake3_wasm_streaming_bg.js": import0,
    };
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('blake3_wasm_streaming_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
