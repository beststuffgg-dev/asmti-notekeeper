"""Shared helpers for driving the CEmu harness: key names, fixtures, running, screenshots."""
import os, re, struct, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import nkpack

SPASM = os.environ.get('SPASM', '/tmp/work/spasm-ng/spasm')
SPASM_INC = os.environ.get('SPASM_INC', '/tmp/work/spasm-ng/inc')
HARNESS = os.environ.get('NK_HARNESS', '/tmp/work/harness')

KEYS = dict(down=0x01, left=0x02, right=0x03, up=0x04, enter=0x09, add=0x0A, sub=0x0B, mul=0x0C, div=0x0D,
            power=0x0E, clear=0x0F, chs=0x11, rparen=0x15, tan=0x16, vars=0x17, decpnt=0x19, lparen=0x1D,
            cos=0x1E, prgm=0x1F, stat=0x20, comma=0x25, sin=0x26, matrix=0x27, store=0x2A, ln=0x2B, log=0x2C,
            square=0x2D, recip=0x2E, math=0x2F, alpha=0x30, graph=0x31, trace=0x32, zoom=0x33, window=0x34,
            yequ=0x35, second=0x36, mode=0x37, dele=0x38,
            k0=0x21, k1=0x22, k2=0x1A, k3=0x12, k4=0x23, k5=0x1B, k6=0x13, k7=0x24, k8=0x1C, k9=0x14)
# letter -> physical key (what the user presses with ALPHA active)
LETTER_KEY = dict(zip('ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ['math', 'matrix', 'prgm', 'recip', 'sin', 'cos', 'tan', 'power', 'square', 'comma', 'lparen', 'rparen',
     'div', 'log', 'k7', 'k8', 'k9', 'mul', 'ln', 'k4', 'k5', 'k6', 'sub', 'store', 'k1', 'k2']))


def build(src=None, out=None):
    src = src or os.path.join(ROOT, 'src', 'notes.asm')
    out = out or os.path.join(ROOT, 'build', 'NOTES.8xp')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = subprocess.run([SPASM, '-E', '-I', SPASM_INC, '-I', os.path.dirname(src), src, out], capture_output=True, text=True)
    if r.returncode or 'error' in (r.stdout + r.stderr).lower():
        raise SystemExit('assembly failed:\n' + r.stdout + r.stderr)
    d = open(out, 'rb').read()
    size = d[0x48] | d[0x49] << 8
    body = d[0x4A:0x4A + size]
    assert body[:2] == b'\xEF\x7B'
    binp = out[:-4] + '.bin'
    open(binp, 'wb').write(body[2:])
    return binp


class Session:
    """One emulator run: add appvars, queue keys / snapshots, run, inspect results."""
    def __init__(self, name, workdir=None):
        self.dir = workdir or tempfile.mkdtemp(prefix='nk_' + name + '_')
        self.lines = []
        self.vars = {}
        self.name = name

    def appvar(self, name, content, archived=True):
        p = os.path.join(self.dir, name + '.bin')
        open(p, 'wb').write(content)
        self.lines.append('appvar %s %s %d' % (name, p, 1 if archived else 0))

    def idle(self, n=1):
        self.lines.append('idle %d' % n)

    def key(self, *names):
        for n in names:
            self.lines.append('k %02x' % (KEYS[n] if isinstance(n, str) else n))

    def snap(self, tag):
        self.lines.append('snap ' + tag)

    def type_alpha(self, text):
        """Type text assuming ALPHA mode ABC / abc is already selected: letters only (+ space via 0)."""
        for ch in text:
            if ch == ' ':
                self.key('k0')
            else:
                self.key(LETTER_KEY[ch.upper()])

    def dump(self, name):
        p = os.path.join(self.dir, 'dump_' + name + '.bin')
        self.lines.append('dump %s %s' % (name, p))
        return p

    def run(self, binpath):
        script = os.path.join(self.dir, 'script.txt')
        open(script, 'w').write('\n'.join(self.lines) + '\n')
        out = os.path.join(self.dir, 'out'); os.makedirs(out, exist_ok=True)
        r = subprocess.run([HARNESS, binpath, script, out], capture_output=True, text=True, timeout=300)
        self.log = r.stdout
        self.rc = r.returncode
        from PIL import Image
        self.shots = {}
        for f in sorted(os.listdir(out)):
            if f.endswith('.ppm'):
                tag = f[4:-4]
                im = Image.open(os.path.join(out, f)).convert('RGB')
                im.save(os.path.join(out, f[:-4] + '.png'))
                self.shots[tag] = im
        return self


def sample_text_page():
    para = ("This is a note about the Notekeeper program. It wraps long lines at word boundaries so the text "
            "stays readable on the 320 by 240 screen of the calculator.\n\nSecond paragraph, shorter.\n"
            "A line that is exactly long enough to need a hard break: " + 'X' * 70)
    return nkpack.build_page('Hello notes', [('text', para), ('text', 'Second block of text.')])


def sample_image_page():
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (160, 100), (30, 90, 200)); d = ImageDraw.Draw(im)
    d.rectangle([10, 10, 150, 90], outline=(255, 255, 0), width=3); d.ellipse([50, 25, 110, 75], fill=(220, 40, 40))
    im2 = Image.new('RGB', (100, 60), (20, 160, 60)); ImageDraw.Draw(im2).line([0, 0, 99, 59], fill=(255, 255, 255), width=3)
    pal, data = nkpack.quantize([im, im2])
    vars_ = {}
    blocks = [('text', 'Two pictures follow.')]
    for k, (w, h, px) in enumerate(data):
        vars_['NKI00020%d' % k if False else 'NKI0002%d' % k] = px
        blocks.append(('image', 'NKI0002%d' % k, w, h))
    blocks.append(('text', 'End of page.'))
    return nkpack.build_page('Pictures', blocks, pal), vars_


def standard_session(name):
    s = Session(name)
    t = sample_text_page()
    ip, ivars = sample_image_page()
    s.appvar('NKIDX', nkpack.build_index([('NKP0001', 'Hello notes'), ('NKP0002', 'Pictures')]))
    s.appvar('NKP0001', t)
    s.appvar('NKP0002', ip)
    for k, v in ivars.items():
        s.appvar(k, v)
    return s
