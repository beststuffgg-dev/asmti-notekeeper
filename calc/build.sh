#!/usr/bin/env bash
# Assemble src/notes.asm -> dist/NOTES.8xp.  Set SPASM / SPASM_INC to your spasm-ng build
# (test/setup.sh builds one into test/.tools).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SPASM="${SPASM:-$HERE/test/.tools/spasm-ng/spasm}"
INC="${SPASM_INC:-$HERE/test/.tools/spasm-ng/inc}"
mkdir -p "$HERE/dist"
"$SPASM" -E -I "$INC" -I "$HERE/src" "$HERE/src/notes.asm" "$HERE/dist/NOTES.8xp"
ls -l "$HERE/dist/NOTES.8xp"
