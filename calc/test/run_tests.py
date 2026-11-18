#!/usr/bin/env python3
"""End-to-end tests of NOTES.8xp running in the CEmu core (see harness.c).

Each test drives the real program with scripted key presses, then checks decoded screen text,
pixels, and the appvars the program saved.   usage: run_tests.py [name-filter]
"""
import os, re, struct, sys, traceback
from nktest import *

OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
FONT = {}
for i, line in enumerate(l for l in open(os.path.join(ROOT, 'src', 'font6x9.inc')) if l.strip().startswith('.db')):
    FONT[chr(32 + i)] = tuple(int(x[:-1], 16) for x in line.split(';')[0].split()[1].split(','))
GLYPH = {v: k for k, v in FONT.items()}


# ------------------------------------------------------------------ screen decoding
def bright(px): return sum(px) / 3 > 120


def decode_row(im, y, x0=2, cols=53):
    """Read text back from the frame buffer (handles the inverted caret cell)."""
    out = []
    for c in range(cols):
        bits = []
        cell = [[im.getpixel((x0 + c * 6 + x, y + r)) for x in range(6)] for r in range(9)]
        yellow = sum(1 for row in cell for p in row if p[0] > 200 and p[1] > 150 and p[2] < 120)
        inv = yellow > 20
        for row in cell:
            b = 0
            for x, p in enumerate(row):
                on = (not bright(p)) if inv else bright(p)
                if inv: on = not (p[0] > 200 and p[1] > 150 and p[2] < 120)
                if on: b |= 0x80 >> x
            bits.append(b)
        out.append(GLYPH.get(tuple(bits), '#'))
    return ''.join(out).rstrip()


def rows(im, top=14, n=21, x0=2, cols=53):
    return [decode_row(im, top + i * 10, x0, cols) for i in range(n)]


def find_text(im, needle, x0=2):
    """True if `needle` is drawn at any pixel row of the content area (blocks are 6px apart, so rows need not align)."""
    return any(needle in decode_row(im, y, x0) for y in range(14, 218))


def rows_any_phase(im, n=21):
    """Rows decoded at whichever vertical offset (0..9) gives the most recognisable text (scroll isn't 10px aligned)."""
    best = max(range(10), key=lambda ph: sum(c != '#' and c != ' ' for l in rows(im, 14 + ph, n - 1) for c in l))
    return rows(im, 14 + best, n - 1)


def footer(im): return decode_row(im, 229, 4, 52)
def header(im): return decode_row(im, 2, 4, 50)


# ------------------------------------------------------------------ reference models
def wrap_full(text, cols=53):
    """Same rules as WrapNext in notes.asm. Returns list of (start, len, next_start, term)."""
    lines, s, n = [], 0, len(text)
    while True:
        i, last, term = 0, -1, 0
        rem = n - s
        while True:
            if i == rem: ln, cons, term = i, 0, 0; break
            c = text[s + i]
            if c == '\n': ln, cons, term = i, 1, 1; break
            if i == cols:
                if c == ' ': ln, cons, term = cols, 1, 2
                elif last >= 0: ln, cons, term = last, 1, 2
                else: ln, cons, term = cols, 0, 3
                break
            if c == ' ': last = i
            i += 1
        lines.append((s, ln, s + ln + cons, term))
        s += ln + cons
        if term == 0: break
    return lines


def wrap_ref(text, cols=53):
    return [(a, n) for a, n, _, _ in wrap_full(text, cols)]


def caret_line(text, caret):
    """(line index, start, col) of the caret, using the rule in CaretCompute."""
    for k, (st, ln, t, term) in enumerate(wrap_full(text)):
        if caret < t or term == 0:
            return k, st, caret - st


