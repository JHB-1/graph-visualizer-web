import {build} from 'esbuild';
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist');
await mkdir(output, {recursive: true});
await cp(path.join(root, 'public'), output, {recursive: true});
await cp(path.join(root, 'index.html'), path.join(output, 'index.html'));
await writeFile(path.join(output, '.nojekyll'), '');
await writeFile(path.join(output, 'style.css'), await readFile(path.join(root, 'src/renderer/style.css'), 'utf8') + '\n' +
	await readFile(path.join(root, 'src/workspace.css'), 'utf8') + '\n' +
	await readFile(path.join(root, 'src/site.css'), 'utf8'));
await build({absWorkingDir: root, entryPoints: {'app': 'src/main.ts', 'engine-worker': 'src/engine-worker.ts'},
	bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: true, sourcemap: false, outdir: output});
const lock = JSON.parse(await readFile(path.join(root, 'core.lock.json'), 'utf8'));
await writeFile(path.join(output, 'build.json'), JSON.stringify({version: '0.2.3', core: lock.commit, runtime: 'WebAssembly'}));
console.log('Built GitHub Pages assets at dist/.');
