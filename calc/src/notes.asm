; ============================================================================
;  NOTES - Notekeeper for the TI-84 Plus CE / TI-83 Premium CE  (native eZ80 program)
;
;  Reads pages (text + 8-bit images) from appvars made by tools/nkpack.py or the web exporter,
;  shows them with a 6x9 font, and lets you edit text and arrange blocks on the calculator.
;
;  Assemble:  spasm -E -I <spasm>/inc src/notes.asm NOTES.8xp
;  Needs an OS that runs native programs (older OS, or arTIfiCE / AsmHook2 / Cesium on newer ones).
;
;  Rules this code follows so it behaves on real hardware:
;   - IY is never touched (the OS keeps its flag base in it); IX is only used inside drawing code.
;   - loop state is kept in RAM, not registers, across OS calls.
;   - the LCD is put back to 16 bpp before returning.
; ============================================================================
#include "ti84pce.inc"
.db tExtTok,tAsm84CeCmp
.org userMem
.assume ADL=1

; ---------------------------------------------------------------- constants
LCD_UPBASE  equ 0E30010h
COLS        equ 53            ; characters per row (53*6 = 318 px)
LINE_H      equ 10            ; pixels per text row
GAP         equ 6             ; pixels between blocks
CTOP        equ 14            ; content area: rows CTOP .. CBOT-1
CBOT        equ 227
VIEW_H      equ 213           ; CBOT-CTOP
MAXPAGE     equ 60000         ; largest page file we load / save
MAXTEXT     equ 4000          ; largest single text block
SCROLL_STEP equ 20
PAGE_STEP   equ 190
LIST_ROWS   equ 21

ST_LIST     equ 0
ST_READ     equ 1
ST_EDIT     equ 2
ST_TEXT     equ 3

C_BG        equ 0
C_TXT       equ 1
C_DIM       equ 2
C_BAR       equ 3
C_BART      equ 4
C_SEL       equ 5
C_ACC       equ 6
C_ERR       equ 7
C_OK        equ 8

; ---------------------------------------------------------------- RAM map
; Everything lives in the unused second half of the 8 bpp frame buffer (D52C00..D65800) so the
; program file stays tiny and no OS RAM is disturbed.
WS          equ 0D52C00h      ; variables (256 bytes)
tbl_top     equ 0D52D00h      ; block top  (24-bit) per block, 255 entries
tbl_h       equ 0D53000h      ; block height (24-bit) per block
IDXBASE     equ 0D53300h      ; copy of NKIDX (1 + 40*32 = 1281 bytes)
PAGEBUF     equ 0D53C00h      ; working copy of the open page (<= MAXPAGE)
TMPBUF      equ 0D63000h      ; scratch for swapping blocks (8 KB)

v_fg        equ WS+0          ; colours read together with  ld bc,(v_fg)  -> C=fg, B=bg
v_bg        equ WS+1
v_cnt       equ WS+4
v_state     equ WS+5
v_nPages    equ WS+6
v_sel       equ WS+7
v_listTop   equ WS+8
v_nBlocks   equ WS+9
v_selBlk    equ WS+10
v_alpha     equ WS+11         ; 0=123  1=ABC  2=abc
v_second    equ WS+12
v_viewEdit  equ WS+13
v_dirty     equ WS+14
v_confirm   equ WS+15
v_curName   equ WS+16         ; 9 bytes
v_hdrSize   equ WS+32
v_pageSize  equ WS+35
v_scroll    equ WS+38
v_docH      equ WS+41
v_caret     equ WS+44
v_cLine     equ WS+47
v_cStart    equ WS+50
v_cCol      equ WS+53
v_blkPtr    equ WS+56
wr_start    equ WS+59
wr_rem      equ WS+62
wr_last     equ WS+65
wr_term     equ WS+68
v_msg       equ WS+69
v_key       equ WS+72
v_i         equ WS+73
v_bi        equ WS+74
v_isSel     equ WS+75
v_ch        equ WS+76
v_newsel    equ WS+77
v_fillc     equ WS+78
v_rh        equ WS+79
v_rw        equ WS+80
v_y         equ WS+83
v_sy        equ WS+86
v_ly        equ WS+89
v_lk        equ WS+92
v_cur       equ WS+95
v_rem       equ WS+98
v_len       equ WS+101
v_nxt       equ WS+104
v_term2     equ WS+107
v_bptr      equ WS+108
v_tp        equ WS+111
v_hp        equ WS+114
v_tptr      equ WS+117
v_tlen      equ WS+120
v_t1        equ WS+123
v_t2        equ WS+126
v_t3        equ WS+129
v_t4        equ WS+132
v_gk        equ WS+135
v_gs        equ WS+138
v_gl        equ WS+141
v_gj        equ WS+144
v_iw        equ WS+147
v_ih        equ WS+150
v_ir        equ WS+153
v_ry        equ WS+156
v_ix0       equ WS+159
v_isrc      equ WS+162
v_rt        equ WS+165
v_rb        equ WS+168
v_k         equ WS+171

; ================================================================ entry
Start:
    call LoadIndex
    jr nc,st_ok
    call GfxInit
    ld a,C_BG
    call ClearScreen
    ld a,C_ERR
    ld b,C_BG
    call SetColors
    ld de,8
    ld a,60
    call PixAddr
    push hl
    pop ix
    ld hl,strNoIdx1
    ld a,50
    call DrawStrZ
    ld a,C_TXT
    ld b,C_BG
    call SetColors
    ld de,8
    ld a,80
    call PixAddr
    push hl
    pop ix
    ld hl,strNoIdx2
    ld a,50
    call DrawStrZ
    ld de,8
    ld a,92
    call PixAddr
    push hl
    pop ix
    ld hl,strNoIdx3
    ld a,50
    call DrawStrZ
    call WaitKey
    jp Exit
st_ok:
    call GfxInit
    xor a
    ld (v_state),a
    ld (v_sel),a
    ld (v_listTop),a
    ld (v_alpha),a
    ld (v_second),a
    ld (v_confirm),a
    ld (v_dirty),a
    ld hl,0
    ld (v_msg),hl

MainLoop:
    call Render
    call WaitKey
    ld b,a
    ld hl,0
    ld (v_msg),hl
    ld a,(v_state)
    or a
    jp z,KeyList
    cp ST_READ
    jp z,KeyRead
    cp ST_EDIT
    jp z,KeyEdit
    jp KeyText

Exit:
    ld a,lcdBpp16
    ld (mpLcdCtrl),a
    call _ClrLCDFull
    call _HomeUp
    call _DrawStatusBar
    ret

WaitKey:
    call _GetCSC
    or a
    jr z,WaitKey
    ret

