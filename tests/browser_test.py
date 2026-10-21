from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
	def do_GET(self):
		if self.path.startswith('/graph-visualizer-web/'):
			self.path = self.path.removeprefix('/graph-visualizer-web')
		return super().do_GET()

	def log_message(self, *_):
		pass


class BrowserTests(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.http = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT / 'dist')))
		cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
		cls.thread.start()
		cls.origin = os.environ.get('GV_WEB_TEST_URL') or f'http://127.0.0.1:{cls.http.server_port}/graph-visualizer-web/'
		cls.playwright = sync_playwright().start()
		cls.browser = cls.playwright.chromium.launch(headless=True)

	@classmethod
	def tearDownClass(cls):
		cls.browser.close()
		cls.playwright.stop()
		cls.http.shutdown()
		cls.http.server_close()

	def setUp(self):
		self.page = self.browser.new_page(viewport={'width': 1440, 'height': 1050})
		self.errors = []
		self.requests = []
		self.page.on('pageerror', lambda error: self.errors.append(str(error)))
		self.page.on('request', lambda request: self.requests.append(request.url))
		self.page.goto(self.origin)
		self.page.wait_for_function('() => window.gv?.ready', timeout=30_000)

	def tearDown(self):
		(ROOT / 'test-results').mkdir(exist_ok=True)
		self.page.screenshot(path=str(ROOT / 'test-results' / (self._testMethodName + '.png')), full_page=True)
		self.page.close()
		self.assertEqual(self.errors, [])

	def test_wasm_and_no_backend(self):
		self.assertIn('브라우저 실행', self.page.locator('#engine-state').inner_text())
		self.assertTrue(any(url.endswith('.wasm') for url in self.requests))
		self.assertTrue(all(url.startswith(self.origin) for url in self.requests), self.requests)
		self.assertFalse(any('/api' in url or '/mcp' in url for url in self.requests))
		self.assertEqual(self.page.evaluate('gv.objects.nodes.size'), 4)
		self.assertEqual(self.page.evaluate('gv.objects.frames.size'), 1)
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_drag_resize_pan_and_zoom(self):
		self.page.evaluate("window.before = {...gv.objects.nodes.get('0').visual.node.center}")
		box = self.page.locator('#nodes [data-id="0"] .shape').bounding_box()
		x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
		self.page.mouse.move(x, y)
		self.page.mouse.down()
		self.page.mouse.move(x - 55, y + 55, steps=6)
		self.page.mouse.up()
		self.page.wait_for_function("() => gv.documentRevision === '2'")
		self.assertTrue(self.page.evaluate("gv.objects.nodes.get('0').visual.node.center.y !== before.y"))
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.documentRevision === '3'")
		self.assertTrue(self.page.evaluate("JSON.stringify(gv.objects.nodes.get('0').visual.node.center) === JSON.stringify(before)"))
		self.page.locator('#redo').click()
		self.page.wait_for_function("() => gv.documentRevision === '4'")
		completed = self.page.evaluate("gv.interactionMetrics.uiRoundTrips.filter(item => item.action === 'gesture_end').length")
		self.page.locator('#nodes [data-id="0"] .shape').click()
		self.page.wait_for_function("count => gv.interactionMetrics.uiRoundTrips.filter(item => item.action === 'gesture_end').length > count", arg=completed)
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.selected")
		self.page.evaluate("window.oldSize = {...gv.objects.nodes.get('0').visual.node.size}")
		handle = self.page.locator('#nodes [data-id="0"] .resize').bounding_box()
		x, y = handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2
		self.page.mouse.move(x, y)
		self.page.mouse.down()
		self.page.mouse.move(x + 30, y + 30, steps=4)
		self.page.mouse.up()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.size.width !== oldSize.width")
		self.page.wait_for_function("count => gv.interactionMetrics.uiRoundTrips.filter(item => item.action === 'gesture_end').length > count + 1", arg=completed)
		self.page.locator('#graph').scroll_into_view_if_needed()
		self.page.evaluate('window.oldCamera = {...gv.camera}')
		canvas = self.page.locator('#graph').bounding_box()
		self.page.mouse.move(canvas['x'] + 40, canvas['y'] + canvas['height'] - 30)
		self.page.mouse.down()
		self.page.mouse.move(canvas['x'] + 90, canvas['y'] + canvas['height'] - 60)
		self.page.mouse.up()
		self.page.wait_for_function('() => gv.camera.x !== oldCamera.x')
		self.page.mouse.wheel(0, 180)
		self.page.wait_for_function('() => gv.camera.zoom !== oldCamera.zoom')
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_incremental_add_theme_group_and_output(self):
		self.page.evaluate("window.savedNode = gv.objects.nodes.get('0').group; window.savedEdge = gv.objects.edges.get('1').group")
		self.page.locator('#update-data').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('2').visual.node.label === '수신 1'")
		self.assertTrue(self.page.evaluate("savedNode === gv.objects.nodes.get('0').group && savedEdge === gv.objects.edges.get('1').group"))
		self.page.locator('#add-node').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('1000') && gv.objects.edges.has('1000')")
		self.page.locator('#frames [data-id="10"] .disclosure').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('10') && !gv.objects.nodes.has('2')")
		self.page.locator('#nodes [data-id="10"] .disclosure').click()
		self.page.wait_for_function("() => gv.objects.frames.has('10') && gv.objects.nodes.has('2')")
		self.page.locator('#theme').click()
		for control, filename in [('export-graph', 'graph.json'), ('export-image', 'graph.png')]:
			self.page.locator('#export-toggle').click()
			with self.page.expect_download() as exported:
				self.page.locator('#' + control).click()

			download = exported.value
			self.assertEqual(download.suggested_filename, filename)
			content = download.path().read_bytes()
			if filename.endswith('.json'):
				data = json.loads(content)
				self.assertEqual(data['format'], 'graph-visualizer')
				self.assertTrue(any(node['id'] == '18446744073709551615' for node in data['document']['nodes']))
				self.assertTrue(any(edge['target'] == '18446744073709551615' for edge in data['document']['edges']))
			else:
				self.assertEqual(content[:8], b'\x89PNG\r\n\x1a\n')

		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_samples_routing_and_mobile(self):
		for sample in ['routing', 'stream']:
			self.page.locator('#sample').select_option(sample)
			self.page.wait_for_function('() => window.gv?.ready')
			self.assertEqual(self.page.locator('#sample').input_value(), sample)
			self.assertGreater(self.page.evaluate('gv.objects.edges.size'), 0)

		for routing in ['0', '1', '2', '3']:
			self.page.locator('#routing').select_option(routing)
			self.page.wait_for_function('routing => [...gv.objects.edges.values()].every(edge => edge.visual.style.routing === routing)', arg=int(routing))

		self.page.set_viewport_size({'width': 390, 'height': 844})
		self.page.evaluate('gv.fit()')
		self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 390)
		self.assertTrue(self.page.locator('#graph').is_visible())
		zoom = self.page.evaluate('gv.camera.zoom')
		self.page.locator('#zoom-in').click()
		self.assertGreater(self.page.evaluate('gv.camera.zoom'), zoom)
		self.page.locator('#zoom-out').click()
		(ROOT / 'test-results').mkdir(exist_ok=True)
		self.page.screenshot(path=str(ROOT / 'test-results/mobile.png'), full_page=True)


if __name__ == '__main__':
	unittest.main(verbosity=2)
