/*
 * Test harness: runs a TI-84 Plus CE native program inside the CEmu core without a TI ROM.
 *
 *  - A dummy ROM is used; OS routines the program calls are "spin stubs" (jr $) at their real
 *    jump-table addresses. When the CPU parks on one, this file services the call in C
 *    (key queue, appvar lookup/create/delete) and returns to the caller.
 *  - A script (see tests/run_tests.py) feeds keys, requests screenshots, preloads appvars
 *    and dumps appvars after the run.
 *
 * usage: harness program.bin script.txt outdir
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "emu.h"
#include "cpu.h"
#include "mem.h"
#include "lcd.h"
#include "asic.h"

/* ---- callbacks required by the core ---- */
void gui_console_clear(void) {}
void gui_console_printf(const char *f, ...) { (void)f; }
void gui_console_err_printf(const char *f, ...) { va_list a; va_start(a, f); vfprintf(stderr, f, a); va_end(a); }
asic_rev_t gui_handle_reset(const boot_ver_t *b, asic_rev_t l, asic_rev_t d, emu_device_t dev, bool *py) {
    (void)b; (void)l; (void)dev; (void)py; return d;
}

#define USERMEM   0xD1A881u
#define OP1       0xD005F8u
#define HEAP_BASE 0xD20000u
#define HEAP_END  0xD3F000u
#define ARC_BASE  0x200000u          /* "archive" lives in the flash block */
#define DONE_ADDR 0x000100u

enum { S_GETCSC = 0x02014C, S_MOV9 = 0x020320, S_CHK = 0x02050C, S_ENOUGH = 0x02051C,
       S_CREATE = 0x021330, S_CREATEVAR = 0x021338, S_DELARC = 0x021434, S_ARCUN = 0x021448, S_CHKINRAM = 0x021F98,
       S_CLRLCD = 0x020808, S_HOMEUP = 0x020828, S_STATBAR = 0x021A3C };
static const uint32_t stubs[] = { S_GETCSC, S_MOV9, S_CHK, S_ENOUGH, S_CREATE, S_CREATEVAR, S_DELARC, S_ARCUN,
                                  S_CHKINRAM, S_CLRLCD, S_HOMEUP, S_STATBAR };

typedef struct { char name[9]; uint8_t type; int arch; uint32_t entry; uint32_t addr; uint32_t size; int used; } var_t;
static var_t vars[64];
static uint32_t heap_ptr = HEAP_BASE, arc_ptr = ARC_BASE;

typedef struct { int kind; int val; char name[64]; } qent_t;   /* kind 0 key, 1 snap */
static qent_t *queue; static int qlen, qpos;
static const char *outdir;
static int snapno;

static uint8_t rd8(uint32_t a) { return mem_peek_byte(a); }
static void ram_poke(uint32_t a, uint8_t v) { mem_poke_byte(a, v); }
static void put_bytes(uint32_t a, const uint8_t *p, uint32_t n) {
    for (uint32_t i = 0; i < n; i++) {
        if (a + i >= ARC_BASE && a + i < 0x400000) mem.flash.block[a + i] = p[i];
        else ram_poke(a + i, p[i]);
    }
}
static uint8_t peekany(uint32_t a) { return (a >= ARC_BASE && a < 0x400000) ? mem.flash.block[a] : rd8(a); }

static var_t *find_var(uint8_t type, const char *name) {
    for (int i = 0; i < 64; i++) if (vars[i].used && vars[i].type == type && !strncmp(vars[i].name, name, 8)) return &vars[i];
    return NULL;
}
static var_t *add_var(uint8_t type, const char *name, uint32_t size, int arch) {
    for (int i = 0; i < 64; i++) if (!vars[i].used) {
        var_t *v = &vars[i]; memset(v, 0, sizeof *v);
        strncpy(v->name, name, 8); v->type = type; v->arch = arch; v->size = size; v->used = 1;
        uint32_t need = size + 2;
        if (arch) {
            /* archived layout as the OS leaves it: 9 bytes of header, name length, name, then [size word][data] */
            uint32_t nl = (uint32_t)strlen(v->name), hdr = 9 + 1 + nl;
            v->entry = arc_ptr; v->addr = arc_ptr + hdr;
            uint8_t h[32] = {0}; h[9] = (uint8_t)nl; memcpy(h + 10, v->name, nl);
            put_bytes(v->entry, h, hdr);
            arc_ptr += hdr + need;
        } else {
            if (heap_ptr + need > HEAP_END) { v->used = 0; return NULL; }
            v->entry = v->addr = heap_ptr; heap_ptr += need;
        }
        uint8_t hdr[2] = { size & 255, size >> 8 };
        put_bytes(v->addr, hdr, 2);
        return v;
    }
    return NULL;
}
static void op1_name(char *name) { for (int i = 0; i < 8; i++) name[i] = (char)rd8(OP1 + 1 + i); name[8] = 0; }