class EditModel:
    """Independent model of the TEXT-mode editing keys (left/right/up/down/insert/newline/backspace)."""
    def __init__(self, text): self.t, self.c = text, len(text)
    def left(self): self.c = max(0, self.c - 1)
    def right(self): self.c = min(len(self.t), self.c + 1)
    def ins(self, ch):
        if len(self.t) < 4000: self.t = self.t[:self.c] + ch + self.t[self.c:]; self.c += 1
    def back(self):
        if self.c: self.t = self.t[:self.c - 1] + self.t[self.c:]; self.c -= 1
    def up(self):
        k, st, col = caret_line(self.t, self.c)
        if k == 0: self.c = 0; return
        ps, pl, _, _ = wrap_full(self.t)[k - 1]; self.c = ps + min(col, pl)
    def down(self):
        k, st, col = caret_line(self.t, self.c); ls = wrap_full(self.t)
        if k + 1 >= len(ls): self.c = len(self.t); return
        ns, nl, _, _ = ls[k + 1]; self.c = ns + min(col, nl)


def parse_page(b):
    assert b[:4] == b'NKP1', b[:4]
    nblocks = b[4]; title = b[5:29].rstrip(b'\0').decode(); pc = b[29]
    p = 30 + 2 * pc; blocks = []
    for _ in range(nblocks):
        if b[p] == 1:
            ln = struct.unpack('<H', b[p+1:p+3])[0]; blocks.append(('text', b[p+3:p+3+ln].decode())); p += 3 + ln
        else:
            w, h = struct.unpack('<HH', b[p+1:p+5]); blocks.append(('image', b[p+5:p+13].rstrip(b'\0').decode(), w, h)); p += 13
    assert p == len(b), 'trailing/short page data %d vs %d' % (p, len(b))
    return title, blocks


# ------------------------------------------------------------------ tiny test framework
TESTS = []
def test(f): TESTS.append(f); return f
def check(cond, msg):
    if not cond: raise AssertionError(msg)
def eq(a, b, msg=''):
    if a != b: raise AssertionError('%s\n   got: %r\n  want: %r' % (msg, a, b))
def clean_exit(s): check('EXIT program returned' in s.log, 'program did not exit cleanly:\n' + s.log[-300:])


def finish(s, binp):
    s.run(binp)
    clean_exit(s)
    return s


def open_page(s, n=0):
    s.idle(1)
    for _ in range(n): s.key('down')
    s.key('enter'); s.idle(1)


def edit_text(s, block=0):
    s.key('enter')                 # read -> edit (selection starts at block 0)
    for _ in range(block): s.key('down')
    s.key('enter')                 # edit -> text caret at end


# ------------------------------------------------------------------ tests
@test
def list_screen(binp):
    s = standard_session('list'); s.idle(1); s.snap('a'); s.key('down'); s.idle(1); s.snap('b'); s.key('clear')
    finish(s, binp)
    a = s.shots['a']
    eq(header(a), 'NOTEKEEPER   pick a page')
    r = rows(a, 14, 3, 4, 50)
    check(r[0].startswith('Hello notes') and r[1].startswith('Pictures'), r)
    eq((decode_row(a, 14, 200, 8), decode_row(a, 24, 200, 8)), ('NKP0001', 'NKP0002'))
    check(a.getpixel((250, 16)) != a.getpixel((250, 26)), 'selected row not highlighted')
    check(s.shots['b'].getpixel((250, 26)) == a.getpixel((250, 16)), 'highlight did not move with Down')
    eq(footer(a), 'UP/DOWN select    ENTER open    CLEAR quit')
    s.shots['a'].save(os.path.join(OUT, 'list.png'))


@test
def read_wrap_matches_reference(binp):
    s = standard_session('wrap'); open_page(s); s.snap('r'); s.key('clear', 'clear')
    finish(s, binp)
    im = s.shots['r']
    _, blocks = parse_page(sample_text_page())
    want = []
    for kind, text in blocks:
        want += [text[a:a + n] for a, n in wrap_ref(text)] + [None]      # None = block gap (6px)
    got = rows(im, 14, 9)
    t = blocks[0][1]
    expect = [t[a:a + n] for a, n in wrap_ref(t)]
    eq(got[:len(expect)], expect, 'wrapped lines differ from the reference wrapper')
    check(len(expect) >= 7 and any(len(l) == 53 for l in expect), 'fixture should exercise a hard break')
    eq(header(im), 'Hello notes')
    s.shots['r'].save(os.path.join(OUT, 'read.png'))