; ================================================================ graphics primitives
GfxInit:
    ld hl,vRam
    ld (LCD_UPBASE),hl
    ld a,lcdBpp8
    ld (mpLcdCtrl),a
    ld hl,mpLcdPalette+32
    ld (hl),0
    ld de,mpLcdPalette+33
    ld bc,447
    ldir
    ld hl,uiPalette
    ld de,mpLcdPalette
    ld bc,32
    ldir
    ret

; A = colour index; fills the whole 320x240 frame
ClearScreen:
    ld hl,vRam
    ld (hl),a
    ld de,vRam+1
    ld bc,76799
    ldir
    ret

; A = fg, B = bg
SetColors:
    ld (v_fg),a
    ld a,b
    ld (v_bg),a
    ret

; in: DE = x (0..319), A = y (0..239)   out: HL = vRam + y*320 + x
PixAddr:
    ld hl,0
    ld l,a
    ld h,160
    mlt hl
    add hl,hl
    add hl,de
    ld de,vRam
    add hl,de
    ret

; in: HL = dest, DE = width, B = height, C = colour
FillRect:
    ld (v_rw),de
    ld a,c
    ld (v_fillc),a
    ld a,b
    ld (v_rh),a
fr_row:
    ld a,(v_fillc)
    ld (hl),a
    ld bc,(v_rw)
    dec bc
    ld a,b
    or c
    jr z,fr_next
    push hl
    pop de
    inc de
    push hl
    ldir
    pop hl
fr_next:
    ld de,320
    add hl,de
    ld a,(v_rh)
    dec a
    ld (v_rh),a
    jr nz,fr_row
    ret

; in: A = char, IX = dest (top-left pixel)   uses (v_fg)/(v_bg)   out: IX = dest + 6
DrawChar:
    sub 32
    cp 95
    jr c,dc_ok
    ld a,'?'-32
dc_ok:
    ld hl,0
    ld l,a
    ld h,9
    mlt hl
    ld de,font
    add hl,de
    ld bc,(v_fg)
    ld d,9
dc_row:
    ld a,(hl)
    inc hl
    ld e,6
dc_px:
    add a,a
    jr c,dc_on
    ld (ix+0),b
    jr dc_nx
dc_on:
    ld (ix+0),c
dc_nx:
    inc ix
    dec e
    jr nz,dc_px
    push bc
    ld bc,314
    add ix,bc
    pop bc
    dec d
    jr nz,dc_row
    ld de,0FFF4C6h        ; -2874 = 6 - 9*320
    add ix,de
    ret

; in: HL = text, A = count (0..255), IX = dest
DrawChars:
    or a
    ret z
    ld (v_cnt),a
dcs_l:
    push hl
    ld a,(hl)
    call DrawChar
    pop hl
    inc hl
    ld a,(v_cnt)
    dec a
    ld (v_cnt),a
    jr nz,dcs_l
    ret

; in: HL = zero-terminated text, A = max chars, IX = dest
DrawStrZ:
    ld (v_cnt),a
dz_l:
    ld a,(v_cnt)
    or a
    ret z
    ld a,(hl)
    or a
    ret z
    push hl
    call DrawChar
    pop hl
    inc hl
    ld a,(v_cnt)
    dec a
    ld (v_cnt),a
    jr dz_l

; ================================================================ OS variable helpers
; in: HL -> 8-byte name        sets OP1 = appvar type + name
SetOP1:
    ld de,OP1+1
    ld bc,8
    ldir
    xor a
    ld (OP1+9),a
    ld a,AppVarObj
    ld (OP1),a
    ret

; in: OP1 set.  out: carry = not found; else HL -> [size word][data...] (works for RAM and archived vars)
FindVar:
    call _ChkFindSym
    ret c
    call _ChkInRam
    jr z,fv_ram
    ex de,hl              ; archived: DE -> archive entry (9 bytes, name length, name, then the data)
    ld bc,9
    add hl,bc
    ld c,(hl)
    inc hl
    add hl,bc
    or a
    ret
fv_ram:
    ex de,hl
    or a
    ret

; out: carry = NKIDX missing / unusable
LoadIndex:
    ld hl,nameIdx
    call SetOP1
    call FindVar
    ret c
    ld bc,0
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    push hl
    ld hl,1+40*32
    or a
    sbc hl,bc              ; HL = 1281 - size
    pop hl
    jr nc,li_fit
    ld bc,1+40*32          ; never copy more than the buffer holds
li_fit:
    ld a,b
    or c
    jr z,li_bad
    ld de,IDXBASE
    ldir
    ld a,(IDXBASE)
    cp 41
    jr nc,li_bad
    ld (v_nPages),a
    or a
    jr z,li_bad
    or a                  ; clear carry
    ret
li_bad:
    scf
    ret

; v_curName holds the 8-byte page appvar name.  out: carry = failed
LoadPage:
    ld hl,v_curName
    call SetOP1
    call FindVar
    ret c
    ld bc,0
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    push hl
    ld hl,MAXPAGE
    or a
    sbc hl,bc
    pop hl
    jr c,lp_bad
    ld a,b
    or a
    jr nz,lp_size_ok
    ld a,c
    cp 30                  ; smallest valid page = 30-byte header, no palette, no blocks
    jr c,lp_bad
lp_size_ok:
    ld (v_pageSize),bc
    ld de,PAGEBUF
    ldir
    ld hl,PAGEBUF
    ld a,(hl)
    cp 'N'
    jr nz,lp_bad
    inc hl
    ld a,(hl)
    cp 'K'
    jr nz,lp_bad
    inc hl
    ld a,(hl)
    cp 'P'
    jr nz,lp_bad
    ld a,(PAGEBUF+4)
    ld (v_nBlocks),a
    ld a,(PAGEBUF+29)
    cp 241
    jr nc,lp_bad
    ld hl,0
    ld l,a
    ld h,2
    mlt hl                 ; HL = palette bytes
    push hl
    ld de,30
    add hl,de
    ld (v_hdrSize),hl      ; header = 30 + 2*pcount
    pop bc
    ld a,b
    or c
    jr z,lp_nopal
    ld hl,PAGEBUF+30
    ld de,mpLcdPalette+32
    ldir
lp_nopal:
    or a
    ret
lp_bad:
    scf
    ret

; ================================================================ page structure helpers
; in: HL = block ptr   out: DE = block size in bytes (HL kept)
BlockSize:
    ld a,(hl)
    cp 1
    jr nz,bs_img
    push hl
    inc hl
    ld de,0
    ld e,(hl)
    inc hl
    ld d,(hl)
    pop hl
    inc de
    inc de
    inc de
    ret
bs_img:
    ld de,13
    ret

; in: A = block index   out: HL = block ptr in PAGEBUF
FindBlock:
    ld hl,(v_hdrSize)
    ld de,PAGEBUF
    add hl,de
    or a
    ret z
    ld b,a
