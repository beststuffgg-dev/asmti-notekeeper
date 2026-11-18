// Notekeeper UI: notebooks > folders > pages. A page is an ordered list of text and image
// blocks that can be read (rendered) or edited (autosaved).
(function () {
    'use strict';

    const { uid, isImage, isText, isBackup, imageBlock, textBlock, filesToPages } = Importer;
    const $ = (sel, root = document) => root.querySelector(sel);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    const S = {
        notebooks: [],
        nbId: null,
        nodes: new Map(),   // id -> node, for the open notebook
        pageId: null,
        folderId: null,     // where "new page" / import goes (null = notebook root)
        mode: 'read',       // 'read' | 'edit'
        expanded: new Set(),
        query: '',
        focusIdx: -1,       // index of the block last focused in the editor
    };
    const savedImages = new Map(); // pageId -> Set(imageId) as last persisted (for cleanup)
    const urlCache = new Map();    // imageId -> object URL

    /* ---------- small helpers ---------- */

    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k === 'html') el.innerHTML = v;
            else if (k === 'value') el.value = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        el.append(...kids.flat().filter((k) => k != null && k !== false));
        return el;
    }

    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode etc. */ } },
    };

    let toastTimer;
    function toast(msg, isError) {
        const t = $('#toast');
        t.textContent = msg;
        t.className = 'show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = ''; }, isError ? 5000 : 2500);
    }

    // Promise-based modal. Resolves with the entered/selected value (or true), or null if cancelled.
    function ask({ title, message, value = '', placeholder, options, ok = 'OK', danger = false, input = false, info = false }) {
        return new Promise((resolve) => {
            let field = null;
            if (options) {
                field = h('select', null, options.map((o) => h('option', { value: o.value, text: o.label })));
                field.value = value;
            } else if (input) {
                field = h('input', { type: 'text', value, placeholder, maxlength: 120 });
            }
            const dlg = h('dialog', { class: 'dlg' },
                h('form', { method: 'dialog' },
                    h('h3', { text: title }),
                    message && h('p', { text: message }),
                    field,
                    h('div', { class: 'dlg-actions' },
                        !info && h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close('cancel') }),
                        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok', text: ok }))));
            dlg.addEventListener('close', () => {
                const accepted = dlg.returnValue === 'ok';
                dlg.remove();
                resolve(accepted ? (field ? field.value : true) : null);
            });
            document.body.append(dlg);
            dlg.showModal();
            if (field) { field.focus(); if (field.select) field.select(); }
        });
    }

    function showMenu(x, y, items) {
        closeMenu();
        const menu = h('div', { class: 'menu', id: 'ctxMenu', role: 'menu' },
            items.filter(Boolean).map((it) => h('button', {
                class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', text: it.label,
                onclick: () => { closeMenu(); it.run(); },
            })));
        document.body.append(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    }
    function closeMenu() { const m = $('#ctxMenu'); if (m) m.remove(); }
    document.addEventListener('click', (e) => { if (!e.target.closest('#ctxMenu')) closeMenu(); });
    document.addEventListener('scroll', closeMenu, true);

    /* ---------- data ---------- */

    const nb = () => S.notebooks.find((n) => n.id === S.nbId);
    const page = () => { const n = S.nodes.get(S.pageId); return n && n.type === 'page' ? n : null; };

    function descendantsOf(id) {
        const out = [];
        const stack = [id];
        while (stack.length) {
            const cur = stack.pop();
            for (const n of S.nodes.values()) if (n.parentId === cur) { out.push(n); stack.push(n.id); }
        }
        return out;
    }

    const imageIdsOf = (p) => new Set((p.blocks || []).filter((b) => b.type === 'image').map((b) => b.imageId));

    async function createNode(type, title, parentId, blocks) {
        const n = {
            id: uid(), notebookId: S.nbId, parentId: parentId || null, type, title,
            blocks: type === 'page' ? (blocks || [textBlock('')]) : undefined,
            created: Date.now(), updated: Date.now(),
        };
        await DB.put('nodes', n);
        S.nodes.set(n.id, n);
        if (type === 'page') savedImages.set(n.id, imageIdsOf(n));
        return n;
    }

    async function deleteImages(ids) {
        ids = [...ids];
        if (!ids.length) return;
        await DB.delMany('images', ids);
        ids.forEach((id) => { const u = urlCache.get(id); if (u) URL.revokeObjectURL(u); urlCache.delete(id); });
    }

    async function loadNotebook(id) {
        await flush();
        S.nbId = id;
        S.nodes = new Map((await DB.nodesOf(id)).map((n) => [n.id, n]));
        savedImages.clear();
        S.nodes.forEach((n) => { if (n.type === 'page') savedImages.set(n.id, imageIdsOf(n)); });
        urlCache.forEach((u) => URL.revokeObjectURL(u));
        urlCache.clear();
        store.set('nk.notebook', id);
        S.query = '';
        $('#search').value = '';
        S.mode = 'read';
        const last = store.get('nk.page.' + id);
        const first = [...S.nodes.values()].filter((n) => n.type === 'page').sort((a, b) => collator.compare(a.title, b.title))[0];
        const start = S.nodes.get(last) && S.nodes.get(last).type === 'page' ? S.nodes.get(last) : first;
        S.pageId = start ? start.id : null;
        S.folderId = start ? start.parentId : null;
        revealAncestors(start);
        renderNotebookSelect();
        renderTree();
        renderMain();
    }

    function revealAncestors(n) {
        while (n && n.parentId) { S.expanded.add(n.parentId); n = S.nodes.get(n.parentId); }
    }

    /* ---------- saving (debounced autosave while editing) ---------- */

    let saveTimer;
    let dirtyId = null;

    function setStatus(text) { const s = $('#saveStatus'); if (s) s.textContent = text; }

    function touch() {
        dirtyId = S.pageId;
        setStatus('Editing…');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, 500);
    }

    async function flush() {
        clearTimeout(saveTimer);
        if (!dirtyId) return;
        const id = dirtyId;
        dirtyId = null;
        const p = S.nodes.get(id);
        if (!p) return;
        p.updated = Date.now();
        await DB.put('nodes', p);
        const now = imageIdsOf(p);
        const gone = [...(savedImages.get(id) || [])].filter((x) => !now.has(x));
        savedImages.set(id, now);
        await deleteImages(gone);
        setStatus('Saved');
    }

    addEventListener('beforeunload', (e) => { if (dirtyId) { flush(); e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

    /* ---------- sidebar: notebooks ---------- */

    function renderNotebookSelect() {
        const sel = $('#notebookSelect');
        sel.replaceChildren(...S.notebooks.map((n) => h('option', { value: n.id, text: n.name })));
        sel.value = S.nbId;
    }

    async function newNotebook() {
        const name = await ask({ title: 'New notebook', input: true, placeholder: 'Notebook name', ok: 'Create' });
        if (!name || !name.trim()) return;
        const n = { id: uid(), name: name.trim(), created: Date.now() };
        await DB.put('notebooks', n);
        S.notebooks.push(n);
        await loadNotebook(n.id);
    }

    async function renameNotebook() {
        const name = await ask({ title: 'Rename notebook', input: true, value: nb().name, ok: 'Rename' });
        if (!name || !name.trim()) return;
        nb().name = name.trim();
        await DB.put('notebooks', nb());
        renderNotebookSelect();
        renderMain();
    }

    async function deleteNotebook() {
        if (S.notebooks.length < 2) { toast('You need at least one notebook.', true); return; }
        const ok = await ask({ title: 'Delete notebook?', message: `"${nb().name}" and all its pages and images will be permanently deleted.`, ok: 'Delete', danger: true });
        if (!ok) return;
        await flush();
        const imgs = new Set();
        S.nodes.forEach((n) => (n.blocks || []).forEach((b) => b.imageId && imgs.add(b.imageId)));
        await DB.delMany('nodes', [...S.nodes.keys()]);
        await deleteImages(imgs);
        await DB.del('notebooks', S.nbId);
        S.notebooks = S.notebooks.filter((n) => n.id !== S.nbId);
        await loadNotebook(S.notebooks[0].id);
    }

    async function exportNotebook() {
        await flush();
        const blob = await Importer.exportNotebook(nb(), [...S.nodes.values()]);
        const a = h('a', { href: URL.createObjectURL(blob), download: nb().name.replace(/[^\w\- ]+/g, '_') + '.notekeeper.json' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // Scale a stored image to fit the calculator (<= 320x200) and return its RGBA pixels.
    async function fitForCalculator(imageId) {
        const rec = await DB.get('images', imageId);
        if (!rec) return null;
        const bmp = await createImageBitmap(rec.blob);
        const k = Math.min(1, TIExport.MAX_W / bmp.width, TIExport.MAX_H / bmp.height);
        const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';                       // transparent areas become white
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, w, h);
        if (bmp.close) bmp.close();
        return { w, h, data: ctx.getImageData(0, 0, w, h).data };
    }

    // All pages of the open notebook in sidebar order (folders first), as plain text/image blocks.
    function orderedPages() {
        const out = [];
        const walk = (pid) => {
            [...S.nodes.values()].filter((n) => (n.parentId || '') === (pid || '')).sort(cmpNodes).forEach((n) => {
                if (n.type === 'folder') walk(n.id); else out.push(n);
            });
        };
        walk('');
        return out;
    }

    async function exportForCalculator() {
        await flush();
        const pages = orderedPages();
        if (!pages.length) { toast('This notebook has no pages to export.', true); return; }
        toast('Preparing calculator files\u2026');
        try {
            const prepared = [];
            for (const p of pages) {
                const blocks = [];
                for (const b of p.blocks) {
                    if (b.type === 'text') { blocks.push({ type: 'text', text: b.text }); continue; }
                    const image = await fitForCalculator(b.imageId);
                    if (image) blocks.push({ type: 'image', image, caption: b.caption });
                }
                prepared.push({ title: p.title, blocks });
            }
            const res = TIExport.exportPages(prepared);
            const zip = TIExport.makeZip(res.files.map((f) => ({ name: f.name, data: f.data })));
            const a = h('a', { href: URL.createObjectURL(new Blob([zip], { type: 'application/zip' })), download: nb().name.replace(/[^\w\- ]+/g, '_') + '-ti84ce.zip' });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            const note = 'Send every .8xv file in the zip (NKIDX plus the NKP*/NKI* pages) to the calculator with TI Connect CE, together with NOTES.8xp from the calc/ folder, then run NOTES from the PRGM menu.';
            await ask({ title: res.pageCount + ' page' + (res.pageCount === 1 ? '' : 's') + ' exported', message: (res.warnings.length ? res.warnings.join('\n') + '\n\n' : '') + note, ok: 'OK', info: true });
        } catch (err) {
            console.error(err);
            toast('Export failed: ' + err.message, true);
        }
    }

    /* ---------- sidebar: tree ---------- */

    const cmpNodes = (a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : collator.compare(a.title, b.title));

    function pageMatches(p, q) {
        if (p.title.toLowerCase().includes(q)) return true;
        return (p.blocks || []).some((b) => (b.text || b.caption || '').toLowerCase().includes(q));
    }

    function renderTree() {
        const q = S.query.trim().toLowerCase();
        const byParent = new Map();
        S.nodes.forEach((n) => {
            const k = n.parentId || '';
            if (!byParent.has(k)) byParent.set(k, []);
            byParent.get(k).push(n);
        });
        let visible = null;
        if (q) {
            visible = new Set();
            S.nodes.forEach((n) => {
                const hit = n.type === 'page' ? pageMatches(n, q) : n.title.toLowerCase().includes(q);
                if (!hit) return;
                for (let c = n; c; c = S.nodes.get(c.parentId)) visible.add(c.id);
            });
        }
        const build = (pid) => {
            const ul = h('ul', { class: 'tree', role: pid ? 'group' : 'tree' });
            (byParent.get(pid) || []).sort(cmpNodes).forEach((n) => {
                if (visible && !visible.has(n.id)) return;
                const isFolder = n.type === 'folder';
                const open = isFolder && (q || S.expanded.has(n.id));
                const active = n.id === S.pageId || (isFolder && n.id === S.folderId && !page());
                const row = h('div', {
                    class: 'row' + (n.id === S.pageId ? ' active' : '') + (isFolder && n.id === S.folderId ? ' folder-current' : ''),
                    role: 'treeitem', 'aria-expanded': isFolder ? String(!!open) : null, 'aria-selected': String(active),
                    tabindex: 0, 'data-id': n.id,
                    onclick: () => onRowClick(n),
                    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(n); } },
                    oncontextmenu: (e) => { e.preventDefault(); nodeMenu(n, e.clientX, e.clientY); },
                },
                    h('span', { class: 'caret', text: isFolder ? (open ? '▾' : '▸') : '' }),
                    h('span', { class: 'ico', text: isFolder ? '📁' : '📄' }),
                    h('span', { class: 'name', text: n.title }),
                    h('button', {
                        class: 'more', title: 'Actions', 'aria-label': 'Actions for ' + n.title, text: '⋯',
                        onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); nodeMenu(n, r.left, r.bottom); },
                    }));
                const li = h('li', null, row);
                if (open) li.append(build(n.id));
                ul.append(li);
            });
            return ul;
        };
        const tree = build('');
        const holder = $('#tree');
        holder.replaceChildren(tree.children.length ? tree : h('p', { class: 'muted pad', text: q ? 'No matches.' : 'Nothing here yet. Create a page or import files.' }));
    }

    async function onRowClick(n) {
        if (n.type === 'folder') {
            S.folderId = n.id;
            if (S.expanded.has(n.id)) S.expanded.delete(n.id); else S.expanded.add(n.id);
            renderTree();
            renderCrumbs();
        } else {
            await openPage(n.id);
            if (innerWidth <= 800) toggleSidebar(false);
        }
    }

    function nodeMenu(n, x, y) {
        showMenu(x, y, [
            n.type === 'folder' && { label: 'New page here', run: () => newPage(n.id) },
            n.type === 'folder' && { label: 'New folder here', run: () => newFolder(n.id) },
            { label: 'Rename', run: () => renameNode(n) },
            { label: 'Move to…', run: () => moveNode(n) },
            { label: 'Delete', danger: true, run: () => deleteNode(n) },
        ]);
    }

    async function newPage(parentId = S.folderId) {
        const title = await ask({ title: 'New page', input: true, placeholder: 'Page title', ok: 'Create' });
        if (title === null) return;
        const p = await createNode('page', title.trim() || 'Untitled', parentId);
        if (parentId) S.expanded.add(parentId);
        await openPage(p.id, 'edit');
    }

    async function newFolder(parentId = S.folderId) {
        const title = await ask({ title: 'New folder', input: true, placeholder: 'Folder name', ok: 'Create' });
        if (!title || !title.trim()) return;
        const f = await createNode('folder', title.trim(), parentId);
        if (parentId) S.expanded.add(parentId);
        S.expanded.add(f.id);
        S.folderId = f.id;
        renderTree();
        renderCrumbs();
    }

    async function renameNode(n) {
        const title = await ask({ title: 'Rename ' + n.type, input: true, value: n.title, ok: 'Rename' });
        if (!title || !title.trim()) return;
        n.title = title.trim();
        n.updated = Date.now();
        await DB.put('nodes', n);
        renderTree();
        renderMain();
    }

    async function moveNode(n) {
        const banned = new Set([n.id, ...descendantsOf(n.id).map((d) => d.id)]);
        const pathOf = (f) => { const parts = []; for (let c = f; c; c = S.nodes.get(c.parentId)) parts.unshift(c.title); return parts.join(' / '); };
        const options = [{ value: '', label: '(notebook root)' }]
            .concat([...S.nodes.values()].filter((f) => f.type === 'folder' && !banned.has(f.id))
                .sort((a, b) => collator.compare(pathOf(a), pathOf(b))).map((f) => ({ value: f.id, label: pathOf(f) })));
        const dest = await ask({ title: 'Move "' + n.title + '" to', options, value: n.parentId || '', ok: 'Move' });
        if (dest === null) return;
        n.parentId = dest || null;
        await DB.put('nodes', n);
        if (n.parentId) S.expanded.add(n.parentId);
        renderTree();
        renderCrumbs();
    }

    async function deleteNode(n) {
        const kids = n.type === 'folder' ? descendantsOf(n.id) : [];
        const extra = kids.length ? ` and its ${kids.length} item${kids.length > 1 ? 's' : ''}` : '';
        const ok = await ask({ title: 'Delete ' + n.type + '?', message: `"${n.title}"${extra} will be permanently deleted.`, ok: 'Delete', danger: true });
        if (!ok) return;
        await flush();
        const all = [n, ...kids];
        const imgs = new Set();
        all.forEach((x) => (x.blocks || []).forEach((b) => b.imageId && imgs.add(b.imageId)));
        await DB.delMany('nodes', all.map((x) => x.id));
        await deleteImages(imgs);
        all.forEach((x) => { S.nodes.delete(x.id); savedImages.delete(x.id); });
        if (!S.nodes.has(S.pageId)) { S.pageId = null; S.mode = 'read'; }
        if (!S.nodes.has(S.folderId)) S.folderId = null;
        renderTree();
        renderMain();
    }

    /* ---------- opening pages ---------- */

    async function openPage(id, mode = 'read') {
        await flush();
        const p = S.nodes.get(id);
        if (!p || p.type !== 'page') return;
        S.pageId = id;
        S.folderId = p.parentId;
        S.mode = mode;
        S.focusIdx = -1;
        revealAncestors(p);
        store.set('nk.page.' + S.nbId, id);
        renderTree();
        renderMain();
        $('#main').scrollTop = 0;
    }

    async function setMode(mode) {
        if (S.mode === mode || !page()) return;
        await flush();
        S.mode = mode;
        S.focusIdx = -1;
        renderMain();
    }

    /* ---------- images ---------- */

    async function imageURL(imageId) {
        if (urlCache.has(imageId)) return urlCache.get(imageId);
        const rec = await DB.get('images', imageId);
        if (!rec) return null;
        const url = URL.createObjectURL(rec.blob);
        urlCache.set(imageId, url);
        return url;
    }

    function imgEl(block, className) {
        const img = h('img', { class: className, alt: block.caption || 'Page image', loading: 'lazy' });
        imageURL(block.imageId).then((u) => {
            if (u) img.src = u;
            else { img.replaceWith(h('div', { class: 'missing', text: 'Image missing' })); }
        });
        return img;
    }

    function openLightbox(block) {
        const box = h('div', { class: 'lightbox', tabindex: -1, role: 'dialog', 'aria-label': 'Image viewer', onclick: () => box.remove() },
            imgEl(block, 'lb-img'), block.caption && h('p', { text: block.caption }));
        const onKey = (e) => { if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
        document.body.append(box);
        box.focus();
    }

    /* ---------- main pane ---------- */

    function crumbTrail() {
        const parts = [nb().name];
        const p = page();
        const leaf = p || S.nodes.get(S.folderId);
        const chain = [];
        for (let c = leaf; c; c = S.nodes.get(c.parentId)) chain.unshift(c.title);
        return parts.concat(p ? chain.slice(0, -1) : chain).join(' › ');
    }

    function renderCrumbs() {
        const c = $('#crumbs');
        if (c) c.textContent = crumbTrail();
    }

    function renderMain() {
        const main = $('#main');
        main.replaceChildren();
        main.classList.toggle('editing', S.mode === 'edit' && !!page());
        const p = page();
        if (!p) { main.append(emptyState()); return; }
        main.append(
            h('div', { class: 'page-toolbar' },
                h('div', { class: 'crumbs', id: 'crumbs', text: crumbTrail() }),
                h('span', { class: 'muted', id: 'saveStatus', 'aria-live': 'polite' }),
                S.mode === 'edit'
                    ? h('button', { class: 'btn primary', id: 'modeBtn', text: 'Done', title: 'Finish editing (Ctrl+E)', onclick: () => setMode('read') })
                    : h('button', { class: 'btn primary', id: 'modeBtn', text: 'Edit', title: 'Edit this page (Ctrl+E)', onclick: () => setMode('edit') })),
            S.mode === 'edit' ? renderEditor(p) : renderReader(p));
    }

    function emptyState() {
        return h('div', { class: 'empty' },
            h('h2', { text: 'No page open' }),
            h('p', { class: 'muted', text: 'Create a page, or load text and image files to read and edit them here.' }),
            h('div', { class: 'row-actions' },
                h('button', { class: 'btn primary', text: 'New page', onclick: () => newPage() }),
                h('button', { class: 'btn', text: 'Import files…', onclick: () => $('#fileInput').click() })));
    }

    function renderReader(p) {
        const body = h('article', { class: 'reader' }, h('h1', { class: 'page-title', text: p.title }));
        const blocks = p.blocks || [];
        if (!blocks.length || blocks.every((b) => b.type === 'text' && !b.text.trim())) {
            body.append(h('p', { class: 'muted', text: 'This page is empty. Click Edit to add text or images.' }));
        }
        blocks.forEach((b) => {
            if (b.type === 'text') {
                if (b.text.trim()) body.append(h('div', { class: 'text-block', html: Markdown.render(b.text) }));
            } else {
                const img = imgEl(b, 'page-img');
                img.addEventListener('click', () => openLightbox(b));
                body.append(h('figure', { class: 'fig' }, img, b.caption && h('figcaption', { text: b.caption })));
            }
        });
        return body;
    }

    /* ---------- editor ---------- */

    function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }

    function renderEditor(p) {
        const wrap = h('section', { class: 'editor' });
        wrap.append(h('input', {
            class: 'title-input', type: 'text', value: p.title, placeholder: 'Page title', 'aria-label': 'Page title',
            oninput: (e) => {
                p.title = e.target.value;
                touch();
                const row = $(`.row[data-id="${p.id}"] .name`);
                if (row) row.textContent = p.title || 'Untitled';
            },
            onchange: () => { if (!p.title.trim()) { p.title = 'Untitled'; renderTree(); renderMain(); touch(); } },
        }));
        const list = h('div', { class: 'blocks' });
        wrap.append(list);
        wrap.append(h('div', { class: 'add-row' },
            h('button', { class: 'btn', text: '+ Text', onclick: () => insertBlock(textBlock(''), (p.blocks || []).length) }),
            h('button', { class: 'btn', text: '+ Image', onclick: () => pickImages((files) => addFiles(files, (p.blocks || []).length)) }),
            h('span', { class: 'muted hint', text: 'Tip: paste or drop images straight into the page. Text supports Markdown.' })));
        const draw = () => {
            list.replaceChildren(...p.blocks.map((b, i) => blockEditor(p, b, i)));
            list.querySelectorAll('textarea').forEach(autoGrow);
        };
        wrap._draw = draw;
        draw();
        return wrap;
    }

    function blockEditor(p, b, i) {
        const last = p.blocks.length - 1;
        const tools = h('div', { class: 'block-tools' },
            h('span', { class: 'block-kind muted', text: b.type === 'text' ? 'Text' : 'Image' }),
            h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move block up', text: '↑', disabled: i === 0, onclick: () => moveBlock(i, -1) }),
            h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move block down', text: '↓', disabled: i === last, onclick: () => moveBlock(i, 1) }),
            h('button', { class: 'icon-btn', title: 'Insert text block below', 'aria-label': 'Insert text block below', text: '+T', onclick: () => insertBlock(textBlock(''), i + 1) }),
            h('button', { class: 'icon-btn', title: 'Insert image below', 'aria-label': 'Insert image below', text: '+🖼', onclick: () => pickImages((files) => addFiles(files, i + 1)) }),
            h('button', { class: 'icon-btn danger', title: 'Delete block', 'aria-label': 'Delete block', text: '✕', onclick: () => deleteBlock(i) }));
        let body;
        if (b.type === 'text') {
            body = h('textarea', {
                class: 'text-input', rows: 3, value: b.text, placeholder: 'Write notes here… (Markdown: # heading, **bold**, - list)', spellcheck: 'true',
                oninput: (e) => { b.text = e.target.value; autoGrow(e.target); touch(); },
            });
        } else {
            body = h('div', { class: 'image-edit' },
                imgEl(b, 'page-img'),
                h('div', { class: 'image-meta' },
                    h('input', { type: 'text', class: 'caption-input', value: b.caption, placeholder: 'Caption (optional)', 'aria-label': 'Image caption', oninput: (e) => { b.caption = e.target.value; touch(); } }),
                    h('button', { class: 'btn', text: 'Replace image', onclick: () => pickImages((files) => replaceImage(i, files[0]), false) })));
        }
        return h('div', { class: 'block ' + b.type, 'data-idx': i, onfocusin: () => { S.focusIdx = i; } }, tools, body);
    }

    function redrawEditor() { const e = $('.editor'); if (e && e._draw) e._draw(); }

    function insertBlock(block, at) {
        const p = page();
        p.blocks.splice(at, 0, block);
        touch();
        redrawEditor();
        const el = $(`.block[data-idx="${at}"] textarea`);
        if (el) el.focus();
    }
    function moveBlock(i, d) {
        const p = page();
        const [b] = p.blocks.splice(i, 1);
        p.blocks.splice(i + d, 0, b);
        touch();
        redrawEditor();
    }
    function deleteBlock(i) {
        const p = page();
        p.blocks.splice(i, 1);
        if (!p.blocks.length) p.blocks.push(textBlock(''));
        touch();
        redrawEditor();
    }

    function pickImages(cb, multiple = true) {
        const input = h('input', { type: 'file', accept: 'image/*', multiple });
        input.addEventListener('change', () => { if (input.files.length) cb([...input.files]); });
        input.click();
    }

    async function addFiles(files, at) {
        const p = page();
        if (!p) return;
        const imgs = files.filter(isImage).sort((a, b) => collator.compare(a.name, b.name));
        const txt = files.filter(isText);
        const blocks = [];
        for (const f of txt) blocks.push(textBlock((await f.text()).replace(/\r\n?/g, '\n')));
        for (const f of imgs) blocks.push(await imageBlock(f));
        if (!blocks.length) { toast('Only images and .txt/.md files can be added to a page.', true); return; }
        if (at == null) at = p.blocks.length;
        // drop a lone empty placeholder text block so a fresh page doesn't start with a gap
        if (p.blocks.length === 1 && p.blocks[0].type === 'text' && !p.blocks[0].text) { p.blocks.length = 0; at = 0; }
        p.blocks.splice(at, 0, ...blocks);
        touch();
        redrawEditor();
        toast(`Added ${blocks.length} block${blocks.length > 1 ? 's' : ''}.`);
    }

    async function replaceImage(i, file) {
        if (!file || !isImage(file)) { toast('Please choose an image file.', true); return; }
        const p = page();
        const nbk = await imageBlock(file);
        p.blocks[i].imageId = nbk.imageId;
        touch();
        redrawEditor();
    }

    /* ---------- importing ---------- */

    async function importFiles(files) {
        files = [...files];
        if (!files.length) return;
        try {
            const backups = files.filter(isBackup);
            const rest = files.filter((f) => !isBackup(f));
            let created = [];
            if (rest.length) {
                const pages = await filesToPages(rest);
                for (const d of pages) created.push(await createNode('page', d.title, S.folderId, d.blocks));
                if (S.folderId) S.expanded.add(S.folderId);
            }
            let restored = null;
            for (const f of backups) restored = await Importer.importBackup(f);
            if (restored) {
                S.notebooks.push(restored);
                await loadNotebook(restored.id);
                toast(`Restored notebook "${restored.name}".`);
                return;
            }
            if (!created.length) { toast('Nothing to import. Use images, .txt, .md or a Notekeeper .json backup.', true); return; }
            await openPage(created[0].id);
            toast(`Imported ${created.length} page${created.length > 1 ? 's' : ''}.`);
        } catch (err) {
            console.error(err);
            toast('Import failed: ' + err.message, true);
        }
    }

    /* ---------- drag & drop + paste ---------- */

    let dragDepth = 0;
    const overlay = () => $('#dropOverlay');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        dragDepth++;
        const adding = S.mode === 'edit' && page();
        $('#dropText').textContent = adding ? 'Drop to add to this page' : 'Drop to import as new page(s)';
        overlay().hidden = false;
    });
    addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; overlay().hidden = true; } });
    addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        overlay().hidden = true;
        const files = [...e.dataTransfer.files];
        if (S.mode === 'edit' && page()) addFiles(files, S.focusIdx >= 0 ? S.focusIdx + 1 : null);
        else importFiles(files);
    });
    document.addEventListener('paste', (e) => {
        if (S.mode !== 'edit' || !page()) return;
        const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(isImage);
        if (!files.length) return;
        e.preventDefault();
        addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], 'pasted-' + Date.now() + '-' + i + '.png', { type: f.type }))),
            S.focusIdx >= 0 ? S.focusIdx + 1 : null);
    });

    /* ---------- chrome wiring ---------- */

    function toggleSidebar(force) {
        const open = force == null ? !document.body.classList.contains('sidebar-open') : force;
        document.body.classList.toggle('sidebar-open', open);
        $('#menuBtn').setAttribute('aria-expanded', String(open));
    }

    function wire() {
        $('#menuBtn').addEventListener('click', () => toggleSidebar());
        $('#newPageBtn').addEventListener('click', () => newPage());
        $('#newFolderBtn').addEventListener('click', () => newFolder());
        $('#importBtn').addEventListener('click', () => $('#fileInput').click());
        $('#fileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
        $('#notebookSelect').addEventListener('change', (e) => loadNotebook(e.target.value));
        $('#notebookMore').addEventListener('click', (e) => {
            e.stopPropagation(); // don't let the document-level click handler close the menu we're opening
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom, [
                { label: 'New notebook…', run: newNotebook },
                { label: 'Rename notebook…', run: renameNotebook },
                { label: 'Export backup (.json)', run: exportNotebook },
                { label: 'Export for TI-84 CE (.zip)\u2026', run: exportForCalculator },
                { label: 'Delete notebook…', danger: true, run: deleteNotebook },
            ]);
        });
        $('#search').addEventListener('input', (e) => { S.query = e.target.value; renderTree(); });
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && page()) {
                e.preventDefault();
                setMode(S.mode === 'edit' ? 'read' : 'edit');
            }
        });
    }

    async function init() {
        wire();
        try {
            S.notebooks = await DB.getAll('notebooks');
        } catch (err) {
            $('#main').replaceChildren(h('div', { class: 'empty' }, h('h2', { text: 'Storage unavailable' }), h('p', { class: 'muted', text: err.message + ' Notekeeper needs IndexedDB (not available in some private-browsing modes).' })));
            return;
        }
        S.notebooks.sort((a, b) => a.created - b.created);
        if (!S.notebooks.length) {
            const first = { id: uid(), name: 'My notes', created: Date.now() };
            await DB.put('notebooks', first);
            S.notebooks.push(first);
            S.nbId = first.id;
            await createNode('page', 'Welcome', null, [textBlock(WELCOME)]);
        }
        const saved = store.get('nk.notebook');
        await loadNotebook(S.notebooks.find((n) => n.id === saved) ? saved : S.notebooks[0].id);
    }

    const WELCOME = [
        '# Welcome to Notekeeper',
        '',
        'Pages are made of **text** and **images**. You are reading one now.',
        '',
        '## Load pages',
        '- Click **Import** (or drop files anywhere) to load `.txt` / `.md` files and images.',
        '- A markdown file with several `# Headings` becomes one page per heading.',
        '- Several images dropped together become one page, in filename order.',
        '- Notebooks can be backed up and restored from the ⋯ menu next to the notebook name.',
        '',
        '## Edit',
        '- Press **Edit** (or Ctrl+E) to change text, add captions, reorder blocks, replace images, or paste screenshots.',
        '- Changes save automatically.',
        '',
        '> Adapted from TINotes by Kevin Li (MIT).',
    ].join('\n');

    init();
})();
