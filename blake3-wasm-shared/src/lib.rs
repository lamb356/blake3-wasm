use wasm_bindgen::prelude::*;
use blake3::hazmat::{self, HasherExt, Mode};

const CHUNK_SIZE: usize = 1024;

// --- Internal shared implementation ---

fn do_hash_subtree(data: &[u8], input_offset: u64) -> Vec<u8> {
    let mut hasher = blake3::Hasher::new();
    hasher.set_input_offset(input_offset);
    hasher.update(data);
    hasher.finalize_non_root().to_vec()
}

// --- Original streaming functions (same as blake3-wasm-streaming) ---

#[wasm_bindgen]
pub fn hash_chunk(data: &[u8], chunk_index: u64) -> Vec<u8> {
    let mut hasher = blake3::Hasher::new();
    hasher.set_input_offset(chunk_index * CHUNK_SIZE as u64);
    hasher.update(data);
    hasher.finalize_non_root().to_vec()
}

#[wasm_bindgen]
pub fn hash_subtree(data: &[u8], input_offset: u64) -> Vec<u8> {
    do_hash_subtree(data, input_offset)
}

#[wasm_bindgen]
pub fn parent_cv(left_cv: &[u8], right_cv: &[u8]) -> Vec<u8> {
    let left: [u8; 32] = left_cv.try_into().expect("left_cv must be 32 bytes");
    let right: [u8; 32] = right_cv.try_into().expect("right_cv must be 32 bytes");
    hazmat::merge_subtrees_non_root(&left, &right, Mode::Hash).to_vec()
}

#[wasm_bindgen]
pub fn root_hash(left_cv: &[u8], right_cv: &[u8]) -> Vec<u8> {
    let left: [u8; 32] = left_cv.try_into().expect("left_cv must be 32 bytes");
    let right: [u8; 32] = right_cv.try_into().expect("right_cv must be 32 bytes");
    hazmat::merge_subtrees_root(&left, &right, Mode::Hash).as_bytes().to_vec()
}

#[wasm_bindgen]
pub fn hash_single(data: &[u8]) -> Vec<u8> {
    blake3::hash(data).as_bytes().to_vec()
}

#[wasm_bindgen]
pub fn left_subtree_len(input_len: u64) -> u64 {
    hazmat::left_subtree_len(input_len)
}

#[wasm_bindgen]
pub fn chunk_len() -> u32 {
    CHUNK_SIZE as u32
}

// --- New pointer-based functions for shared memory ---

#[wasm_bindgen]
pub fn alloc_input(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[wasm_bindgen]
pub fn free_input(ptr: *mut u8, size: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, size)); }
}

#[wasm_bindgen]
pub fn hash_subtree_ptr(ptr: *const u8, size: usize, input_offset: u64) -> Vec<u8> {
    let data = unsafe { std::slice::from_raw_parts(ptr, size) };
    do_hash_subtree(data, input_offset)
}