fb_l:
    call BlockSize
    add hl,de
    djnz fb_l
    ret

; sets v_blkPtr, v_tptr (text start), v_tlen for the selected (text) block
SelTextInfo:
    ld a,(v_selBlk)
    call FindBlock
    ld (v_blkPtr),hl
    inc hl
    ld bc,0
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld (v_tptr),hl
    ld (v_tlen),bc
    ret

; ================================================================ word wrap
; in: HL = line start, BC = chars remaining
; out: DE = chars on this line, HL = next line start, BC = chars remaining after, A = term
;      term: 0 text ended, 1 newline consumed, 2 space consumed, 3 hard break (nothing consumed)
WrapNext:
    ld (wr_start),hl
    ld (wr_rem),bc
    ld de,0
    ld hl,0FFFFFFh
    ld (wr_last),hl
wn_loop:
    ld hl,(wr_rem)
    or a
    sbc hl,de
    jr z,wn_end
    ld hl,(wr_start)
    add hl,de
    ld a,(hl)
    cp 10
    jr z,wn_nl
    push af
    ld hl,COLS
    or a
    sbc hl,de
    jr z,wn_atmax
    pop af
    cp 32
    jr nz,wn_next
    ld (wr_last),de
wn_next:
    inc de
    jr wn_loop
wn_atmax:
    pop af
    cp 32
    jr z,wn_sp
    ld hl,(wr_last)
    ld bc,0FFFFFFh
    or a
    sbc hl,bc
    jr z,wn_hard
    ld de,(wr_last)
wn_sp:
    ld a,2
    jr wn_fin
wn_hard:
    ld a,3
    jr wn_fin
wn_end:
    xor a
    jr wn_fin
wn_nl:
    ld a,1
wn_fin:
    ld (wr_term),a
    ld hl,(wr_rem)
    or a
    sbc hl,de
    push hl
    pop bc
    ld hl,(wr_start)
    add hl,de
    cp 1
    jr z,wn_consume
    cp 2
    ret nz
wn_consume:
    inc hl
    dec bc
    ret

; in: HL = text ptr, BC = length   out: HL = number of display lines (>= 1)
CountLines:
    ld de,0
    ld (v_k),de
cl_l:
    call WrapNext
    ld de,(v_k)
    inc de
    ld (v_k),de
    or a
    jr nz,cl_l
    ld hl,(v_k)
    ret

; in: HL = block ptr   out: DE = height in pixels
BlockHeight:
    ld a,(hl)
    cp 1
    jr nz,bh_img
    inc hl
    ld bc,0
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld a,b
    or c
    jr nz,bh_txt
    ld a,(v_viewEdit)
    or a
    jr z,bh_zero
    ld de,LINE_H
    ret
bh_zero:
    ld de,0
    ret
bh_txt:
    call CountLines
    push hl
    pop de
    add hl,hl
    add hl,hl
    add hl,de
    add hl,hl             ; lines * 10
    ex de,hl
    ret
bh_img:
    inc hl
    inc hl
    inc hl
    ld de,0
    ld e,(hl)
    inc hl
    ld d,(hl)
    ret

; fills tbl_top / tbl_h and v_docH
Layout:
    ld hl,0
    ld (v_y),hl
    ld a,(v_nBlocks)
    or a
    jr z,ly_done
    ld (v_i),a
    ld hl,tbl_top
    ld (v_tp),hl
    ld hl,tbl_h
    ld (v_hp),hl
    ld hl,(v_hdrSize)
    ld de,PAGEBUF
    add hl,de
ly_l:
    ld (v_bptr),hl
    call BlockHeight
    ld hl,(v_tp)
    push de
    ld de,(v_y)
    ld (hl),de
    pop de
    ld hl,(v_hp)
    ld (hl),de
    ld hl,(v_y)
    add hl,de
    ld a,d
    or e
    jr z,ly_nogap
    ld de,GAP
    add hl,de
ly_nogap:
    ld (v_y),hl
    ld hl,(v_tp)
    ld de,3
    add hl,de
    ld (v_tp),hl
    ld hl,(v_hp)
    add hl,de
    ld (v_hp),hl
    ld hl,(v_bptr)
    call BlockSize
    add hl,de
    ld a,(v_i)
    dec a
    ld (v_i),a
    jr nz,ly_l
ly_done:
    ld hl,(v_y)
    ld (v_docH),hl
    ret

; ================================================================ caret / scrolling
; (selected block is text) -> v_cLine, v_cStart, v_cCol for the caret
CaretCompute:
    call SelTextInfo
    ld hl,0
    ld (v_cLine),hl
    ld (v_cStart),hl
cc_l:
    ld hl,(v_tlen)
    ld de,(v_cStart)
    or a
    sbc hl,de
    push hl
    pop bc
    ld hl,(v_tptr)
    add hl,de
    call WrapNext
    ld hl,(v_tlen)
    or a
    sbc hl,bc
    ld (v_t2),hl           ; start offset of the next line
    ld hl,(v_caret)
    ld de,(v_t2)
    or a
    sbc hl,de
    jp m,cc_found
    ld a,(wr_term)
    or a
    jr z,cc_found
    ld hl,(v_t2)
    ld (v_cStart),hl
    ld hl,(v_cLine)
    inc hl
    ld (v_cLine),hl
    jr cc_l
cc_found:
    ld hl,(v_caret)
    ld de,(v_cStart)
    or a
    sbc hl,de
    ld (v_cCol),hl
    ret

; in: (v_gk) = line number   out: (v_gs) = start offset, (v_gl) = length; carry = no such line
GetLine:
    ld hl,0
    ld (v_gs),hl
    ld (v_gj),hl
gl_l:
    ld hl,(v_tlen)
    ld de,(v_gs)
    or a
    sbc hl,de
    push hl
    pop bc
    ld hl,(v_tptr)
    add hl,de
    call WrapNext
    ld (v_gl),de
    ld hl,(v_gj)
    ld de,(v_gk)
    or a
    sbc hl,de
    jr z,gl_found
    ld a,(wr_term)
    or a
    jr z,gl_none
    ld hl,(v_tlen)
    or a
    sbc hl,bc
    ld (v_gs),hl
    ld hl,(v_gj)
    inc hl
    ld (v_gj),hl
    jr gl_l
gl_found:
    or a
    ret
gl_none:
    scf
    ret

; keep scroll inside [0, docH - VIEW_H]
ClampScroll:
    ld hl,(v_docH)
    ld de,VIEW_H
    or a
    sbc hl,de
    jp p,cs_pos
    ld hl,0
cs_pos:
    ld (v_t1),hl
    ld de,(v_scroll)
    or a
    sbc hl,de
    jp p,cs_low
    ld hl,(v_t1)
    ld (v_scroll),hl
