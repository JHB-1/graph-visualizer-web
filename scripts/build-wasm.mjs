import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const core = process.env.GV_CORE_DIR;
const boost = process.env.GV_BOOST_INCLUDE_DIR;
const json = process.env.GV_JSON_INCLUDE;
if (!core || !boost || !json)
	throw new Error('Set GV_CORE_DIR, GV_BOOST_INCLUDE_DIR and GV_JSON_INCLUDE to authorized local dependency directories.');

const lock = JSON.parse(await readFile(path.join(root, 'core.lock.json'), 'utf8'));
const revision = spawnSync('git', ['-C', core, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
if (revision.status !== 0 || revision.stdout.trim() !== lock.commit)
	throw new Error('Core checkout must match core.lock.json; source is never copied into the public repository.');

const changes = spawnSync('git', ['-C', core, 'status', '--porcelain', '--untracked-files=no', '--',
	'src', 'include', 'CMakeLists.txt', 'hosts/agent-plugin/native'], {encoding: 'utf8'});
if (changes.status !== 0 || changes.stdout.trim()) throw new Error('Core build inputs have uncommitted modifications.');

const source = await readFile(path.join(core, 'hosts/agent-plugin/native/main.cpp'), 'utf8');
const main = source.indexOf('\nint main()');
if (main < 0) throw new Error('Unsupported core adapter: main entry point not found.');

await mkdir(path.join(root, '.build'), {recursive: true});
await mkdir(path.join(root, 'public/wasm'), {recursive: true});
await writeFile(path.join(root, '.build/bridge.cpp'), source.slice(0, main) + '\n' +
	await readFile(path.join(root, 'native/wasm-api.cpp'), 'utf8'));
const mount = (source, target, readonly = true) => ['--mount', `type=bind,source=${path.resolve(source)},target=${target}${readonly ? ',readonly' : ''}`];
const result = spawnSync('docker', [
	'run', '--rm', ...mount(root, '/web', false), ...mount(core, '/core'), ...mount(boost, '/boost'), ...mount(json, '/json'),
	lock.emscripten, 'bash', '-lc',
	'if [ ! -x /web/.build/tools/bin/cmake ]; then python3 -m pip install --quiet --target /web/.build/tools cmake==3.31.6; fi && ' +
	'export PYTHONPATH=/web/.build/tools && export PATH=/web/.build/tools/bin:$PATH && ' +
	'emcmake cmake -S /web/native -B /web/.build/wasm -DCMAKE_BUILD_TYPE=Release -DGV_CORE_DIR=/core ' +
	'-DGV_BOOST_INCLUDE_DIR=/boost -DGV_JSON_INCLUDE=/json && cmake --build /web/.build/wasm --parallel 4'
], {stdio: 'inherit'});
if (result.status !== 0) throw new Error('WASM build failed.');

console.log('Built original pinned core; no core source is part of public assets.');
