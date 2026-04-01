// webpack bundle → Wasm component
import { componentize } from '@bytecodealliance/componentize-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

console.log('componentize: dist/bundle.js → dist/main.wasm');

const source = readFileSync(resolve(root, 'dist/bundle.js'), 'utf-8');

const { component } = await componentize(source, {
  witPath: resolve(root, 'node_modules/@fermyon/spin-sdk/wit'),
  world: 'spin-imports',
});

writeFileSync(resolve(root, 'dist/main.wasm'), component);
console.log('✓ dist/main.wasm');
