# BLAKE3 WASM Build (auditable) - Windows PowerShell
$ErrorActionPreference = "Stop"

$BLAKE3_TAG = "1.8.3"
$BLAKE3_REPO = "https://github.com/BLAKE3-team/BLAKE3.git"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Set up MSVC environment for native dependencies
$vsPath = "C:\Program Files\Microsoft Visual Studio\2022\Community"
$msvcVersion = "14.44.35207"
$sdkVersion = "10.0.18362.0"

$msvcBin = "$vsPath\VC\Tools\MSVC\$msvcVersion\bin\HostX64\x64"
$msvcLib = "$vsPath\VC\Tools\MSVC\$msvcVersion\lib\x64"
$msvcInclude = "$vsPath\VC\Tools\MSVC\$msvcVersion\include"

$sdkBase = "C:\Program Files (x86)\Windows Kits\10"
$sdkLib = "$sdkBase\Lib\$sdkVersion"
$sdkInclude = "$sdkBase\Include\$sdkVersion"

$env:PATH = "$msvcBin;$env:PATH"
$env:LIB = "$msvcLib;$sdkLib\ucrt\x64;$sdkLib\um\x64"
$env:INCLUDE = "$msvcInclude;$sdkInclude\ucrt;$sdkInclude\um;$sdkInclude\shared"

Write-Host "=== BLAKE3 WASM Build (auditable) ==="
Write-Host "BLAKE3 version: $BLAKE3_TAG"
Write-Host ""

# --- Clone BLAKE3 source at pinned tag ---
Write-Host "[1/4] Cloning BLAKE3 @ $BLAKE3_TAG..."
if (Test-Path blake3-source) { Remove-Item -Recurse -Force blake3-source }
git clone --depth 1 --branch $BLAKE3_TAG $BLAKE3_REPO blake3-source

# --- Build single-threaded module ---
Write-Host "[2/4] Building single-threaded WASM..."
New-Item -ItemType Directory -Force -Path blake3-wasm-single/src, blake3-wasm-single/.cargo | Out-Null

@"
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
"@ | Set-Content blake3-wasm-single/Cargo.toml -Encoding UTF8

@"
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
"@ | Set-Content blake3-wasm-single/.cargo/config.toml -Encoding UTF8

@"
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn hash(input: &[u8]) -> Vec<u8> {
    blake3::hash(input).as_bytes().to_vec()
}
"@ | Set-Content blake3-wasm-single/src/lib.rs -Encoding UTF8

Push-Location blake3-wasm-single
wasm-pack build --release --target web --out-dir pkg
Pop-Location

# --- Build parallel (rayon) module ---
Write-Host "[3/4] Building parallel WASM (rayon)..."
New-Item -ItemType Directory -Force -Path blake3-wasm-rayon/src, blake3-wasm-rayon/.cargo | Out-Null

@"
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
"@ | Set-Content blake3-wasm-rayon/Cargo.toml -Encoding UTF8

@"
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
"@ | Set-Content blake3-wasm-rayon/.cargo/config.toml -Encoding UTF8

@"
[toolchain]
channel = "nightly-2025-11-15"
components = ["rust-src"]
targets = ["wasm32-unknown-unknown"]
profile = "minimal"
"@ | Set-Content blake3-wasm-rayon/rust-toolchain.toml -Encoding UTF8

@"
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
"@ | Set-Content blake3-wasm-rayon/src/lib.rs -Encoding UTF8

Push-Location blake3-wasm-rayon
wasm-pack build --release --target web --out-dir pkg
Pop-Location

# Patch workerHelpers.js: import('../../..') resolves to a directory URL in
# browsers (no bundler), which fails. Replace with explicit file path.
Get-ChildItem -Path blake3-wasm-rayon/pkg/snippets -Recurse -Filter 'workerHelpers.js' | ForEach-Object {
    (Get-Content $_.FullName -Raw) -replace "import\('../../\.\.'\)", "import('../../../blake3_wasm_rayon.js')" |
        Set-Content $_.FullName -Encoding UTF8 -NoNewline
}

# --- Cleanup ---
Write-Host "[4/4] Cleaning build artifacts..."
if (Test-Path blake3-source) { Remove-Item -Recurse -Force blake3-source }
if (Test-Path blake3-wasm-single/target) { Remove-Item -Recurse -Force blake3-wasm-single/target }
if (Test-Path blake3-wasm-rayon/target) { Remove-Item -Recurse -Force blake3-wasm-rayon/target }

Write-Host ""
Write-Host "Done! WASM modules built:"
Write-Host "  blake3-wasm-single/pkg/"
Write-Host "  blake3-wasm-rayon/pkg/"
