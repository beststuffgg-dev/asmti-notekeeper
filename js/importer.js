// Turning files into pages: text/markdown files, images, and JSON backups.
(function (global) {
    'use strict';

    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    const ext = (name) => (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    const baseName = (name) => name.replace(/\.[^.]+$/, '');
    const isImage = (f) => /^image\//.test(f.type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext(f.name));
    const isText = (f) => ['txt', 'md', 'markdown', 'text'].includes(ext(f.name)) || f.type === 'text/plain' || f.type === 'text/markdown';
    const isBackup = (f) => ext(f.name) === 'json' || f.type === 'application/json';

    // Store an image file and return a block that references it.
    async function imageBlock(file) {
        const image = { id: uid(), blob: file, name: file.name || 'image', type: file.type || 'image/png' };
        await DB.put('images', image);
        return { id: uid(), type: 'image', imageId: image.id, caption: '' };
    }

    const textBlock = (text) => ({ id: uid(), type: 'text', text });

    // Split one text file into one or more { title, text } pages.
    // A file with two or more top-level "# Heading" lines becomes one page per heading.
    function splitText(raw, fileTitle) {
        const lines = raw.replace(/\r\n?/g, '\n').split('\n');
        const heads = [];
        let fence = false;
        lines.forEach((l, i) => {
            if (/^```/.test(l)) fence = !fence;
            else if (!fence && /^#\s+\S/.test(l)) heads.push(i);
        });
        if (heads.length >= 2) {
            const pages = [];
            const pre = lines.slice(0, heads[0]).join('\n').trim();
            if (pre) pages.push({ title: fileTitle, text: pre });
            heads.forEach((start, k) => {
                const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
                pages.push({ title: lines[start].replace(/^#\s+/, '').trim(), text: lines.slice(start + 1, end).join('\n').trim() });
            });
            return pages;
        }
        if (heads.length === 1 && heads[0] === lines.findIndex((l) => l.trim())) {
            return [{ title: lines[heads[0]].replace(/^#\s+/, '').trim(), text: lines.slice(heads[0] + 1).join('\n').trim() }];
        }
        return [{ title: fileTitle, text: raw.replace(/\r\n?/g, '\n').trim() }];
    }

    // Build page descriptions ({ title, blocks }) from a list of files.
    // Text files -> one page each (or several, see splitText); all images together -> one page.
    async function filesToPages(files) {
        const list = [...files].sort((a, b) => collator.compare(a.name, b.name));
        const pages = [];
        for (const f of list.filter(isText)) {
            const raw = await f.text();
            splitText(raw, baseName(f.name)).forEach((p) => {
                pages.push({ title: p.title || baseName(f.name), blocks: [textBlock(p.text)] });
            });
        }
        const imgs = list.filter(isImage);
        if (imgs.length) {
            const blocks = [];
            for (const f of imgs) blocks.push(await imageBlock(f));
            const title = imgs.length === 1 ? baseName(imgs[0].name) : baseName(imgs[0].name) + ' (+' + (imgs.length - 1) + ' more)';
            pages.push({ title, blocks });
        }
        return pages;
    }

    /* ---------- backup (export / import of a whole notebook) ---------- */

    const readAsDataURL = (blob) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blob);
    });

    function dataURLToBlob(url) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
        if (!m) throw new Error('Bad image data in backup');
        const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
    }

    async function exportNotebook(notebook, nodes) {
        const ids = new Set();
        nodes.forEach((n) => (n.blocks || []).forEach((b) => b.imageId && ids.add(b.imageId)));
        const images = [];
        for (const id of ids) {
            const rec = await DB.get('images', id);
            if (rec) images.push({ id, name: rec.name, type: rec.type, data: await readAsDataURL(rec.blob) });
        }
        const data = { app: 'notekeeper-backup', version: 1, notebook: { name: notebook.name }, nodes, images };
        return new Blob([JSON.stringify(data)], { type: 'application/json' });
    }

    // Create a brand-new notebook from a backup file. Every id is re-generated so a
    // backup can never overwrite existing data. Returns the new notebook.
    async function importBackup(file) {
        let data;
        try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('That file is not valid JSON.'); }
        if (!data || data.app !== 'notekeeper-backup' || !Array.isArray(data.nodes) || !Array.isArray(data.images)) {
            throw new Error('That JSON file is not a Notekeeper backup.');
        }
        const imageMap = new Map();
        const imageRecords = data.images.map((im) => {
            const id = uid();
            imageMap.set(im.id, id);
            return { id, name: im.name, type: im.type, blob: dataURLToBlob(im.data) };
        });
        const notebook = { id: uid(), name: ((data.notebook && data.notebook.name) || 'Imported') + ' (restored)', created: Date.now() };
        const nodeMap = new Map(data.nodes.map((n) => [n.id, uid()]));
        const nodes = data.nodes.map((n) => ({
            id: nodeMap.get(n.id),
            notebookId: notebook.id,
            parentId: n.parentId ? nodeMap.get(n.parentId) || null : null,
            type: n.type === 'folder' ? 'folder' : 'page',
            title: String(n.title || 'Untitled'),
            blocks: n.type === 'folder' ? undefined : (n.blocks || []).map((b) => b.type === 'image'
                ? { id: uid(), type: 'image', imageId: imageMap.get(b.imageId), caption: String(b.caption || '') }
                : { id: uid(), type: 'text', text: String(b.text || '') }),
            created: n.created || Date.now(),
            updated: n.updated || Date.now(),
        }));
        await DB.putMany('images', imageRecords);
        await DB.put('notebooks', notebook);
        await DB.putMany('nodes', nodes);
        return notebook;
    }

    global.Importer = { uid, isImage, isText, isBackup, imageBlock, textBlock, filesToPages, exportNotebook, importBackup };
})(window);