cs_low:
    ld hl,(v_scroll)
    add hl,hl
    ret nc
    ld hl,0
    ld (v_scroll),hl
    ret

; in: HL = top, DE = bottom (document coordinates)  -> adjusts v_scroll so the range is visible
EnsureRange:
    ld (v_rt),hl
    ld (v_rb),de
    ld de,(v_scroll)
    or a
    sbc hl,de
    jp m,er_settop
    ld hl,(v_rb)
    or a
    sbc hl,de
    ld de,VIEW_H
    or a
    sbc hl,de
    jr z,er_done
    jp m,er_done
    ld hl,(v_rb)
    ld de,VIEW_H
    or a
    sbc hl,de
    ld (v_scroll),hl
    ld de,(v_rt)
    or a
    sbc hl,de
    jr z,er_done
    jp m,er_done
    ld hl,(v_rt)
    ld (v_scroll),hl
    jr er_done
er_settop:
    ld hl,(v_rt)
    ld (v_scroll),hl
er_done:
    ret

; out: HL = top, DE = bottom of the selected block (document coordinates)
SelBlockRange:
    ld de,0
    ld a,(v_selBlk)
    ld e,a
    ld d,3
    mlt de
    ld hl,tbl_top
    add hl,de
    ld hl,(hl)
    push hl
    ld hl,tbl_h
    add hl,de
    ld de,(hl)
    pop hl
    push hl
    add hl,de
    ex de,hl
    pop hl
    ret

FixScroll:
    ld a,(v_nBlocks)
    or a
    jr z,fs_clamp
    ld a,(v_state)
    cp ST_EDIT
    jr z,fs_edit
    cp ST_TEXT
    jr z,fs_text
    jr fs_clamp
fs_edit:
    call SelBlockRange
    call EnsureRange
    jr fs_clamp
fs_text:
    call CaretCompute
    call SelBlockRange
    push hl
    ld hl,(v_cLine)
    push hl
    pop de
    add hl,hl
    add hl,hl
    add hl,de
    add hl,hl             ; line * 10
    pop de
    add hl,de             ; top of caret line
    push hl
    ld de,LINE_H
    add hl,de
    ex de,hl
    pop hl
    call EnsureRange
fs_clamp:
    jp ClampScroll

; ================================================================ rendering
Render:
    ld a,C_BG
    call ClearScreen
    ld a,(v_state)
    or a
    jp z,RenderList
    cp ST_EDIT
    ld a,0
    jr c,rn_v
    ld a,1
rn_v:
    ld (v_viewEdit),a
    call Layout
    call FixScroll
    call DrawPageHeader
    call DrawDoc
    jp DrawFooter

DrawPageHeader:
    ld hl,vRam
    ld de,320
    ld b,13
    ld c,C_BAR
    call FillRect
    ld a,C_BART
    ld b,C_BAR
    call SetColors
    ld de,4
    ld a,2
    call PixAddr
    push hl
    pop ix
    ld hl,PAGEBUF+5
    ld a,24
    jp DrawStrZ

DrawFooter:
    ld hl,vRam+CBOT*320
    ld de,320
    ld b,13
    ld c,C_BAR
    call FillRect
    ld a,C_BART
    ld b,C_BAR
    call SetColors
    ld hl,(v_msg)
    ld de,0
    or a
    sbc hl,de
    jr z,df_hint
    ld hl,(v_msg)
    jr df_draw
df_hint:
    ld a,(v_state)
    ld hl,strHintList
    or a
    jr z,df_draw
    ld hl,strHintRead
    cp ST_READ
    jr z,df_draw
    ld hl,strHintEdit
    cp ST_EDIT
    jr z,df_draw
    ld hl,strHintText
df_draw:
    push hl
    ld de,4
    ld a,CBOT+2
    call PixAddr
    push hl
    pop ix
    pop hl
    ld a,52
    call DrawStrZ
    ld a,(v_state)
    cp ST_TEXT
    ret nz
    ; typing-mode indicator at the right
    ld a,C_ACC
    ld b,C_BAR
    call SetColors
    ld de,262
    ld a,CBOT+2
    call PixAddr
    push hl
    pop ix
    ld a,(v_second)
    or a
    ld hl,str2nd
    jr nz,df_ind
    ld a,(v_alpha)
    ld hl,strMode123
    or a
    jr z,df_ind
    ld hl,strModeUp
    cp 1
    jr z,df_ind
    ld hl,strModeLo
df_ind:
    ld a,9
    jp DrawStrZ

RenderList:
    ; keep the selection on screen
    ld a,(v_sel)
    ld hl,v_listTop
    cp (hl)
    jr nc,rl_chk2
    ld (hl),a
    jr rl_draw
rl_chk2:
    ld a,(v_listTop)
    add a,LIST_ROWS
    ld c,a
    ld a,(v_sel)
    cp c
    jr c,rl_draw
    sub LIST_ROWS-1
    ld (v_listTop),a
rl_draw:
    ld hl,vRam
    ld de,320
    ld b,13
    ld c,C_BAR
    call FillRect
    ld a,C_BART
    ld b,C_BAR
    call SetColors
    ld de,4
    ld a,2
    call PixAddr
    push hl
    pop ix
    ld hl,strTitle
    ld a,50
    call DrawStrZ
    ld a,(v_listTop)
    ld (v_i),a
rl_row:
    ld a,(v_i)
    ld hl,v_nPages
    cp (hl)
    jp nc,rl_done
    ld hl,v_listTop
    sub (hl)
    cp LIST_ROWS
    jp nc,rl_done
    ld hl,0
    ld l,a
    ld h,LINE_H
    mlt hl                 ; row * 10
    ld a,l
    add a,CTOP
    ld (v_ly),a
    ld a,(v_i)
    ld hl,v_sel
    cp (hl)
    ld b,C_BG
    jr nz,rl_nosel
    ld b,C_SEL
    ld a,(v_ly)
    ld de,0
    call PixAddr
    ld de,320
    ld b,LINE_H
    ld c,C_SEL
    call FillRect
    ld b,C_SEL
rl_nosel:
    ld a,C_TXT
    call SetColors
    ; entry address = IDXBASE + 1 + i*32
    ld hl,0
    ld a,(v_i)
    ld l,a
    ld h,32
    mlt hl
    ld de,IDXBASE+1
    add hl,de
    ld (v_t1),hl
    ld a,(v_ly)
    ld de,4
    call PixAddr
    push hl
    pop ix
    ld hl,(v_t1)
    ld de,8
    add hl,de              ; title
    ld a,24
    call DrawStrZ
    ld a,(v_fg)
    push af
    ld a,C_DIM
    ld (v_fg),a
    ld a,(v_ly)
    ld de,200
    call PixAddr
    push hl
    pop ix
    ld hl,(v_t1)
    ld a,8
    call DrawStrZ          ; appvar name
    pop af
    ld hl,v_i
    inc (hl)
    jp rl_row