@test
def images_drawn_with_page_palette(binp):
    s = standard_session('img'); open_page(s, 1); s.snap('i'); s.key('clear', 'clear')
    finish(s, binp)
    im = s.shots['i']
    # block 0: one text line (y 14..23) + 6px gap -> first image (160x100) at y=30, x0=80
    check(im.getpixel((79, 40)) == im.getpixel((10, 100)), 'pixel left of the image should be background')
    blue = im.getpixel((84, 34)); check(blue[2] > 150 and blue[0] < 80, 'image top-left should be blue: %r' % (blue,))
    red = im.getpixel((80 + 80, 30 + 50)); check(red[0] > 180 and red[1] < 90, 'ellipse centre should be red: %r' % (red,))
    # second image (100x60): top = 30 + 100 + 6 = 136, x0 = 110
    green = im.getpixel((110 + 5, 136 + 50)); check(green[1] > 120 and green[0] < 80, 'second image should be green: %r' % (green,))
    eq(rows(im, 14, 1)[0], 'Two pictures follow.')
    s.shots['i'].save(os.path.join(OUT, 'images.png'))


def long_page():
    paras = ['Line number %d of a long page. ' % i + 'word ' * (i % 9) for i in range(1, 61)]
    return nkpack.build_page('Long page', [('text', '\n'.join(paras)[:3990]), ('text', 'tail block')])


@test
def scrolling_and_clamping(binp):
    s = Session('scroll')
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Long page')])); s.appvar('NKP0001', long_page())
    open_page(s); s.snap('top')
    for _ in range(3): s.key('down')
    s.snap('down3')
    for _ in range(5): s.key('up')
    s.snap('up_clamped')
    s.key('right'); s.snap('pgdn')
    for _ in range(60): s.key('right')
    s.snap('bottom')
    s.key('left'); s.snap('bottom_pgup')
    s.key('clear', 'clear')
    finish(s, binp)
    top = rows(s.shots['top'])
    check(top[0].startswith('Line number 1 of'), top[0])
    eq(rows(s.shots['down3'])[0], top[6], 'Down x3 scrolls 60px = 6 rows')
    eq(rows(s.shots['up_clamped'])[0], top[0], 'scroll clamps at the top')
    check(rows(s.shots['pgdn'])[0] == top[19], 'PAGE_STEP (190px) = 19 lines: %r' % rows(s.shots['pgdn'])[0])
    check(find_text(s.shots['bottom'], 'tail block'), 'last block visible at max scroll')
    check(not find_text(s.shots['top'], 'tail block'), 'tail block must not be visible at the top')
    check(not find_text(s.shots['bottom_pgup'], 'tail block'), 'Left pages back up from the bottom')
    check(find_text(s.shots['bottom'], 'Line number 60 of'), 'end of long text visible at the bottom')


@test
def edit_text_and_save(binp):
    s = standard_session('edit'); open_page(s)
    edit_text(s)
    s.snap('caret')
    s.key('alpha'); s.type_alpha('HI'); s.key('alpha'); s.type_alpha('x')       # ABC -> "HI", abc -> "x"
    s.key('alpha'); s.key('k4', 'k2')                                          # 123 mode: digits "42"
    s.key('second', 'decpnt')                                                  # 2nd + . = ':'
    s.key('dele')                                                              # delete the ':'
    s.snap('typed')
    s.key('clear'); s.snap('blockmode'); s.key('clear'); s.snap('saved')
    d = s.dump('NKP0001'); d2 = s.dump('NKIDX')
    s.key('clear', 'clear')
    finish(s, binp)
    title, blocks = parse_page(open(d, 'rb').read())
    orig = parse_page(sample_text_page())[1]
    eq(blocks[0], ('text', orig[0][1] + 'HIx42'), 'typed text appended to block 0')
    eq(blocks[1], orig[1], 'other block untouched')
    eq(title, 'Hello notes')
    check('DUMP NKP0001' in s.log and 'arch=0' in s.log, 'edited page must be re-created as a RAM appvar:\n' + s.log)
    eq(open(d2, 'rb').read(), nkpack.build_index([('NKP0001', 'Hello notes'), ('NKP0002', 'Pictures')]), 'index untouched')
    check('Saved' in footer(s.shots['saved']), footer(s.shots['saved']))
    check('[abc]' not in footer(s.shots['typed']) and '[123]' in footer(s.shots['typed']), footer(s.shots['typed']))
    # the caret cell is drawn (yellow) in text mode
    c = s.shots['caret']
    check(any(c.getpixel((x, y))[0] > 200 and c.getpixel((x, y))[2] < 120 for x in range(2, 320) for y in range(14, 120)), 'no caret visible')
    s.shots['typed'].save(os.path.join(OUT, 'editing.png'))


