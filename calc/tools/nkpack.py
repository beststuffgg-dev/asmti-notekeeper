#!/usr/bin/env python3
"""Notekeeper packer: builds the appvars the TI-84 CE program reads.

On-calculator formats (all little-endian)
  NKIDX   : count(1) { name(8, zero padded) title(24, zero padded) } * count
  NKPxxxx : "NKP1" nblocks(1) title(24) pcount(1) palette(pcount*2, 1555 xRRRRRGGGGGBBBBB, entries 16..)
            then blocks:  01 len(2) text-bytes          (text: ASCII, 0Ah = newline)
                          02 w(2) h(2) name(8)          (image: references appvar `name`)
  NKIxxxxn: w*h raw 8-bit pixels, palette indexes 16..255

CLI:  nkpack.py OUTDIR [--archive] file...   (.txt/.md/.png/.jpg ... ; images are grouped into one page)
"""
import os, re, struct, sys

MAX_W, MAX_H = 320, 200          # image must fit the 64 KB variable limit (320*200 = 64000)
MAX_PAGE = 60000
MAX_TEXT = 4000


def ascii_clean(s):
    """Fold text to what the calculator font can show: ASCII 32..126 and newline."""
    rep = {'\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-',
           '\u2026': '...', '\u00a0': ' ', '\t': '    ', '\u2022': '*', '\u22ef': '...', '\u203a': '>',
           '\u2039': '<', '\u2192': '->', '\u2190': '<-', '\u00d7': 'x', '\u00f7': '/', '\u2212': '-',
           '\u2032': "'", '\u00b7': '.'}
    out = []
    for ch in s.replace('\r\n', '\n').replace('\r', '\n'):
        ch = rep.get(ch, ch)
        for c in ch:
            if c == '\n' or 32 <= ord(c) < 127:
                out.append(c)
            else:
                out.append('?')
    return ''.join(out)


def pad(b, n):
    b = b[:n]
    return b + b'\0' * (n - len(b))


def build_page(title, blocks, palette=()):
    """blocks: ('text', str) | ('image', name, w, h); palette: list of 16-bit 1555 values for entries 16.."""
    body = bytearray()
    n = 0
    for blk in blocks:
        if blk[0] == 'text':
            t = ascii_clean(blk[1]).encode('ascii')
            for i in range(0, max(len(t), 1), MAX_TEXT):          # split over-long text into several blocks
                chunk = t[i:i + MAX_TEXT]
                body += b'\x01' + struct.pack('<H', len(chunk)) + chunk
                n += 1
        else:
            _, name, w, h = blk
            assert 1 <= w <= MAX_W and 1 <= h <= MAX_H, 'image too large'
            body += b'\x02' + struct.pack('<HH', w, h) + pad(name.encode(), 8)
            n += 1
    assert n <= 255 and len(palette) <= 240
    hdr = b'NKP1' + bytes([n]) + pad(ascii_clean(title).replace('\n', ' ').encode(), 24) \
        + bytes([len(palette)]) + b''.join(struct.pack('<H', c) for c in palette)
    data = hdr + bytes(body)
    assert len(data) <= MAX_PAGE, 'page too large for the calculator (%d bytes)' % len(data)
    return data


def build_index(pages):
    """pages: list of (appvar_name, title)"""
    assert len(pages) <= 40, 'at most 40 pages fit in the NKIDX index'
    out = bytes([len(pages)])
    for name, title in pages:
        out += pad(name.encode(), 8) + pad(ascii_clean(title).replace('\n', ' ').encode(), 24)
    return out


def appvar_8xv(name, content, archived=False):
    """Wrap `content` as a TI-84 CE appvar file (.8xv)."""
    assert re.fullmatch(r'[A-Z][A-Z0-9]{0,7}', name), 'bad appvar name %r' % name
    assert len(content) <= 65500, 'appvar too large (%d bytes)' % len(content)
    varlen = len(content) + 2
    entry = struct.pack('<HHB', 0x0D, varlen, 0x15) + pad(name.encode(), 8) \
        + bytes([0, 0x80 if archived else 0]) + struct.pack('<H', varlen) + struct.pack('<H', len(content)) + content
    head = b'**TI83F*\x1a\x0a\x00' + pad(b'Notekeeper', 42) + struct.pack('<H', len(entry))
    return head + entry + struct.pack('<H', sum(entry) & 0xFFFF)