rl_done:
    ; footer
    ld hl,vRam+CBOT*320
    ld de,320
    ld b,13
    ld c,C_BAR
    call FillRect
    ld a,C_BART
    ld b,C_BAR
    call SetColors
    ld hl,(v_msg)
    ld de,0
    or a
    sbc hl,de
    ld hl,strHintList
    jr z,rl_ft
    ld hl,(v_msg)
rl_ft:
    push hl
    ld de,4
    ld a,CBOT+2
    call PixAddr
    push hl
    pop ix
    pop hl
    ld a,52
    jp DrawStrZ

; draws every visible block
DrawDoc:
    ld a,(v_nBlocks)
    or a
    jr nz,dd_go
    ld a,C_DIM
    ld b,C_BG
    call SetColors
    ld de,4
    ld a,CTOP+4
    call PixAddr
    push hl
    pop ix
    ld hl,strEmpty
    ld a,50
    jp DrawStrZ
dd_go:
    ld (v_i),a
    xor a
    ld (v_bi),a
    ld hl,tbl_top
    ld (v_tp),hl
    ld hl,tbl_h
    ld (v_hp),hl
    ld hl,(v_hdrSize)
    ld de,PAGEBUF
    add hl,de
    ld (v_bptr),hl
dd_l:
    ld hl,(v_tp)
    ld hl,(hl)
    ld de,(v_scroll)
    or a
    sbc hl,de
    ld de,CTOP
    add hl,de
    ld (v_sy),hl           ; screen y of the block top (may be negative)
    ld de,CBOT
    or a
    sbc hl,de
    jp p,dd_done           ; below the view: nothing further is visible
    ld hl,(v_hp)
    ld de,(hl)
    ld a,d
    or e
    jr z,dd_next
    ld hl,(v_sy)
    add hl,de
    ld de,CTOP
    or a
    sbc hl,de
    jr z,dd_next
    jp m,dd_next           ; entirely above the view
    xor a
    ld (v_isSel),a
    ld a,(v_state)
    cp ST_EDIT
    jr c,dd_draw
    ld a,(v_bi)
    ld hl,v_selBlk
    cp (hl)
    jr nz,dd_draw
    ld a,1
    ld (v_isSel),a
dd_draw:
    ld hl,(v_bptr)
    ld a,(hl)
    cp 1
    jr nz,dd_img
    call DrawTextBlock
    jr dd_next
dd_img:
    call DrawImage
dd_next:
    ld hl,(v_bptr)
    call BlockSize
    add hl,de
    ld (v_bptr),hl
    ld hl,(v_tp)
    ld de,3
    add hl,de
    ld (v_tp),hl
    ld hl,(v_hp)
    add hl,de
    ld (v_hp),hl
    ld hl,v_bi
    inc (hl)
    ld hl,v_i
    dec (hl)
    jp nz,dd_l
dd_done:
    ret

DrawTextBlock:
    ld hl,(v_bptr)
    inc hl
    ld bc,0
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld (v_cur),hl
    ld (v_rem),bc
    ld hl,0
    ld (v_lk),hl
    ld a,(v_isSel)
    ld b,C_BG
    or a
    jr z,dt_c
    ld b,C_SEL
dt_c:
    ld a,C_TXT
    call SetColors
dt_line:
    ld hl,(v_lk)
    push hl
    pop de
    add hl,hl
    add hl,hl
    add hl,de
    add hl,hl              ; lk * 10
    ld de,(v_sy)
    add hl,de
    ld (v_ly),hl
    ld de,CBOT
    or a
    sbc hl,de
    jp p,dt_ret            ; below the view
    ld hl,(v_cur)
    ld bc,(v_rem)
    call WrapNext
    ld (v_len),de
    ld (v_nxt),hl
    ld (v_rem),bc
    ld (v_term2),a
    ld hl,(v_ly)
    ld de,CTOP
    or a
    sbc hl,de
    jp m,dt_skip
    ld hl,(v_ly)
    ld de,CBOT-LINE_H
    or a
    sbc hl,de
    jr z,dt_vis
    jp p,dt_skip
dt_vis:
    call DrawLine
dt_skip:
    ld hl,(v_nxt)
    ld (v_cur),hl
    ld a,(v_term2)
    or a
    ret z
    ld hl,(v_lk)
    inc hl
    ld (v_lk),hl
    jr dt_line
dt_ret:
    ret

; draws one wrapped line (v_cur, v_len) at row v_ly, plus selection band and caret
DrawLine:
    ld a,(v_isSel)
    or a
    jr z,dl_text
    ld a,(v_ly)
    ld de,0
    call PixAddr
    ld de,320
    ld b,LINE_H
    ld c,C_SEL
    call FillRect
    ld a,(v_ly)
    ld de,0
    call PixAddr
    ld de,2
    ld b,LINE_H
    ld c,C_ACC
    call FillRect
dl_text:
    ld a,(v_ly)
    ld de,2
    call PixAddr
    push hl
    pop ix
    ld hl,(v_cur)
    ld bc,(v_len)
    ld a,c
    call DrawChars
    ld a,(v_state)
    cp ST_TEXT
    ret nz
    ld a,(v_isSel)
    or a
    ret z
    ld hl,(v_lk)
    ld de,(v_cLine)
    or a
    sbc hl,de
    ret nz
    ; caret cell
    ld a,(v_cCol)
    cp COLS
    jr c,dl_col
    ld a,COLS-1
dl_col:
    ld (v_t3),a
    ld hl,0
    ld l,a
    ld h,6
    mlt hl
    ld de,2
    add hl,de
    ex de,hl
    ld a,(v_ly)
    call PixAddr
    push hl
    pop ix
    ld a,C_BG
    ld b,C_ACC
    call SetColors
    ld a,(v_t3)
    ld hl,v_len
    cp (hl)
    ld a,' '
    jr nc,dl_dr
    ld hl,(v_cur)
    ld de,0
    ld a,(v_t3)
    ld e,a
    add hl,de
    ld a,(hl)
dl_dr:
    call DrawChar
    ld a,C_TXT
    ld b,C_SEL
    jp SetColors

DrawImage:
    ld hl,(v_bptr)
    inc hl
    ld de,0
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (v_iw),de
    ld de,0
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (v_ih),de
    call SetOP1            ; HL -> image appvar name
    call FindVar
    jp c,di_missing
    inc hl
    inc hl
    ld (v_isrc),hl
    ld hl,320
    ld de,(v_iw)
    or a
    sbc hl,de
    ld bc,0
    ld b,h
    ld c,l
    srl b
    rr c
    ld (v_ix0),bc          ; x offset = (320 - w) / 2
    ld hl,(v_sy)
    ld (v_ry),hl
    ld hl,(v_ih)
    ld (v_ir),hl
