// Driver for markdown-render-speed-02.
//
// The harness runs this file as `node /bot/main.ts`. It loads every case
// from cases.json in the input directory, renders each case's markdown with
// the parse() function from ./parse.js, and writes the resulting HTML
// strings — one per case, in the cases' order — as a JSON array to
// html.json in the output directory. Outside the harness container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR point at the two directories.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