def quantize(images):
    """Shared 240-colour palette for a list of PIL images -> (palette_1555 list, [(w,h,bytes)])."""
    from PIL import Image
    ims = []
    for im in images:
        im = im.convert('RGB')
        im.thumbnail((MAX_W, MAX_H), Image.LANCZOS)
        ims.append(im)
    total_w = sum(i.width for i in ims)
    sheet = Image.new('RGB', (total_w, max(i.height for i in ims)))
    x = 0
    for i in ims:
        sheet.paste(i, (x, 0)); x += i.width
    pal_img = sheet.quantize(colors=240, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = pal_img.getpalette()[:720]
    pal += [0] * (720 - len(pal))
    p1555 = [(((pal[3*k] >> 3) << 10) | ((pal[3*k+1] >> 3) << 5) | (pal[3*k+2] >> 3)) for k in range(240)]
    out = []
    for i in ims:
        q = i.quantize(palette=pal_img, dither=Image.Dither.FLOYDSTEINBERG)
        out.append((i.width, i.height, bytes(v + 16 for v in q.tobytes())))
    return p1555, out


def split_text(raw, file_title):
    """Same rules as the web importer (js/importer.js splitText): a file with two or more top-level
    "# Heading" lines becomes one page per heading; a single leading heading becomes the page title."""
    lines = raw.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    heads, fence = [], False
    for i, l in enumerate(lines):
        if l.startswith('```'):
            fence = not fence
        elif not fence and re.match(r'#\s+\S', l):
            heads.append(i)
    if len(heads) >= 2:
        pages = []
        pre = '\n'.join(lines[:heads[0]]).strip()
        if pre:
            pages.append((file_title, pre))
        for k, st in enumerate(heads):
            end = heads[k + 1] if k + 1 < len(heads) else len(lines)
            pages.append((re.sub(r'^#\s+', '', lines[st]).strip(), '\n'.join(lines[st + 1:end]).strip()))
        return pages
    first = next((i for i, l in enumerate(lines) if l.strip()), -1)
    if len(heads) == 1 and heads[0] == first:
        return [(re.sub(r'^#\s+', '', lines[first]).strip(), '\n'.join(lines[first + 1:]).strip())]
    return [(file_title, raw.replace('\r\n', '\n').strip())]


def main(argv):
    from PIL import Image
    if len(argv) < 3:
        print(__doc__); return 1
    outdir, rest = argv[1], argv[2:]
    archived = '--archive' in rest
    files = [f for f in rest if f != '--archive']
    os.makedirs(outdir, exist_ok=True)
    pages, vars_ = [], {}
    imgs = [f for f in files if re.search(r'\.(png|jpe?g|gif|bmp|webp)$', f, re.I)]
    for f in files:
        if f in imgs:
            continue
        txt = open(f, encoding='utf-8', errors='replace').read()
        for title, body in split_text(txt, os.path.splitext(os.path.basename(f))[0]):
            pname = 'NKP%04d' % (len(pages) + 1)
            vars_[pname] = build_page(title or 'Untitled', [('text', body)])
            pages.append((pname, title or 'Untitled'))
    if imgs:
        pname = 'NKP%04d' % (len(pages) + 1)
        pal, data = quantize([Image.open(f) for f in sorted(imgs)])
        blocks = []
        for k, (w, h, px) in enumerate(data):
            iname = 'NKI%04d%s' % (len(pages) + 1, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[k])
            vars_[iname] = px
            blocks.append(('image', iname, w, h))
        first = os.path.splitext(os.path.basename(sorted(imgs)[0]))[0]
        title = first if len(imgs) == 1 else '%s (+%d more)' % (first, len(imgs) - 1)   # same rule as the web importer
        vars_[pname] = build_page(title, blocks, pal)
        pages.append((pname, title))
    vars_['NKIDX'] = build_index(pages)
    for name, content in vars_.items():
        with open(os.path.join(outdir, name + '.8xv'), 'wb') as fh:
            fh.write(appvar_8xv(name, content, archived))
    print('wrote %d appvars to %s' % (len(vars_), outdir))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
