#!/usr/bin/env bash
# Test and build the contract (Linux / WSL). Output: contract/out/bazaar_charters.wasm
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
SRC="$(cd "$(dirname "$0")" && pwd)"
WORK="${BUILD_DIR:-$HOME/bazaar-build}"
mkdir -p "$WORK"
cp -r "$SRC/Cargo.toml" "$SRC/rust-toolchain.toml" "$SRC/src" "$WORK/"
[ -f "$SRC/Cargo.lock" ] && cp "$SRC/Cargo.lock" "$WORK/"
cd "$WORK"
cargo test 2>&1 | grep -E "^error|error\[|test |test result|panicked" || true
cargo test --quiet >/dev/null
cargo near build non-reproducible-wasm 2>&1 | tail -3
mkdir -p "$SRC/out"
cp target/near/bazaar_charters.wasm target/near/bazaar_charters_abi.json "$SRC/out/"
cp Cargo.lock "$SRC/"
echo "built → $SRC/out/bazaar_charters.wasm"