static void snapshot(const char *tag) {
    char path[512]; snprintf(path, sizeof path, "%s/%03d_%s.ppm", outdir, snapno++, tag);
    FILE *f = fopen(path, "wb"); if (!f) return;
    fprintf(f, "P6\n320 240\n255\n");
    int bpp = (lcd.control >> 1) & 7;
    int bgr = (lcd.control >> 8) & 1;
    uint32_t base = lcd.upbase;
    for (int y = 0; y < 240; y++) for (int x = 0; x < 320; x++) {
        uint16_t c;
        if (bpp == 3) c = lcd.palettes[bgr][rd8(base + y * 320 + x)];
        else { uint32_t a = base + (y * 320 + x) * 2; uint16_t w = rd8(a) | rd8(a + 1) << 8;
               c = (bpp == 6) ? w : (uint16_t)(((w & 0x7FE0) << 1) | (w & 0x1F)); } /* 565 / 1555 (approx) */
        uint8_t rgb[3] = { (c >> 11 & 31) * 255 / 31, (c >> 5 & 63) * 255 / 63, (c & 31) * 255 / 31 };
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    printf("SNAP %s lcdctrl=%06X bpp=%d upbase=%06X\n", path, lcd.control, bpp, base);
}

static void ret_to_caller(void) {
    uint32_t sp = cpu.registers.SPL;
    uint32_t ra = mem_peek_long(sp) & 0xFFFFFF;
    cpu.registers.SPL = sp + 3;
    cpu_flush(ra, true);
}

static int service(uint32_t stub) {
    switch (stub) {
    case S_GETCSC: {
        uint8_t a = 0;
        while (qpos < qlen && queue[qpos].kind == 1) snapshot(queue[qpos++].name);
        if (qpos >= qlen) return 1;                      /* script exhausted */
        a = (uint8_t)queue[qpos++].val;
        cpu.registers.A = a;
        break; }
    case S_MOV9: for (int i = 0; i < 9; i++) ram_poke(OP1 + i, peekany(cpu.registers.HL + i)); break;
    case S_CHK: {
        char n[9]; op1_name(n); var_t *v = find_var(rd8(OP1), n);
        if (!v) { cpu.registers.flags.C = 1; break; }
        cpu.registers.flags.C = 0; cpu.registers.A = v->type;
        cpu.registers.B = v->arch ? 0xFE : 0; cpu.registers.DE = v->entry; cpu.registers.HL = 0xD01234;
        break; }
    case S_ENOUGH: {
        uint32_t need = cpu.registers.HL & 0xFFFFFF;
        cpu.registers.flags.C = (heap_ptr + need + 2 > HEAP_END) ? 1 : 0; break; }
    case S_CREATEVAR:
        if (cpu.registers.A != rd8(OP1)) { fprintf(stderr, "HARNESS: CreateVar type A=%02X but OP1 type=%02X\n", cpu.registers.A, rd8(OP1)); return 2; }
        /* fall through */
    case S_CREATE: {
        char n[9]; op1_name(n); uint32_t size = cpu.registers.HL & 0xFFFFFF;
        if (find_var(rd8(OP1), n)) { fprintf(stderr, "HARNESS: CreateAppVar on existing var %s\n", n); return 2; }
        var_t *v = add_var(rd8(OP1), n, size, 0);
        if (!v) { fprintf(stderr, "HARNESS: out of memory in CreateAppVar\n"); return 2; }
        cpu.registers.DE = 0xDEAD00;                     /* poison: real return value convention not relied on */
        break; }
    case S_DELARC: {
        char n[9]; op1_name(n); var_t *v = find_var(rd8(OP1), n); if (v) v->used = 0; break; }
    case S_ARCUN: break;
    case S_CHKINRAM: cpu.registers.flags.Z = ((cpu.registers.DE & 0xFFFFFF) >= 0xD00000) ? 1 : 0; break;
    case S_CLRLCD: case S_HOMEUP: case S_STATBAR: break;
    }
    ret_to_caller();
    return 0;
}

static uint8_t *slurp(const char *p, long *n) {
    FILE *f = fopen(p, "rb"); if (!f) { perror(p); exit(3); }
    fseek(f, 0, SEEK_END); *n = ftell(f); rewind(f);
    uint8_t *b = malloc(*n + 1); if (fread(b, 1, *n, f) != (size_t)*n) exit(3); fclose(f); return b;
}

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: harness prog.bin script outdir\n"); return 3; }
    outdir = argv[3];
    char rompath[512]; snprintf(rompath, sizeof rompath, "%s/dummy.rom", outdir);
    FILE *rf = fopen(rompath, "wb"); if (!rf) { perror(rompath); return 3; }
    static uint8_t zeros[0x1000]; memset(zeros, 0xFF, sizeof zeros); fwrite(zeros, 1, sizeof zeros, rf); fclose(rf);
    emu_load(EMU_DATA_ROM, rompath);
    if (!mem.flash.block || mem.flash.size < 0x400000) {
        /* core rounds the ROM up; make sure we have room for fake archive */
        fprintf(stderr, "flash size %u too small\n", mem.flash.size); return 3;
    }
    for (size_t i = 0; i < sizeof stubs / sizeof *stubs; i++) { mem.flash.block[stubs[i]] = 0x18; mem.flash.block[stubs[i] + 1] = 0xFE; }
    mem.flash.block[DONE_ADDR] = 0x18; mem.flash.block[DONE_ADDR + 1] = 0xFE;

    emu_run(100);                 /* let the core consume its pending reset before we take over the CPU */
    long plen; uint8_t *prog = slurp(argv[1], &plen);
    put_bytes(USERMEM, prog, (uint32_t)plen);

    /* script */
    FILE *sf = fopen(argv[2], "r"); if (!sf) { perror(argv[2]); return 3; }
    char line[1024]; int cap = 4096; queue = malloc(cap * sizeof *queue);
    char dumps[32][2][256]; int ndumps = 0;
    while (fgets(line, sizeof line, sf)) {
        char a[256], b[256]; int n, arch;
        if (line[0] == '#' || line[0] == '\n') continue;
        if (qlen + 4 >= cap) { cap *= 2; queue = realloc(queue, cap * sizeof *queue); }
        if (sscanf(line, "k %x", &n) == 1) { queue[qlen].kind = 0; queue[qlen++].val = n; }
        else if (sscanf(line, "idle %d", &n) == 1) { while (n-- > 0) { queue[qlen].kind = 0; queue[qlen++].val = 0; } }
        else if (sscanf(line, "snap %255s", a) == 1) { queue[qlen].kind = 1; strncpy(queue[qlen++].name, a, 63); }
        else if (sscanf(line, "appvar %255s %255s %d", a, b, &arch) == 3) {
            long l; uint8_t *d = slurp(b, &l); var_t *v = add_var(0x15, a, (uint32_t)l, arch);
            if (!v) { fprintf(stderr, "preload failed %s\n", a); return 3; }
            put_bytes(v->addr + 2, d, (uint32_t)l); free(d);
        }
        else if (sscanf(line, "dump %255s %255s", a, b) == 2) { strcpy(dumps[ndumps][0], a); strcpy(dumps[ndumps][1], b); ndumps++; }
    }
    fclose(sf);

    /* LCD timing like the OS leaves it: the core's LCD events need non-zero porch values or time never advances */
    lcd.timing[0] = 0x0A0A0A4C; lcd.timing[1] = 0x0A010CEF; lcd.timing[2] = 0x013F0002; lcd.timing[3] = 0;
    lcd.upbase = 0xD40000;

    /* CPU setup */
    memset(&cpu.registers, 0, sizeof cpu.registers);
    cpu.ADL = 1; cpu.L = 1; cpu.IL = 1; cpu.MADL = 1;
    cpu.registers.SPL = 0xD3F000 - 3; mem_poke_long(cpu.registers.SPL, DONE_ADDR);
    cpu.registers.MBASE = 0xD0;
    cpu.IEF1 = cpu.IEF2 = false; cpu.IEF_wait = false; cpu.NMI = false; cpu.halted = false; cpu.IM = 1;
    cpu_flush(USERMEM, true);

    int status = 0; uint64_t total = 0, limit = 3000000ull   /* chunks of ~10k cycles each */;
    for (;;) {
        emu_run(1); total += 1;
        uint32_t pc = cpu.registers.PC & 0xFFFFFF;
        if (pc >= DONE_ADDR && pc <= DONE_ADDR + 3) { printf("EXIT program returned, HL=%06X\n", cpu.registers.HL); break; }
        int hit = -1;
        for (size_t i = 0; i < sizeof stubs / sizeof *stubs; i++) if (pc >= stubs[i] && pc <= stubs[i] + 3) hit = (int)i;
        if (hit >= 0) { int r = service(stubs[hit]); if (r) { printf("EXIT %s\n", r == 1 ? "script exhausted" : "harness error"); status = r == 1 ? 0 : 2; break; } }
        if (total > limit) { printf("EXIT timeout pc=%06X\n", pc); status = 4; break; }
    }
    snapshot("final");
    for (int i = 0; i < ndumps; i++) {
        var_t *v = find_var(0x15, dumps[i][0]);
        FILE *o = fopen(dumps[i][1], "wb");
        if (v && o) { for (uint32_t k = 0; k < v->size; k++) fputc(peekany(v->addr + 2 + k), o); printf("DUMP %s %u bytes arch=%d\n", v->name, v->size, v->arch); }
        else printf("DUMP %s missing\n", dumps[i][0]);
        if (o) fclose(o);
    }
    printf("TICKS %llu\n", (unsigned long long)total);
    return status;
}
