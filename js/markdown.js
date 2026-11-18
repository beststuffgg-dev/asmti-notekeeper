// Minimal, safe Markdown renderer for reading mode.
// All input is HTML-escaped first, so only tags emitted here can reach the DOM.
(function (global) {
    'use strict';

    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function inline(raw) {
        let s = esc(raw);
        const codes = [];
        s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
        s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img alt="$1" src="$2" loading="lazy">');
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
            .replace(/~~([^~]+)~~/g, '<del>$1</del>');
        return s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[i] + '</code>');
    }

    const LIST_RE = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    const isBlockStart = (l) => /^(```|#{1,6}\s|>\s?|(-{3,}|\*{3,})\s*$)/.test(l) || LIST_RE.test(l);

    function render(src) {
        const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const l = lines[i];
            let m;
            if (/^```/.test(l)) {
                const buf = [];
                i++;
                while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
                i++;
                out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
            } else if (!l.trim()) {
                i++;
            } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
                out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>');
                i++;
            } else if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
                out.push('<hr>');
                i++;
            } else if (/^>\s?/.test(l)) {
                const buf = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(inline(lines[i++].replace(/^>\s?/, '')));
                out.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
            } else if ((m = l.match(LIST_RE))) {
                const ordered = /\d/.test(m[1]);
                const items = [];
                while (i < lines.length && (m = lines[i].match(LIST_RE))) {
                    let text = m[2];
                    let prefix = '';
                    if (/^\[( |x|X)\]\s/.test(text)) {
                        prefix = /^\[ \]/.test(text) ? '☐ ' : '☑ ';
                        text = text.slice(4);
                    }
                    items.push('<li>' + prefix + inline(text) + '</li>');
                    i++;
                }
                const tag = ordered ? 'ol' : 'ul';
                out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
            } else {
                const buf = [];
                while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) {
                    buf.push(inline(lines[i++]));
                }
                out.push('<p>' + buf.join('<br>') + '</p>');
            }
        }
        return out.join('\n');
    }

    global.Markdown = { render };
})(window);