@test
def newline_and_caret_navigation(binp):
    s = Session('nav')
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Nav')]))
    s.appvar('NKP0001', nkpack.build_page('Nav', [('text', 'one two\nthree\n' + 'A' * 60)]))
    open_page(s); edit_text(s)                              # caret at the very end
    s.key('up'); s.key('up')                                # col 0 of line 3 -> wrapped line 2? see below
    s.key('alpha'); s.type_alpha('Z')                       # inserts 'Z' at the caret
    s.key('enter')                                          # newline
    s.key('left', 'left'); s.key('right')                   # move around
    s.key('alpha'); s.key('k7')                             # alpha off, then '7'
    s.key('clear', 'clear')
    d = s.dump('NKP0001')
    s.key('clear', 'clear')
    finish(s, binp)
    text = parse_page(open(d, 'rb').read())[1][0][1]
    # Lines: "one two" / "three" / 53 A's (hard break) / 7 A's, caret starts after the last A.
    # Up -> line 2 col 7; Up -> line 1, col clamped to its length 5 = end of "three".
    # 'Z' goes there, Enter adds a newline, Left Left Right puts the caret after Z, then ALPHA (abc) + '7' key = 'o'.
    eq(text, 'one two\nthreeZo\n\n' + 'A' * 60)


@test
def block_operations(binp):
    s = Session('blocks')
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Blocks')]))
    s.appvar('NKP0001', nkpack.build_page('Blocks', [('text', 'first'), ('text', 'second'), ('text', 'third')]))
    open_page(s)
    s.key('enter')                                  # edit mode, block 0 selected
    s.key('rparen'); s.snap('moved_down')           # move "first" below "second"
    s.key('add')                                    # new empty block after it (selected)
    s.key('enter'); s.key('alpha'); s.type_alpha('NEW'); s.key('clear')   # type NEW into it
    s.key('down'); s.key('dele'); s.snap('confirm'); s.key('enter')       # delete "third"
    s.key('up'); s.key('up'); s.key('lparen')                              # select "second"... then move up
    s.snap('after')
    s.key('clear')                                  # save + leave edit
    d = s.dump('NKP0001'); s.key('clear', 'clear')
    finish(s, binp)
    blocks = parse_page(open(d, 'rb').read())[1]
    texts = [b[1] for b in blocks]
    eq(texts, ['second', 'first', 'NEW'], 'move down, insert+type, delete')
    check('Delete this block' in footer(s.shots['confirm']), footer(s.shots['confirm']))
    check(len(texts) == 3 and 'third' not in texts, 'third deleted: %r' % texts)


@test
def missing_index_message(binp):
    s = Session('noidx'); s.idle(1); s.snap('m'); s.key('clear')
    finish(s, binp)
    im = s.shots['m']
    check(decode_row(im, 60, 8, 50).startswith('NKIDX appvar not found'), decode_row(im, 60, 8, 50))


@test
def bad_page_reports_error_and_stays(binp):
    s = Session('bad')
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Ghost'), ('NKP0002', 'Junk')]))
    s.appvar('NKP0002', b'NOPE' + b'\0' * 40)
    s.idle(1); s.key('enter'); s.idle(1); s.snap('missing'); s.key('down', 'enter'); s.idle(1); s.snap('junk'); s.key('clear')
    finish(s, binp)
    eq(footer(s.shots['missing']), 'PAGE FILE NOT FOUND'); eq(footer(s.shots['junk']), 'PAGE FILE NOT FOUND')
    eq(header(s.shots['junk']), 'NOTEKEEPER   pick a page')