di_row:
    ld hl,(v_ry)
    ld de,CTOP
    or a
    sbc hl,de
    jp m,di_next
    ld hl,(v_ry)
    ld de,CBOT
    or a
    sbc hl,de
    jp p,di_done
    ld a,(v_ry)
    ld de,(v_ix0)
    call PixAddr
    ex de,hl
    ld hl,(v_isrc)
    ld bc,(v_iw)
    ldir
    ld a,(v_isSel)
    or a
    jr z,di_next
    ld a,(v_ry)
    ld de,0
    call PixAddr
    ld (hl),C_ACC
    inc hl
    ld (hl),C_ACC
di_next:
    ld hl,(v_isrc)
    ld de,(v_iw)
    add hl,de
    ld (v_isrc),hl
    ld hl,(v_ry)
    inc hl
    ld (v_ry),hl
    ld hl,(v_ir)
    dec hl
    ld (v_ir),hl
    ld a,h
    or l
    jr nz,di_row
di_done:
    ret
di_missing:
    ld hl,(v_sy)
    ld de,CTOP
    or a
    sbc hl,de
    ret m
    ld hl,(v_sy)
    ld de,CBOT-LINE_H
    or a
    sbc hl,de
    ret p
    ld a,C_ERR
    ld b,C_BG
    call SetColors
    ld a,(v_sy)
    ld de,2
    call PixAddr
    push hl
    pop ix
    ld hl,strMissing
    ld a,40
    jp DrawStrZ

; ================================================================ key handling
; ---- list
KeyList:
    ld a,b
    cp skClear
    jp z,Exit
    cp skUp
    jr z,kl_up
    cp skDown
    jr z,kl_down
    cp skEnter
    jr z,kl_open
    jp MainLoop
kl_up:
    ld a,(v_sel)
    or a
    jp z,MainLoop
    dec a
    ld (v_sel),a
    jp MainLoop
kl_down:
    ld a,(v_nPages)
    ld c,a
    ld a,(v_sel)
    inc a
    cp c
    jp nc,MainLoop
    ld (v_sel),a
    jp MainLoop
kl_open:
    ld hl,0
    ld a,(v_sel)
    ld l,a
    ld h,32
    mlt hl
    ld de,IDXBASE+1
    add hl,de
    ld de,v_curName
    ld bc,8
    ldir
    xor a
    ld (v_curName+8),a
    call LoadPage
    jr nc,kl_ok
    ld hl,strNoPage
    ld (v_msg),hl
    jp MainLoop
kl_ok:
    ld a,ST_READ
    ld (v_state),a
    ld hl,0
    ld (v_scroll),hl
    xor a
    ld (v_selBlk),a
    ld (v_dirty),a
    ld (v_confirm),a
    ld (v_alpha),a
    ld (v_second),a
    jp MainLoop

; ---- read
KeyRead:
    ld a,b
    cp skUp
    jr z,kr_up
    cp skDown
    jr z,kr_dn
    cp skLeft
    jr z,kr_pu
    cp skRight
    jr z,kr_pd
    cp skEnter
    jr z,kr_edit
    cp skClear
    jr z,kr_back
    jp MainLoop
kr_dn:
    ld de,SCROLL_STEP
    jr kr_add
kr_pd:
    ld de,PAGE_STEP
kr_add:
    ld hl,(v_scroll)
    add hl,de
    ld (v_scroll),hl
    jp MainLoop
kr_up:
    ld de,SCROLL_STEP
    jr kr_sub
kr_pu:
    ld de,PAGE_STEP
kr_sub:
    ld hl,(v_scroll)
    or a
    sbc hl,de
    ld (v_scroll),hl
    jp MainLoop
kr_edit:
    ld a,ST_EDIT
    ld (v_state),a
    xor a
    ld (v_selBlk),a
    ld (v_confirm),a
    jp MainLoop
kr_back:
    xor a
    ld (v_state),a
    jp MainLoop

; ---- edit (block level)
KeyEdit:
    ld a,(v_confirm)
    or a
    jp nz,ke_confirm
    ld a,b
    cp skUp
    jr z,ke_up
    cp skDown
    jr z,ke_down
    cp skClear
    jp z,ke_done
    ld c,a
    ld a,(v_nBlocks)
    or a
    jr nz,ke_has
    ld a,c
    cp skAdd
    jp z,ke_add
    jp MainLoop
ke_has:
    ld a,c
    cp skEnter
    jr z,ke_enter
    cp skDel
    jr z,ke_del
    cp skAdd
    jp z,ke_add
    cp skLParen
    jp z,ke_mvup
    cp skRParen
    jp z,ke_mvdn
    jp MainLoop
ke_up:
    ld a,(v_selBlk)
    or a
    jp z,MainLoop
    dec a
    ld (v_selBlk),a
    jp MainLoop
ke_down:
    ld a,(v_selBlk)
    inc a
    ld hl,v_nBlocks
    cp (hl)
    jp nc,MainLoop
    ld (v_selBlk),a
    jp MainLoop
ke_enter:
    ld a,(v_selBlk)
    call FindBlock
    ld a,(hl)
    cp 1
    jp nz,MainLoop
    call SelTextInfo
    ld hl,(v_tlen)
    ld (v_caret),hl
    ld a,ST_TEXT
    ld (v_state),a
    xor a
    ld (v_alpha),a
    ld (v_second),a
    jp MainLoop
ke_del:
    ld a,1
    ld (v_confirm),a
    ld hl,strConfirm
    ld (v_msg),hl
    jp MainLoop
ke_confirm:
    xor a
    ld (v_confirm),a
    ld a,b
    cp skEnter
    jp nz,MainLoop
    call DelBlock
    jp MainLoop
ke_add:
    call InsBlock
    jp MainLoop
ke_mvup:
    ld a,(v_selBlk)
    or a
    jp z,MainLoop
    dec a
    call SwapBlocks
    ld a,(v_selBlk)
    dec a
    ld (v_selBlk),a
    jp MainLoop
ke_mvdn:
    ld a,(v_selBlk)
    inc a
    ld hl,v_nBlocks
    cp (hl)
    jp nc,MainLoop
    dec a
    call SwapBlocks
    ld a,(v_selBlk)
    inc a
    ld (v_selBlk),a
    jp MainLoop
ke_done:
    call SaveIfDirty
    ld a,ST_READ
    ld (v_state),a
    jp MainLoop

