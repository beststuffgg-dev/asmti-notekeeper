// Export a notebook for the TI-84 Plus CE program (calc/src/notes.asm).
//
// Produces the same files as calc/tools/nkpack.py (format documented there):
//   NKIDX            index: count(1) { appvar name(8) title(24) } * count
//   NKP0001 ...      pages: "NKP1" nblocks(1) title(24) pcount(1) palette(pcount*2) blocks...
//   NKI00010 ...     images: raw 8-bit pixels, palette indexes 16..255
// each wrapped as a .8xv file, and bundled into a .zip for download.
(function (g) {
    'use strict';

    const MAX_W = 320, MAX_H = 200, MAX_PAGE = 60000, MAX_TEXT = 4000, MAX_PAGES = 40;
    const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    /* ---------- text / bytes ---------- */

    const REPLACE = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-',
        '\u2026': '...', '\u00a0': ' ', '\t': '    ', '\u2022': '*', '\u22ef': '...', '\u203a': '>',
        '\u2039': '<', '\u2192': '->', '\u2190': '<-', '\u00d7': 'x', '\u00f7': '/', '\u2212': '-',
        '\u2032': "'", '\u00b7': '.' };

    // Fold text to what the calculator font can show: ASCII 32..126 and newline (everything else -> '?').
    function asciiClean(s) {
        let out = '';
        for (let ch of String(s).replace(/\r\n?/g, '\n')) {
            ch = REPLACE[ch] !== undefined ? REPLACE[ch] : ch;
            for (const c of ch) {
                const n = c.codePointAt(0);
                out += (c === '\n' || (n >= 32 && n < 127)) ? c : '?';
            }
        }
        return out;
    }

    const u16 = (n) => [n & 255, (n >> 8) & 255];
    function padBytes(bytes, n) {
        const out = new Uint8Array(n);
        out.set(bytes.slice(0, n));
        return out;
    }
    const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    function concat(parts) {
        const len = parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(len);
        let o = 0;
        parts.forEach((p) => { out.set(p, o); o += p.length; });
        return out;
    }

    /* ---------- calculator file formats ---------- */

    // blocks: {type:'text', text} | {type:'image', name, w, h};  palette: array of 16-bit 1555 values for entries 16..
    function buildPage(title, blocks, palette) {
        palette = palette || [];
        const body = [];
        let n = 0;
        for (const b of blocks) {
            if (b.type === 'text') {
                const t = ascii(asciiClean(b.text));
                for (let i = 0; i < Math.max(t.length, 1); i += MAX_TEXT) {
                    const chunk = t.slice(i, i + MAX_TEXT);
                    body.push(Uint8Array.from([1, ...u16(chunk.length)]), chunk);
                    n++;
                }
            } else {
                if (!(b.w >= 1 && b.w <= MAX_W && b.h >= 1 && b.h <= MAX_H)) throw new Error('image too large');
                body.push(Uint8Array.from([2, ...u16(b.w), ...u16(b.h)]), padBytes(ascii(b.name), 8));
                n++;
            }
        }
        if (n > 255) throw new Error('too many blocks (max 255)');
        if (palette.length > 240) throw new Error('palette too large');
        const hdr = concat([ascii('NKP1'), Uint8Array.from([n]),
            padBytes(ascii(asciiClean(title).replace(/\n/g, ' ')), 24),
            Uint8Array.from([palette.length]), ...palette.map((c) => Uint8Array.from(u16(c)))]);
        const data = concat([hdr, ...body]);
        if (data.length > MAX_PAGE) throw new Error('page too large for the calculator (' + data.length + ' bytes)');
        return data;
    }

    function buildIndex(pages) {
        if (pages.length > MAX_PAGES) throw new Error('at most ' + MAX_PAGES + ' pages fit in the index');
        return concat([Uint8Array.from([pages.length]), ...pages.map((p) =>
            concat([padBytes(ascii(p.name), 8), padBytes(ascii(asciiClean(p.title).replace(/\n/g, ' ')), 24)]))]);
    }

    // Wrap `content` as a TI-84 CE appvar file (.8xv).
    function appvar8xv(name, content, archived) {
        if (!/^[A-Z][A-Z0-9]{0,7}$/.test(name)) throw new Error('bad appvar name ' + name);
        if (content.length > 65500) throw new Error('appvar too large (' + content.length + ' bytes)');
        const varlen = content.length + 2;
        const entry = concat([Uint8Array.from([0x0D, 0, ...u16(varlen), 0x15]), padBytes(ascii(name), 8),
            Uint8Array.from([0, archived ? 0x80 : 0, ...u16(varlen), ...u16(content.length)]), content]);
        const head = concat([ascii('**TI83F*'), Uint8Array.from([0x1A, 0x0A, 0]), padBytes(ascii('Notekeeper'), 42),
            Uint8Array.from(u16(entry.length))]);
        let sum = 0;
        for (const b of entry) sum = (sum + b) & 0xFFFF;
        return concat([head, entry, Uint8Array.from(u16(sum))]);
    }

    /* ---------- image quantisation (median cut + Floyd-Steinberg) ---------- */

    // images: [{w, h, data: Uint8ClampedArray RGBA}]  ->  {palette: [1555 x<=240], images: [{w, h, pixels: Uint8Array}]}
    function quantize(images, opts) {
        const dither = !opts || opts.dither !== false;
        // histogram at 5 bits per channel
        const hist = new Map();
        for (const im of images) {
            for (let i = 0; i < im.data.length; i += 4) {
                const k = (im.data[i] >> 3) << 10 | (im.data[i + 1] >> 3) << 5 | (im.data[i + 2] >> 3);
                hist.set(k, (hist.get(k) || 0) + 1);
            }
        }
        let boxes = [[...hist.entries()].map(([k, c]) => ({ r: k >> 10, g: k >> 5 & 31, b: k & 31, c }))];
        while (boxes.length < 240) {
            let bi = -1, best = 0, axis = 'r';
            boxes.forEach((bx, i) => {
                if (bx.length < 2) return;
                for (const ax of ['r', 'g', 'b']) {
                    let lo = 31, hi = 0;
                    for (const p of bx) { lo = Math.min(lo, p[ax]); hi = Math.max(hi, p[ax]); }
                    const score = (hi - lo) * Math.log2(bx.length + 1);
                    if (hi > lo && score > best) { best = score; bi = i; axis = ax; }
                }
            });
            if (bi < 0) break;
            const bx = boxes[bi].sort((p, q) => p[axis] - q[axis]);
            const total = bx.reduce((a, p) => a + p.c, 0);
            let acc = 0, cut = 1;
            for (let i = 0; i < bx.length - 1; i++) { acc += bx[i].c; cut = i + 1; if (acc * 2 >= total) break; }
            boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
        }
        const pal = boxes.map((bx) => {
            let r = 0, gg = 0, b = 0, t = 0;
            for (const p of bx) { r += p.r * p.c; gg += p.g * p.c; b += p.b * p.c; t += p.c; }
            return [Math.round(r / t * 255 / 31), Math.round(gg / t * 255 / 31), Math.round(b / t * 255 / 31)];
        });
        const palette = pal.map(([r, gg, b]) => ((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3));
        const pr = pal.map((p) => [(p[0] >> 3) * 255 / 31, (p[1] >> 3) * 255 / 31, (p[2] >> 3) * 255 / 31]);  // what the LCD really shows
        const cache = new Map();
        const nearest = (r, gg, b) => {
            const key = (r >> 3) << 10 | (gg >> 3) << 5 | (b >> 3);
            let v = cache.get(key);
            if (v === undefined) {
                let bd = 1e18;
                for (let i = 0; i < pr.length; i++) {
                    const dr = pr[i][0] - r, dg = pr[i][1] - gg, db = pr[i][2] - b, d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
                    if (d < bd) { bd = d; v = i; }
                }
                cache.set(key, v);
            }
            return v;
        };
        const out = images.map((im) => {
            const px = new Uint8Array(im.w * im.h);
            let e0 = new Float32Array(im.w * 3), e1 = new Float32Array(im.w * 3);   // error carried to this row / the next
            const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
            for (let y = 0; y < im.h; y++) {
                for (let x = 0; x < im.w; x++) {
                    const o = (y * im.w + x) * 4;
                    let r = im.data[o], gg = im.data[o + 1], b = im.data[o + 2];
                    if (dither) { r += e0[x * 3]; gg += e0[x * 3 + 1]; b += e0[x * 3 + 2]; }
                    r = clamp(r); gg = clamp(gg); b = clamp(b);
                    const i = nearest(r, gg, b);
                    px[y * im.w + x] = i + 16;
                    if (dither) {
                        const q = pr[i], dr = r - q[0], dg = gg - q[1], db = b - q[2];
                        const add = (arr, xx, f) => { if (xx >= 0 && xx < im.w) { arr[xx * 3] += dr * f; arr[xx * 3 + 1] += dg * f; arr[xx * 3 + 2] += db * f; } };
                        add(e0, x + 1, 7 / 16); add(e1, x - 1, 3 / 16); add(e1, x, 5 / 16); add(e1, x + 1, 1 / 16);
                    }
                }
                if (dither) { const t = e0; e0 = e1; e1 = t; e1.fill(0); }
            }
            return { w: im.w, h: im.h, pixels: px };
        });
        return { palette, images: out };
    }

    /* ---------- zip (store only) ---------- */

    const CRC = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
        return t;
    })();
    function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

    function makeZip(files) {   // files: [{name, data: Uint8Array}]
        const local = [], central = [];
        let offset = 0;
        for (const f of files) {
            const name = ascii(f.name), crc = crc32(f.data);
            const head = Uint8Array.from([0x50, 0x4B, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, ...le32(crc), ...le32(f.data.length), ...le32(f.data.length), ...u16(name.length), 0, 0]);
            local.push(head, name, f.data);
            central.push(Uint8Array.from([0x50, 0x4B, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, ...le32(crc), ...le32(f.data.length), ...le32(f.data.length),
                ...u16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(offset)]), name);   // extra, comment, disk, internal attrs (2 each), external attrs (4)
            offset += head.length + name.length + f.data.length;
        }
        const cd = concat(central);
        const end = Uint8Array.from([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...le32(cd.length), ...le32(offset), 0, 0]);
        return concat([...local, cd, end]);
    }

    /* ---------- notebook -> files ---------- */

    // pages: [{title, blocks: [{type:'text', text} | {type:'image', image:{w,h,data(RGBA)}, caption}]}]
    // Images must already be scaled to fit MAX_W x MAX_H (see fitImage in app.js).
    function exportPages(pages, opts) {
        const warnings = [];
        const files = [];
        const index = [];
        pages.forEach((pg, pi) => {
            if (index.length >= MAX_PAGES) { if (!warnings.some((w) => /^Only/.test(w))) warnings.push('Only the first ' + MAX_PAGES + ' pages fit on the calculator.'); return; }
            const pname = 'NKP' + String(index.length + 1).padStart(4, '0');
            const imgs = pg.blocks.filter((b) => b.type === 'image');
            if (imgs.length > 36) { warnings.push('"' + pg.title + '": more than 36 images, extra images skipped.'); }
            let q = { palette: [], images: [] };
            const usable = imgs.slice(0, 36);
            if (usable.length) q = quantize(usable.map((b) => b.image), opts);
            let k = 0;
            const blocks = [];
            for (const b of pg.blocks) {
                if (b.type === 'text') { blocks.push({ type: 'text', text: b.text }); continue; }
                if (!usable.includes(b)) continue;
                const iname = 'NKI' + String(index.length + 1).padStart(4, '0') + B36[k];
                const im = q.images[k++];
                files.push({ name: iname, content: im.pixels });
                blocks.push({ type: 'image', name: iname, w: im.w, h: im.h });
                if (b.caption && b.caption.trim()) blocks.push({ type: 'text', text: b.caption.trim() });
            }
            try {
                const data = buildPage(pg.title || 'Untitled', blocks, q.palette);
                files.push({ name: pname, content: data });
                index.push({ name: pname, title: pg.title || 'Untitled' });
                const orig = pg.blocks.map((b) => b.text || '').join('') + (pg.title || '');
                if ((asciiClean(orig).match(/\?/g) || []).length > (orig.match(/\?/g) || []).length) {
                    warnings.push('"' + pg.title + '": characters the calculator font lacks were replaced by "?".');
                }
            } catch (e) {
                files.splice(files.length - k, k);      // this page's image files were the last k entries: drop them again
                warnings.push('"' + pg.title + '" skipped: ' + e.message + '.');
            }
        });
        files.push({ name: 'NKIDX', content: buildIndex(index) });
        return { files: files.map((f) => ({ name: f.name + '.8xv', data: appvar8xv(f.name, f.content, !!(opts && opts.archived)) })), warnings, pageCount: index.length };
    }

    g.TIExport = { asciiClean, buildPage, buildIndex, appvar8xv, quantize, makeZip, exportPages, crc32, MAX_W, MAX_H };
})(typeof window !== 'undefined' ? window : globalThis);
