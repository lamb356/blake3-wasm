#!/usr/bin/env bash
set -euo pipefail

BLAKE3_TAG="1.8.3"
BLAKE3_REPO="https://github.com/BLAKE3-team/BLAKE3.git"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== BLAKE3 WASM Build (auditable) ==="
echo "BLAKE3 version: $BLAKE3_TAG"
echo ""

# --- Clone BLAKE3 source at pinned tag ---
echo "[1/4] Cloning BLAKE3 @ $BLAKE3_TAG..."
rm -rf blake3-source
git clone --depth 1 --branch "$BLAKE3_TAG" "$BLAKE3_REPO" blake3-source

# --- Build single-threaded module ---
echo "[2/4] Building single-threaded WASM..."
mkdir -p blake3-wasm-single/src blake3-wasm-single/.cargo

cat > blake3-wasm-single/Cargo.toml << 'CARGO'
[package]
name = "blake3_wasm_single"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
blake3 = { version = "1", features = ["wasm32_simd"] }

[profile.release]
lto = true
codegen-units = 1
opt-level = 3
CARGO

cat > blake3-wasm-single/.cargo/config.toml << 'CFG'
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
CFG

cat > blake3-wasm-single/src/lib.rs << 'RUST'
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn hash(input: &[u8]) -> Vec<u8> {
    blake3::hash(input).as_bytes().to_vec()
}
RUST

(cd blake3-wasm-single && wasm-pack build --release --target web --out-dir pkg)

# --- Build parallel (rayon) module ---
echo "[3/4] Building parallel WASM (rayon)..."
mkdir -p blake3-wasm-rayon/src blake3-wasm-rayon/.cargo

cat > blake3-wasm-rayon/Cargo.toml << 'CARGO'
[package]
name = "blake3_wasm_rayon"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
rayon = "1.8"
wasm-bindgen-rayon = "1.3"
blake3 = { version = "1", features = ["rayon", "wasm32_simd"] }

[profile.release]
lto = true
codegen-units = 1
opt-level = 3
panic = "abort"
CARGO

cat > blake3-wasm-rayon/.cargo/config.toml << 'CFG'
[target.wasm32-unknown-unknown]
rustflags = [
  "-C", "target-feature=+atomics,+bulk-memory,+simd128",
  "-C", "link-arg=--shared-memory",
  "-C", "link-arg=--max-memory=1073741824",
  "-C", "link-arg=--import-memory",
  "-C", "link-arg=--export=__wasm_init_tls",
  "-C", "link-arg=--export=__tls_size",
  "-C", "link-arg=--export=__tls_align",
  "-C", "link-arg=--export=__tls_base",
]

[unstable]
build-std = ["panic_abort", "std"]
CFG

cat > blake3-wasm-rayon/rust-toolchain.toml << 'TC'
[toolchain]
channel = "nightly-2025-11-15"
components = ["rust-src"]
targets = ["wasm32-unknown-unknown"]
profile = "minimal"
TC

cat > blake3-wasm-rayon/src/lib.rs << 'RUST'
use wasm_bindgen::prelude::*;

pub use wasm_bindgen_rayon::init_thread_pool;

const OUT_LEN: usize = 32;
const PAR_THRESHOLD: usize = 16 * 1024;

#[wasm_bindgen]
pub fn hash(input: &[u8]) -> Vec<u8> {
    let mut hasher = blake3::Hasher::new();

    if input.len() >= PAR_THRESHOLD {
        hasher.update_rayon(input);
    } else {
        hasher.update(input);
    }

    let h = hasher.finalize();
    let mut out = Vec::with_capacity(OUT_LEN);
    out.extend_from_slice(h.as_bytes());
    out
}
RUST

(cd blake3-wasm-rayon && wasm-pack build --release --target web --out-dir pkg)

# --- Cleanup ---
echo "[4/4] Cleaning build artifacts..."
rm -rf blake3-source
rm -rf blake3-wasm-single/target blake3-wasm-rayon/target

echo ""
echo "Done! WASM modules built:"
echo "  blake3-wasm-single/pkg/"
echo "  blake3-wasm-rayon/pkg/"
