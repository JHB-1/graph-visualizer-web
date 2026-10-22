// 버전별 검증 캐시 사용, 열린 탭 강제 전환 금지
const VERSION = '__GV_VERSION__';
const SCOPE = 'gv-web-v1-' + encodeURIComponent(new URL(self.registration.scope).pathname) + '-';
const PREFIX = SCOPE + VERSION + '-';
let cacheName;
self.addEventListener('message', event =>
{
	if (event.data?.type === 'version') event.ports[0]?.postMessage({version: VERSION});
});
self.addEventListener('activate', event => event.waitUntil((async () =>
{
	const names = (await caches.keys()).filter(name => name.startsWith(SCOPE));
	const current = names.find(name => name.startsWith(PREFIX));
	const previous = names.filter(name => name !== current).at(-1);
	for (const name of names)
		if (name !== current && name !== previous) await caches.delete(name);
})()));
const allowed = /^(index\.html|app\.js|style\.css|engine-worker\.js|build\.json|favicon\.svg|update-worker\.js|\.nojekyll|licenses\/[A-Za-z0-9_.-]+|wasm\/gv-core\.(wasm|mjs)|fonts\/PretendardVariable\.woff2)$/;

async function bytes(response, limit)
{
	if (!response.ok || !response.body) throw new Error('Update download failed');

	const reader = response.body.getReader();
	const parts = [];
	let length = 0;
	try
	{
		for (;;)
		{
			const {done, value} = await reader.read();
			if (done) break;

			length += value.length;
			if (length > limit) throw new Error('Update download exceeds limit');

			parts.push(value);
		}
	}
	finally {await reader.cancel();}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {output.set(part, offset); offset += part.length;}

	return output;
}

self.addEventListener('install', event => event.waitUntil((async () =>
{
	const base = new URL(self.registration.scope);
	const response = await fetch(new URL('update-manifest.json', base), {cache: 'no-store', redirect: 'error'});
	const manifest = JSON.parse(new TextDecoder().decode(await bytes(response, 65536)));
	if (manifest.schema !== 1 || manifest.product !== 'gv' || manifest.component !== 'web' || manifest.version !== VERSION ||
		!/^[a-f0-9]{64}$/.test(manifest.build) || !Array.isArray(manifest.files) || manifest.files.length > 100)
		throw new Error('Invalid update manifest');

	const paths = new Set();
	let total = 0;
	for (const file of manifest.files)
	{
		if (typeof file.path !== 'string' || !allowed.test(file.path) || paths.has(file.path) ||
			!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
			throw new Error('Invalid update file');

		paths.add(file.path);
		total += file.bytes;
		if (total > 32 * 1024 * 1024) throw new Error('Update exceeds storage budget');
	}
	if (!['index.html', 'app.js', 'style.css', 'engine-worker.js', 'wasm/gv-core.wasm'].every(path => paths.has(path)))
		throw new Error('Incomplete update');

	const name = PREFIX + manifest.build;
	const cache = await caches.open(name);
	try
	{
		for (const file of manifest.files)
		{
			const url = new URL(file.path, base);
			const response = await fetch(url, {cache: 'no-store', redirect: 'error'});
			const content = await bytes(response, file.bytes);
			const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)))
				.map(value => value.toString(16).padStart(2, '0')).join('');
			if (content.length !== file.bytes || hash !== file.sha256) throw new Error('Update digest mismatch');

			const headers = new Headers(response.headers);
			headers.delete('content-encoding');
			headers.delete('content-length');
			await cache.put(url, new Response(content, {headers}));
		}
		cacheName = name;
	}
	catch (error)
	{
		await caches.delete(name);
		throw error;
	}
})()));

self.addEventListener('fetch', event =>
{
	const url = new URL(event.request.url);
	const base = new URL(self.registration.scope);
	if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;

	const path = url.pathname.slice(base.pathname.length);
	if (path === 'update-manifest.json' || path === 'update-worker.js') return;

	event.respondWith((async () =>
	{
		if (!cacheName) cacheName = (await caches.keys()).find(name => name.startsWith(PREFIX));

		if (!cacheName) return fetch(event.request);

		const key = event.request.mode === 'navigate' ? new URL('index.html', base) : new URL(url.pathname, base);
		const cached = await (await caches.open(cacheName)).match(key);

		return cached ?? new Response('Unknown application asset', {status: 404});
	})());
});