; ---- text editing
KeyText:
    ld a,b
    ld (v_key),a
    cp skClear
    jp z,kt_done
    cp skLeft
    jp z,kt_left
    cp skRight
    jp z,kt_right
    cp skUp
    jp z,kt_up
    cp skDown
    jp z,kt_down
    cp skDel
    jp z,kt_del
    cp skEnter
    jp z,kt_enter
    cp skAlpha
    jp z,kt_alpha
    cp sk2nd
    jp z,kt_2nd
    ld a,(v_second)
    or a
    jr nz,kt_sec
    ld a,(v_alpha)
    or a
    jr nz,kt_alp
    ld hl,symNormal
    ld a,(v_key)
    call LookupPair
    or a
    jp z,MainLoop
    jr kt_put
kt_sec:
    xor a
    ld (v_second),a
    ld hl,symSecond
    ld a,(v_key)
    call LookupPair
    or a
    jp z,MainLoop
    jr kt_put
kt_alp:
    ld hl,alphaKeys
    ld a,(v_key)
    call FindIndex
    jr c,kt_alpsym
    ld c,a
    ld a,(v_alpha)
    cp 1
    ld a,'A'
    jr z,kt_case
    ld a,'a'
kt_case:
    add a,c
    jr kt_put
kt_alpsym:
    ld hl,symAlpha
    ld a,(v_key)
    call LookupPair
    or a
    jp z,MainLoop
kt_put:
    call InsertChar
    jp MainLoop
kt_enter:
    ld a,10
    jr kt_put
kt_alpha:
    ld a,(v_alpha)
    inc a
    cp 3
    jr c,kt_as
    xor a
kt_as:
    ld (v_alpha),a
    jp MainLoop
kt_2nd:
    ld a,(v_second)
    xor 1
    ld (v_second),a
    jp MainLoop
kt_del:
    call Backspace
    jp MainLoop
kt_left:
    ld hl,(v_caret)
    ld a,h
    or l
    jp z,MainLoop
    dec hl
    ld (v_caret),hl
    jp MainLoop
kt_right:
    call SelTextInfo
    ld hl,(v_tlen)
    ld de,(v_caret)
    or a
    sbc hl,de
    jp z,MainLoop
    ld hl,(v_caret)
    inc hl
    ld (v_caret),hl
    jp MainLoop
kt_up:
    call SelTextInfo
    call CaretCompute
    ld bc,(v_cLine)
    ld a,b
    or c
    jr nz,ku_go
    ld hl,0
    ld (v_caret),hl
    jp MainLoop
ku_go:
    dec bc
    ld (v_gk),bc
    call GetLine
    jr kt_place
kt_down:
    call SelTextInfo
    call CaretCompute
    ld hl,(v_cLine)
    inc hl
    ld (v_gk),hl
    call GetLine
    jr nc,kt_place
    ld hl,(v_tlen)
    ld (v_caret),hl
    jp MainLoop
kt_place:
    ld hl,(v_cCol)
    ld de,(v_gl)
    or a
    sbc hl,de
    jr nc,kp_len
    ld hl,(v_cCol)
    jr kp_add
kp_len:
    ld hl,(v_gl)
kp_add:
    ld de,(v_gs)
    add hl,de
    ld (v_caret),hl
    jp MainLoop
kt_done:
    ld a,ST_EDIT
    ld (v_state),a
    xor a
    ld (v_second),a
    jp MainLoop

; in: HL = table of (key, value) byte pairs ended by key 0; A = key   out: A = value or 0
LookupPair:
    ld b,a
lp_l:
    ld a,(hl)
    or a
    ret z
    inc hl
    cp b
    jr z,lp_f
    inc hl
    jr lp_l
lp_f:
    ld a,(hl)
    ret

; in: HL = 26-byte table, A = key   out: A = index, carry if absent
FindIndex:
    ld b,a
    ld c,0
fi_l:
    ld a,(hl)
    cp b
    jr z,fi_f
    inc hl
    inc c
    ld a,c
    cp 26
    jr c,fi_l
    scf
    ret
fi_f:
    ld a,c
    or a
    ret

; ================================================================ page editing primitives
; in: A = character (selected block is text, caret in v_caret)
InsertChar:
    ld (v_ch),a
    call SelTextInfo
    ld hl,(v_tlen)
    ld de,MAXTEXT
    or a
    sbc hl,de
    ret nc
    ld hl,(v_pageSize)
    ld de,MAXPAGE
    or a
    sbc hl,de
    ret nc
    ld hl,(v_tptr)
    ld de,(v_caret)
    add hl,de
    ld (v_t1),hl           ; insertion point
    ld hl,(v_pageSize)
    ld de,PAGEBUF
    add hl,de
    ld (v_t2),hl           ; end of page
    ld de,(v_t1)
    or a
    sbc hl,de
    push hl
    pop bc                 ; bytes to move
    ld a,b
    or c
    jr z,ic_put
    ld hl,(v_t2)
    dec hl
    ld de,(v_t2)
    lddr
ic_put:
    ld a,(v_ch)
    ld hl,(v_t1)
    ld (hl),a
    ld hl,(v_blkPtr)
    inc hl
    ld de,0
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc de
    ld (hl),d
    dec hl
    ld (hl),e
    ld hl,(v_pageSize)
    inc hl
    ld (v_pageSize),hl
    ld hl,(v_caret)
    inc hl
    ld (v_caret),hl
    ld a,1
    ld (v_dirty),a
    ret

Backspace:
    ld hl,(v_caret)
    ld a,h
    or l
    ret z
    call SelTextInfo
    ld hl,(v_tptr)
    ld de,(v_caret)
    add hl,de
    ld (v_t1),hl           ; char after the one being removed
    ld hl,(v_pageSize)
    ld de,PAGEBUF
    add hl,de
    ld de,(v_t1)
    or a
    sbc hl,de
    push hl
    pop bc
    ld a,b
    or c
    jr z,bk_len
    ld hl,(v_t1)
    ld de,(v_t1)
    dec de
    ldir
bk_len:
    ld hl,(v_blkPtr)
    inc hl
    ld de,0
    ld e,(hl)
    inc hl
    ld d,(hl)
    dec de
    ld (hl),d
    dec hl
    ld (hl),e
    ld hl,(v_pageSize)
    dec hl
    ld (v_pageSize),hl
    ld hl,(v_caret)
    dec hl
    ld (v_caret),hl
    ld a,1
    ld (v_dirty),a
    ret

; insert an empty text block after the selected one
InsBlock:
    ld a,(v_nBlocks)
    cp 255
    ret nc
    ld hl,(v_pageSize)
    ld de,MAXPAGE-3
    or a
    sbc hl,de
    ret nc
    ld a,(v_nBlocks)
    or a
    jr nz,ib_has
    ld hl,(v_hdrSize)
    ld de,PAGEBUF
    add hl,de
    xor a
    ld (v_newsel),a
    jr ib_do
ib_has:
    ld a,(v_selBlk)
    call FindBlock
    call BlockSize
    add hl,de
    ld a,(v_selBlk)
    inc a
    ld (v_newsel),a