@test
def ram_appvars_also_work(binp):
    s = Session('ram')
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Hello notes')]), archived=False)
    s.appvar('NKP0001', sample_text_page(), archived=False)
    open_page(s); s.snap('r'); s.key('clear', 'clear')
    finish(s, binp)
    check(rows(s.shots['r'])[0].startswith('This is a note about'), rows(s.shots['r'])[0])


import random


def rand_text(rng, max_lines=14):
    """Text that stresses the wrapper: long words, runs of spaces, newlines, lines near 53 columns."""
    words = ['a', 'to', 'note', 'calculator', 'X' * 20, 'Y' * 53, 'Z' * 54, 'Q' * 80, 'wrapping', 'edge-case', '12345']
    out = []
    for _ in range(rng.randint(1, 40)):
        r = rng.random()
        if r < 0.15: out.append('\n')
        elif r < 0.30: out.append(' ' * rng.randint(1, 4))
        else: out.append(rng.choice(words) + rng.choice([' ', ' ', '', '  ']))
    t = ''.join(out)
    while len(wrap_ref(t)) > max_lines: t = t[:len(t) * 3 // 4]
    return t


@test
def wrap_fuzz_matches_reference(binp):
    rng = random.Random(1234)
    for case in range(12):
        texts = [rand_text(rng) for _ in range(3)]
        s = Session('wf%d' % case)
        names = []
        for i, t in enumerate(texts):
            names.append(('NKP%04d' % (i + 1), 'T%d' % i)); s.appvar(names[-1][0], nkpack.build_page('T%d' % i, [('text', t)]))
        s.appvar('NKIDX', nkpack.build_index(names))
        s.idle(1)
        for i in range(3):
            if i: s.key('down')
            s.key('enter'); s.idle(1); s.snap('t%d' % i); s.key('clear')
        s.key('clear')
        finish(s, binp)
        for i, t in enumerate(texts):
            if not t.strip('\n '): continue
            t = nkpack.ascii_clean(t)
            want = [t[a:a + n] for a, n in wrap_ref(t)]
            got = rows(s.shots['t%d' % i], 14, len(want))
            # trailing spaces are invisible: compare right-stripped
            eq(got, [w.rstrip() for w in want], 'case %d text %d: %r' % (case, i, t))


@test
def edit_fuzz_matches_model(binp):
    rng = random.Random(99)
    for case in range(10):
        base = rand_text(rng, 8)
        base = nkpack.ascii_clean(base)
        m = EditModel(base)
        s = Session('ef%d' % case)
        s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'F')])); s.appvar('NKP0001', nkpack.build_page('F', [('text', base)]))
        open_page(s); edit_text(s)
        s.key('alpha')                                       # ABC mode so letters can be typed
        for _ in range(30):
            op = rng.choice(['left', 'right', 'up', 'down', 'ins', 'ins', 'nl', 'back'])
            if op in ('left', 'right', 'up', 'down'):
                s.key(op); getattr(m, op)()
            elif op == 'ins':
                ch = rng.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ'); s.key(LETTER_KEY[ch]); m.ins(ch)
            elif op == 'nl':
                s.key('enter'); m.ins('\n')
            else:
                s.key('dele'); m.back()
        s.key('clear', 'clear')
        d = s.dump('NKP0001'); s.key('clear', 'clear')
        finish(s, binp)
        got = parse_page(open(d, 'rb').read())[1][0][1]
        eq(got, m.t, 'case %d (start %r)' % (case, base))


@test
def caret_stays_visible_in_long_text(binp):
    s = Session('caretvis')
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Long page')])); s.appvar('NKP0001', long_page())
    open_page(s); edit_text(s); s.snap('end')
    for _ in range(40): s.key('up')
    s.snap('mid')
    for _ in range(300): s.key('up')
    s.snap('home')
    s.key('clear', 'clear', 'clear', 'clear')
    finish(s, binp)
    def caret_visible(im): return any(im.getpixel((x, y))[0] > 200 and im.getpixel((x, y))[2] < 120 and im.getpixel((x, y))[1] > 150
                                       for x in range(2, 320, 2) for y in range(14, 226))
    for t in ('end', 'mid', 'home'):
        check(caret_visible(s.shots[t]), 'caret not visible after scrolling (%s)' % t)
    check(find_text(s.shots['home'], 'Line number 1 of'), 'home shows the top of the text')
    check(find_text(s.shots['end'], 'Line number 60 of') or find_text(s.shots['end'], 'Line number 5'), 'end shows the bottom of the text')


