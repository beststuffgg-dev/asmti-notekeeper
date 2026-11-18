// Drives the real web app: import sample files, run "Export for TI-84 CE", save the zip.
// usage: node web_export.js <repo-root> <outdir> file...
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [root, outdir, ...files] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('file://' + path.join(root, 'index.html'));
  await page.waitForSelector('.reader');
  await page.setInputFiles('#fileInput', files);
  await page.waitForSelector('#toast.show');
  const dl = page.waitForEvent('download');
  await page.click('#notebookMore');
  await page.click('.menu-item:text("Export for TI-84 CE")');
  const d = await dl;
  await d.saveAs(path.join(outdir, 'export.zip'));
  await page.waitForSelector('dialog.dlg');
  const msg = await page.textContent('dialog.dlg');
  require('fs').writeFileSync(path.join(outdir, 'dialog.txt'), msg);
  await page.screenshot({ path: path.join(outdir, 'dialog.png') });
  await browser.close();
  if (errors.length) { console.error('PAGE ERRORS', errors); process.exit(2); }
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
