import {readFile, readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: root, encoding: 'utf8'});
if (files.status !== 0) throw new Error('Cannot inspect public repository file inventory.');

const allowedRoots = new Set(['src', 'scripts', 'native', 'public', 'tests', '.github', 'docs']);
const allowedFiles = new Set(['.gitignore', '.gitattributes', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'core.lock.json',
	'index.html', 'README.md', 'THIRD_PARTY.md', 'requirements-test.txt', 'VALIDATION.md']);
for (const name of files.stdout.split('\0').filter(Boolean))
{
	if (!allowedRoots.has(name.split('/')[0]) && !allowedFiles.has(name)) throw new Error(`Unexpected public file: ${name}`);
	if (/(^|\/)(\.build|\.git|node_modules|include|core)(\/|$)|\.(map|pdb|a|o|obj|lib|pem|key)$/.test(name))
		throw new Error(`Private/build material cannot be published: ${name}`);
	if (/\.(cpp|hpp|h)$/.test(name) && name !== 'native/wasm-api.cpp')
		throw new Error(`Core source or header cannot be published: ${name}`);
	if (!name.endsWith('.wasm'))
	{
		const text = await readFile(path.join(root, name), 'utf8');
		if (/(github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{25,}|[A-Za-z]:[\\/]Users[\\/]|\/home\/[A-Za-z0-9_-]+\/)/.test(text))
			throw new Error(`Credential or workstation path found: ${name}`);
	}
}

const assets = [];
async function inspect(directory, relative = '')
{
	for (const file of await readdir(directory, {withFileTypes: true}))
	{
		const name = relative + file.name;
		if (file.isSymbolicLink()) throw new Error(`Deployment symlink forbidden: ${name}`);
		if (file.isDirectory()) await inspect(path.join(directory, file.name), name + '/');
		else
		{
			if (!/^(index\.html|style\.css|app\.js|engine-worker\.js|build\.json|favicon\.svg|\.nojekyll|licenses\/.+|wasm\/gv-core\.(mjs|wasm))$/.test(name))
				throw new Error(`Unexpected deploy asset: ${name}`);
			const content = await readFile(path.join(directory, file.name));
			assets.push({name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')});
		}
	}
}
await inspect(path.join(root, 'dist'));
const wasm = await readFile(path.join(root, 'dist/wasm/gv-core.wasm'));
if (!wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Missing real WebAssembly binary.');

const lock = JSON.parse(await readFile(path.join(root, 'core.lock.json'), 'utf8'));
for (const [name, expected] of Object.entries(lock.artifacts))
	if (createHash('sha256').update(await readFile(path.join(root, 'public/wasm', name))).digest('hex') !== expected)
		throw new Error(`Pinned core artifact has changed: ${name}`);

console.log(JSON.stringify({sourceFiles: files.stdout.split('\0').filter(Boolean).length, assets}, null, 2));