ib_do:
    ld (v_t1),hl
    ld de,PAGEBUF
    ld hl,(v_pageSize)
    add hl,de
    ld (v_t2),hl
    ld de,(v_t1)
    or a
    sbc hl,de
    push hl
    pop bc
    ld a,b
    or c
    jr z,ib_put
    ld hl,(v_t2)
    dec hl
    ld de,(v_t2)
    inc de
    inc de
    lddr
ib_put:
    ld hl,(v_t1)
    ld (hl),1
    inc hl
    ld (hl),0
    inc hl
    ld (hl),0
    ld hl,(v_pageSize)
    ld de,3
    add hl,de
    ld (v_pageSize),hl
    ld a,(v_nBlocks)
    inc a
    ld (v_nBlocks),a
    ld (PAGEBUF+4),a
    ld a,(v_newsel)
    ld (v_selBlk),a
    ld a,1
    ld (v_dirty),a
    ret

; delete the selected block
DelBlock:
    ld a,(v_nBlocks)
    or a
    ret z
    ld a,(v_selBlk)
    call FindBlock
    ld (v_t1),hl
    call BlockSize
    ld (v_t3),de
    add hl,de
    ld (v_t4),hl           ; start of the tail
    ld de,PAGEBUF
    ld hl,(v_pageSize)
    add hl,de
    ld de,(v_t4)
    or a
    sbc hl,de
    push hl
    pop bc
    ld a,b
    or c
    jr z,db_sz
    ld hl,(v_t4)
    ld de,(v_t1)
    ldir
db_sz:
    ld hl,(v_pageSize)
    ld de,(v_t3)
    or a
    sbc hl,de
    ld (v_pageSize),hl
    ld a,(v_nBlocks)
    dec a
    ld (v_nBlocks),a
    ld (PAGEBUF+4),a
    ld b,a
    ld a,(v_selBlk)
    cp b
    jr c,db_ok
    or a
    jr z,db_ok
    dec a
    ld (v_selBlk),a
db_ok:
    ld a,1
    ld (v_dirty),a
    ret

; swap block A with block A+1
SwapBlocks:
    call FindBlock
    ld (v_t1),hl
    call BlockSize
    ld (v_t3),de           ; size of first
    add hl,de
    ld (v_t2),hl
    call BlockSize
    ld (v_t4),de           ; size of second
    ld hl,(v_t3)
    add hl,de
    push hl
    pop bc
    ld hl,(v_t1)
    ld de,TMPBUF
    ldir                   ; both blocks -> scratch
    ld hl,TMPBUF
    ld de,(v_t3)
    add hl,de
    ld de,(v_t1)
    ld bc,(v_t4)
    ldir                   ; second block first
    ld hl,TMPBUF
    ld bc,(v_t3)
    ldir                   ; then the first block
    ld a,1
    ld (v_dirty),a
    ret

SaveIfDirty:
    ld a,(v_dirty)
    or a
    ret z
    ; the whole page is rewritten as a RAM appvar
    ld hl,(v_pageSize)
    ld de,32
    add hl,de
    call _EnoughMem
    jr c,sv_nomem
    ld hl,v_curName
    call SetOP1
    call _DelVarArc
    ld hl,v_curName
    call SetOP1
    ld a,AppVarObj
    ld hl,(v_pageSize)
    call _CreateVar        ; A = type, HL = size, OP1 = name (same contract fileioc relies on)
    ld hl,v_curName
    call SetOP1
    call FindVar
    jr c,sv_err
    inc hl
    inc hl
    ex de,hl
    ld hl,PAGEBUF
    ld bc,(v_pageSize)
    ldir
    xor a
    ld (v_dirty),a
    ld hl,strSaved
    ld (v_msg),hl
    ret
sv_nomem:
    ld hl,strNoMem
    ld (v_msg),hl
    ret
sv_err:
    ld hl,strSaveErr
    ld (v_msg),hl
    ret

; ================================================================ data
nameIdx:    .db "NKIDX",0,0,0

strTitle:   .db "NOTEKEEPER   pick a page",0
strEmpty:   .db "(empty page - press CLEAR, then ENTER to edit)",0
strMissing: .db "[image appvar missing]",0
strNoIdx1:  .db "NKIDX appvar not found.",0
strNoIdx2:  .db "Send the pages from the Notekeeper web tool",0
strNoIdx3:  .db "(or tools/nkpack.py) to the calculator.",0
strNoPage:  .db "PAGE FILE NOT FOUND",0
strHintList:.db "UP/DOWN select    ENTER open    CLEAR quit",0
strHintRead:.db "UP/DOWN scroll  ENTER edit  CLEAR pages",0
strHintEdit:.db "ENTER text  DEL del  + add  ( ) move  CLEAR ok",0
strHintText:.db "ALPHA abc  2nd sym  DEL back  CLEAR done",0
strConfirm: .db "Delete this block?  ENTER = yes, any key = no",0
strSaved:   .db "Saved",0
strNoMem:   .db "NOT ENOUGH MEMORY - changes not saved",0
strSaveErr: .db "SAVE FAILED",0
str2nd:     .db " [2nd] ",0
strMode123: .db " [123] ",0
strModeUp: .db " [ABC] ",0
strModeLo: .db " [abc] ",0

; scan code -> letter, in A..Z order
alphaKeys:
    .db skMath,skMatrix,skPrgm,skRecip,skSin,skCos,skTan,skPower,skSquare
    .db skComma,skLParen,skRParen,skDiv,skLog,sk7,sk8,sk9,skMul,skLn
    .db sk4,sk5,sk6,skSub,skStore,sk1,sk2

; typing tables: (scan code, character) pairs, 0 ends the table
symNormal:
    .db sk0,'0', sk1,'1', sk2,'2', sk3,'3', sk4,'4', sk5,'5', sk6,'6', sk7,'7', sk8,'8', sk9,'9'
    .db skDecPnt,'.', skComma,',', skLParen,'(', skRParen,')'
    .db skAdd,'+', skSub,'-', skMul,'*', skDiv,'/', skPower,'^'
    .db skVars,' ', skChs,'?', skStore,'='
    .db 0
symSecond:
    .db skDecPnt,':', skComma,';', skLParen,'[', skRParen,']', skAdd,'"', skSub,'_'
    .db skMul,39, skDiv,'!', skPower,'%', skChs,'#', skStore,'&', skMath,'<', skMatrix,'>'
    .db skPrgm,'{', skRecip,'}', sk0,'@', skVars,'~'
    .db 0
symAlpha:
    .db sk0,' ', skDecPnt,':', skChs,'?', skAdd,'"', sk3,39, skVars,' '
    .db 0

#include "palette.inc"
#include "font6x9.inc"
