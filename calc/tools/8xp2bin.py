#!/usr/bin/env python3
"""Extract the raw program bytes from a TI .8xp (drops the 2-byte EF 7B ASM token) for the test harness."""
import sys
d = open(sys.argv[1], 'rb').read()
size = d[0x48] | d[0x49] << 8
body = d[0x4A:0x4A + size]
assert body[:2] == b'\xEF\x7B', 'not a CE ASM program'
open(sys.argv[2], 'wb').write(body[2:])
print(f'{sys.argv[2]}: {len(body) - 2} bytes of code')
