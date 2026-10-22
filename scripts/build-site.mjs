import {build} from 'esbuild';
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readdir} from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(output, {recursive: true});
await cp(path.join(root, 'public'), output, {recursive: true});
await cp(path.join(root, 'index.html'), path.join(output, 'index.html'));
await writeFile(path.join(output, '.nojekyll'), '');
await writeFile(path.join(output, 'style.css'), await readFile(path.join(root, 'src/renderer/style.css'), 'utf8') + '\n' +
	await readFile(path.join(root, 'src/workspace.css'), 'utf8') + '\n' +
	await readFile(path.join(root, 'src/site.css'), 'utf8'));
await build({absWorkingDir: root, entryPoints: {'app': 'src/main.ts', 'engine-worker': 'src/engine-worker.ts'},
	bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: true, sourcemap: false, outdir: output,
	define: {GV_WEB_VERSION: JSON.stringify(metadata.version)}});
const lock = JSON.parse(await readFile(path.join(root, 'core.lock.json'), 'utf8'));
await writeFile(path.join(output, 'build.json'), JSON.stringify({version: metadata.version, core: lock.commit, runtime: 'WebAssembly'}));
await writeFile(path.join(output, 'update-worker.js'),
	(await readFile(path.join(root, 'scripts/update-worker.js'), 'utf8')).replace('__GV_VERSION__', metadata.version));
const files = [];
async function inventory(directory, prefix = '')
{
	for (const entry of await readdir(directory, {withFileTypes: true}))
	{
		const name = prefix + entry.name;
		if (name === 'update-manifest.json' || name === '.nojekyll') continue;
		if (entry.isSymbolicLink()) throw new Error('Update assets cannot be symlinks');
		if (entry.isDirectory()) await inventory(path.join(directory, entry.name), name + '/');
		else
		{
			const data = await readFile(path.join(directory, entry.name));
			files.push({path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')});
		}
	}
}
await inventory(output);
files.sort((left, right) => left.path.localeCompare(right.path));
const buildId = createHash('sha256').update(JSON.stringify(files)).digest('hex');
await writeFile(path.join(output, 'update-manifest.json'),
	JSON.stringify({schema: 1, product: 'gv', component: 'web', version: metadata.version, build: buildId, files}));
console.log('Built GitHub Pages assets at dist/.');
