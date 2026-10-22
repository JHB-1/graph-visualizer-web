"""실제 WASM 문서와 service worker의 안전한 버전 전환 검사"""
from __future__ import annotations

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import threading
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def build(version: str, corrupt: bool = False) -> dict[str, bytes]:
	assets = {path.relative_to(ROOT / 'dist').as_posix(): path.read_bytes()
		for path in (ROOT / 'dist').rglob('*') if path.is_file() and path.name not in ('update-manifest.json', '.nojekyll')}
	current = json.loads(assets['build.json'])['version']
	for name in ('app.js', 'update-worker.js', 'build.json'):
		assets[name] = assets[name].replace(current.encode(), version.encode())

	files = [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(assets.items())]
	manifest = {'schema': 1, 'product': 'gv', 'component': 'web', 'version': version,
		'build': hashlib.sha256(json.dumps(files).encode()).hexdigest(), 'files': files}
	if corrupt:
		files[0]['sha256'] = '0' * 64

	assets['update-manifest.json'] = json.dumps(manifest).encode()

	return assets


class UpdateTests(unittest.TestCase):
	def test_waiting_update_keeps_graph_then_restores_and_rejects_corruption(self) -> None:
		assets = build('0.3.3')

		class Handler(BaseHTTPRequestHandler):
			def do_GET(self) -> None:
				name = urlsplit(self.path).path.lstrip('/') or 'index.html'
				content = assets.get(name)
				if content is None:
					self.send_error(404)
					return

				self.send_response(200)
				self.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
				self.send_header('Content-Length', str(len(content)))
				self.send_header('Cache-Control', 'no-store')
				self.end_headers()
				self.wfile.write(content)

			def log_message(self, _format: str, *args: object) -> None:
				pass

		server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
		thread = threading.Thread(target=server.serve_forever, daemon=True)
		thread.start()
		try:
			with sync_playwright() as playwright:
				browser = playwright.chromium.launch(executable_path=os.environ.get('GV_CHROMIUM'), headless=True)
				context = browser.new_context(accept_downloads=True)
				page = context.new_page()
				origin = f'http://127.0.0.1:{server.server_port}/'
				page.goto(origin)
				page.evaluate('() => navigator.serviceWorker.ready')
				page.reload()
				page.wait_for_function("() => window.gv?.ready && document.querySelector('#engine-state').classList.contains('ready')")
				self.assertTrue(page.evaluate('() => Boolean(navigator.serviceWorker.controller)'))
				page.locator('#add-node').click()
				page.locator('#tab-file').click()
				page.wait_for_function("() => document.querySelector('#autosave-state').textContent === '브라우저에 저장됨'")
				count = page.locator('#nodes > g').count()
				page.evaluate("window.keptNode = gv.objects.nodes.get('1')?.group")
				assets = build('0.3.4')
				page.evaluate('async () => (await navigator.serviceWorker.getRegistration()).update()')
				page.evaluate('''async () => {
					for (let attempt=0; attempt<400; attempt++) {
						if ((await navigator.serviceWorker.getRegistration()).waiting?.state === 'installed') return;
						await new Promise(resolve => setTimeout(resolve,50));
					}
					throw new Error('Update installation timed out');
				}''')
				self.assertEqual(page.locator('#nodes > g').count(), count)
				self.assertEqual(page.evaluate("async () => (await (await fetch('build.json')).json()).version"), '0.3.3')
				self.assertTrue(page.evaluate("() => keptNode === gv.objects.nodes.get('1')?.group"))
				worker = next(item for item in context.service_workers if item.evaluate('() => VERSION') == '0.3.4')
				page.on('dialog', lambda dialog: dialog.accept())
				page.close()
				worker.evaluate('''async () => {
					for (let attempt=0; attempt<500; attempt++) {
						if (!self.registration.waiting && self.registration.active?.state === 'activated') return;
						await new Promise(resolve => setTimeout(resolve,10));
					}
					throw new Error('Update activation timed out');
				}''')
				page = context.new_page()
				page.goto(origin)
				page.wait_for_function("() => window.gv?.ready && document.querySelector('#engine-state').classList.contains('ready')")
				self.assertEqual(page.evaluate("async () => (await (await fetch('build.json')).json()).version"), '0.3.4')
				page.locator('#tab-file').click()
				page.locator('#recovery-restore').click()
				page.wait_for_function('(count) => document.querySelectorAll("#nodes > g").length === count', arg=count)
				assets = build('0.3.5', corrupt=True)
				page.evaluate('async () => (await navigator.serviceWorker.getRegistration()).update()')
				page.evaluate('''async () => {
					for (let attempt=0; attempt<400; attempt++) {
						if (!(await navigator.serviceWorker.getRegistration()).installing) return;
						await new Promise(resolve => setTimeout(resolve,50));
					}
					throw new Error('Corrupt update did not finish');
				}''')
				self.assertEqual(page.evaluate("async () => (await (await fetch('build.json')).json()).version"), '0.3.4')
				self.assertFalse(page.evaluate("async () => (await caches.keys()).some(name => name.includes('-0.3.5-'))"))
				browser.close()
		finally:
			server.shutdown()
			server.server_close()
			thread.join(timeout=5)


if __name__ == '__main__':
	unittest.main()
