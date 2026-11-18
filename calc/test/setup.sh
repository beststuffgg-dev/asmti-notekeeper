#!/usr/bin/env bash
# Builds the tools the tests need into $NK_TOOLS (default: ./.tools next to this script):
#   spasm-ng (eZ80 assembler), the CEmu core library, and test/harness.
# Needs: git, gcc/g++, make, python3 + Pillow.   No TI ROM is needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="${NK_TOOLS:-$HERE/.tools}"
SPASM_REV=5f0786d38f064835be674d4b7df42969967bb73c   # alberthdev/spasm-ng
CEMU_REV=dd38ccec41cf201dcd360b2928f6db301cfbe9da    # CE-Programming/CEmu
mkdir -p "$TOOLS"; cd "$TOOLS"

fetch() {  # fetch <url> <dir> <rev>
  if [ ! -d "$2/.git" ]; then git clone -q "$1" "$2"; fi
  git -C "$2" -c advice.detachedHead=false checkout -q "$3"
}
fetch https://github.com/alberthdev/spasm-ng spasm-ng "$SPASM_REV"
fetch https://github.com/CE-Programming/CEmu cemu "$CEMU_REV"

# NO_APPSIGN: app signing needs GMP/OpenSSL and we only build programs.
( cd spasm-ng && NO_APPSIGN=1 FORCE_NO_GIT=1 make -j"$(nproc)" >/dev/null )
( cd cemu/core && make -j"$(nproc)" >/dev/null )
gcc -O2 -std=gnu11 -I cemu/core "$HERE/harness.c" cemu/core/libcemucore.a -lm -lpthread -o harness

cat <<EOF
Tools ready in $TOOLS. Run the tests with:
  SPASM=$TOOLS/spasm-ng/spasm SPASM_INC=$TOOLS/spasm-ng/inc NK_HARNESS=$TOOLS/harness python3 $HERE/run_tests.py
EOF