@test
def empty_page_and_255_blocks(binp):
    s = Session('limits')
    full = nkpack.build_page('Full', [('text', 'b%d' % i) for i in range(255)])
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Empty'), ('NKP0002', 'Full')]))
    s.appvar('NKP0001', nkpack.build_page('Empty', []))
    s.appvar('NKP0002', full)
    open_page(s); s.snap('empty_read')
    s.key('enter'); s.key('add'); s.key('enter'); s.key('alpha'); s.type_alpha('HI'); s.key('clear', 'clear')   # add a block to the empty page
    d = s.dump('NKP0001'); s.key('clear')
    s.key('down', 'enter'); s.idle(1)                                   # open the 255-block page
    s.key('enter'); s.key('add'); s.key('add'); s.snap('full_edit')     # must refuse to exceed 255 blocks
    d2 = s.dump('NKP0002'); s.key('clear', 'clear', 'clear')
    finish(s, binp)
    msg = decode_row(s.shots['empty_read'], 18, 4, 50)
    check(msg.startswith('(empty page'), msg)
    eq(parse_page(open(d, 'rb').read())[1], [('text', 'HI')], 'block added to an empty page')
    check('DUMP NKP0002 missing' not in s.log, s.log)
    eq(len(parse_page(open(d2, 'rb').read())[1]), 255, 'block count capped at 255')


@test
def edit_image_blocks(binp):
    s = standard_session('imgedit')
    open_page(s, 1)                                    # Pictures: [text, img0, img1, text]
    s.key('enter', 'down'); s.snap('sel')              # select first image
    s.key('rparen')                                    # move it below the second image
    s.key('down', 'dele', 'enter')                     # then delete the text block that is now after... (index 3 = last text)
    s.key('clear'); d = s.dump('NKP0002'); s.key('clear', 'clear')
    finish(s, binp)
    blocks = parse_page(open(d, 'rb').read())[1]
    eq([b[0] if b[0] == 'text' else b[1] for b in blocks], ['text', 'NKI00021', 'NKI00020'], blocks)
    check(s.shots['sel'].getpixel((0, 40)) != s.shots['sel'].getpixel((10, 40)), 'selection marker bar missing on image block')


@test
def out_of_memory_keeps_original(binp):
    s = standard_session('oom')
    s.appvar('HOGHOGHO', b'\0' * 63438, archived=False)                 # eat nearly all of the harness's fake RAM heap
    s.appvar('HOGHOGH2', b'\0' * 63438, archived=False)
    open_page(s); edit_text(s); s.key('alpha'); s.type_alpha('Q'); s.key('clear', 'clear'); s.snap('after')
    d = s.dump('NKP0001'); s.key('clear', 'clear')
    finish(s, binp)
    check('NOT ENOUGH MEMORY' in footer(s.shots['after']), footer(s.shots['after']))
    eq(open(d, 'rb').read(), sample_text_page(), 'page untouched when it cannot be saved')


@test
def resave_ram_page_twice(binp):
    s = standard_session('twice')
    open_page(s); edit_text(s); s.key('alpha'); s.type_alpha('A'); s.key('clear', 'clear')
    s.key('enter'); s.key('down'); s.key('enter'); s.key('alpha'); s.type_alpha('B'); s.key('clear', 'clear')     # second edit session on the (now RAM) page
    d = s.dump('NKP0001'); s.key('clear', 'clear')
    finish(s, binp)
    blocks = parse_page(open(d, 'rb').read())[1]
    orig = parse_page(sample_text_page())[1]
    eq(blocks[0][1], orig[0][1] + 'A'); eq(blocks[1][1], orig[1][1] + 'B')
    check(s.log.count('NKP0001') >= 1 and 'arch=0' in s.log, s.log)


