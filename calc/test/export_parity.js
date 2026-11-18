// Prints the exporter's byte output for fixed inputs as JSON so run_tests.py can compare it with nkpack.py.
require(process.argv[2] + '/js/ti-export.js');
const T = TIExport, hex = (u) => Buffer.from(u).toString('hex');
const tricky = 'café “quote” — dash … tab\there ⋯ › → × 😀 end\r\nnext';
const long = ('word ' .repeat(1000)) + 'tail';
const pal = [0x7fff, 0x0000, 0x03e0, 0x7c00];
console.log(JSON.stringify({
  clean: T.asciiClean(tricky),
  page: hex(T.buildPage('Títle\nx', [{ type: 'text', text: tricky }, { type: 'image', name: 'NKI00010', w: 160, h: 100 }, { type: 'text', text: long }], pal)),
  index: hex(T.buildIndex([{ name: 'NKP0001', title: 'One' }, { name: 'NKP0002', title: tricky }])),
  v8: hex(T.appvar8xv('NKP0001', Uint8Array.from([1, 2, 3, 4, 250]), false)),
  v8a: hex(T.appvar8xv('NKIDX', Uint8Array.from([0]), true)),
}));
