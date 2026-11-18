# Notekeeper

A local-first notebook for reading and editing **pages made of text and images**.
Organise pages in notebooks and folders, load files into them, read them in a clean
reader view, and switch to edit mode to change anything. Everything stays in your
browser (IndexedDB); nothing is uploaded.

Adapted from [AlienKevin/TINotes](https://github.com/AlienKevin/TINotes) (MIT, © 2019 Kevin Li).
The notebook / folder / page structure and sidebar come from TINotes; the TI-calculator
specifics (fixed-width wrapping, uppercase-only text, TI-BASIC script generation) were removed,
and storage moved from localStorage to IndexedDB so pages can hold images.

## Run it

No build step and no dependencies. Open `index.html` in a modern browser (double-click works),
or serve the folder with any static server, e.g. `python3 -m http.server`.

## Loading pages

Use **Import**, or drag files onto the window.

| You load | You get |
| --- | --- |
| `.txt` / `.md` file | one page named after the file |
| `.md` with two or more `# Headings` | one page per heading |
| one or more images | a single page, images in filename order (`page2` before `page10`) |
| a Notekeeper `.json` backup | a restored copy as a new notebook |

New pages land in the folder you last selected. While editing a page, dropped or pasted
images and text files are added to *that page* instead.

## Reading and editing

- **Read**: rendered Markdown (headings, bold/italic, lists, task lists, quotes, code, links),
  figures with captions, click an image to zoom. Print-friendly.
- **Edit** (button or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>E</kbd>): edit the title and text blocks,
  add captions, reorder / insert / delete blocks, replace images, paste screenshots.
  Changes autosave (watch the "Saved" indicator).
- Sidebar: notebooks, folders, search across titles, text and captions, right-click or
  <kbd>⋯</kbd> for rename / move / delete.
- Notebook <kbd>⋯</kbd> menu: new, rename, delete, **export backup** (`.json`, images included).

Markdown is rendered by a small built-in renderer that escapes all HTML, so imported
text can't inject markup.

## Layout

```
index.html        page shell
css/app.css       styles (light/dark, mobile slide-over sidebar)
js/db.js          IndexedDB wrapper
js/markdown.js    safe Markdown -> HTML
js/importer.js    files -> pages, backup export/import
js/app.js         UI and state
```

## Limits

Not supported: PDF, Word/HTML import, and Markdown image links to local files (only `https://` images
render). Data lives in one browser profile; use **Export backup** to move or keep a copy.