@test
def forty_page_list(binp):
    s = Session('forty')
    names = [('NKP%04d' % (i + 1), 'Page number %d' % (i + 1)) for i in range(40)]
    s.appvar('NKIDX', nkpack.build_index(names))
    for n, t in names: s.appvar(n, nkpack.build_page(t, [('text', 'body of ' + t)]))
    s.idle(1)
    for _ in range(45): s.key('down')                   # past the end: must stop at the last entry
    s.snap('end'); s.key('enter'); s.idle(1); s.snap('opened'); s.key('clear', 'clear')
    finish(s, binp)
    r = rows(s.shots['end'], 14, 21, 4, 50)
    check(r[-1].startswith('Page number 40'), r)
    check(s.shots['end'].getpixel((250, 14 + 20 * 10 + 2)) != s.shots['end'].getpixel((250, 14 + 19 * 10 + 2)), 'last row should be highlighted')
    eq(header(s.shots['opened']), 'Page number 40')
    check(rows(s.shots['opened'], 14, 1)[0].startswith('body of Page number 40'), rows(s.shots['opened'], 14, 1))


@test
def full_size_text_block(binp):
    s = Session('big')
    txt = ('The quick brown fox jumps over the lazy dog. ' * 100)[:3996]
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Big')])); s.appvar('NKP0001', nkpack.build_page('Big', [('text', txt)]))
    open_page(s); edit_text(s); s.key('alpha'); s.type_alpha('ABCDEFG')              # only 4 of the 7 fit (limit 4000)
    s.key('clear', 'clear'); d = s.dump('NKP0001'); s.key('clear', 'clear')
    finish(s, binp)
    got = parse_page(open(d, 'rb').read())[1][0][1]
    eq(len(got), 4000); eq(got, txt + 'ABCD')


def read_8xv(path):
    """Parse a .8xv written by nkpack: returns (name, content), verifying the container checksum."""
    d = open(path, 'rb').read()
    assert d[:8] == b'**TI83F*'
    dl = struct.unpack('<H', d[0x35:0x37])[0]; entry = d[0x37:0x37 + dl]
    assert struct.unpack('<H', d[0x37 + dl:0x39 + dl])[0] == sum(entry) & 0xFFFF, 'bad checksum'
    assert entry[4] == 0x15
    n = struct.unpack('<H', entry[15:17])[0]; size = struct.unpack('<H', entry[17:19])[0]
    assert n == size + 2 and len(entry) == 19 + size
    return entry[5:13].rstrip(b'\0').decode(), entry[19:]


@test
def shipped_samples_load(binp):
    sd = os.path.join(ROOT, 'samples')
    s = Session('samples')
    for f in sorted(os.listdir(sd)):
        if f.endswith('.8xv'):
            name, content = read_8xv(os.path.join(sd, f)); s.appvar(name, content)
    s.idle(1)
    for i in range(3):
        if i: s.key('down')
        s.key('enter'); s.idle(1); s.snap('p%d' % i); s.key('clear')
    s.key('clear')
    finish(s, binp)
    eq([header(s.shots['p%d' % i]) for i in range(3)], ['Welcome', 'Sending pages', 'Diagram'])
    check(find_text(s.shots['p0'], 'READING'), 'Welcome page text rendered')
    d = s.shots['p2']
    check(sum(1 for x in range(0, 320, 3) for y in range(20, 200, 3) if d.getpixel((x, y))[0] > 200 and d.getpixel((x, y))[1] > 150 and d.getpixel((x, y))[2] < 120) > 20, 'yellow curve visible in Diagram')
    for i in range(3): s.shots['p%d' % i].save(os.path.join(OUT, 'sample%d.png' % i))


def main():
    flt = sys.argv[1] if len(sys.argv) > 1 else ''
    binp = build()
    fails = 0
    for t in TESTS:
        if flt not in t.__name__: continue
        try:
            t(binp); print('PASS', t.__name__)
        except Exception as e:
            fails += 1; print('FAIL', t.__name__); traceback.print_exc(limit=3)
    print('ALL PASSED' if not fails else '%d FAILED' % fails)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
