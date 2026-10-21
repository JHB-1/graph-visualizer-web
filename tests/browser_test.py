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
		self.page.wait_for_function("() => document.querySelector('#engine-state').textContent.includes('브라우저 실행')")

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
		self.page.locator('#tab-file').click()
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
			self.page.locator('#tab-file').click()
			self.page.locator('#sample').select_option(sample)
			self.page.wait_for_function('() => window.gv?.ready')
			self.page.wait_for_function("() => document.querySelector('#engine-state').textContent.includes('브라우저 실행')")
			self.assertEqual(self.page.locator('#sample').input_value(), sample)
			self.assertGreater(self.page.evaluate('gv.objects.edges.size'), 0)

		self.page.locator('#tab-routing').click()
		for routing in ['0', '1', '2', '3']:
			self.page.locator('#routing').select_option(routing)
			self.page.wait_for_function('routing => [...gv.objects.edges.values()].every(edge => edge.visual.style.routing === routing)', arg=int(routing))

		self.page.set_viewport_size({'width': 390, 'height': 844})
		self.page.locator('#sidebar-close').click()
		self.page.evaluate('gv.fit()')
		self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 390)
		self.assertTrue(self.page.locator('#graph').is_visible())
		zoom = self.page.evaluate('gv.camera.zoom')
		self.page.locator('#zoom-in').click()
		self.assertGreater(self.page.evaluate('gv.camera.zoom'), zoom)
		self.page.locator('#zoom-out').click()
		(ROOT / 'test-results').mkdir(exist_ok=True)
		self.page.screenshot(path=str(ROOT / 'test-results/mobile.png'), full_page=True)

	def state(self):
		return self.page.evaluate("async () => (await graphTransport.exchange({op:'web_read'})).result.web")

	def test_fullscreen_sidebar_tabs(self):
		box = self.page.locator('#graph').bounding_box()
		self.assertEqual(box['y'], 0)
		self.assertEqual(box['height'], 1050)
		self.assertEqual(box['x'] + box['width'], 1440)
		for tab in ['theme', 'routing', 'analysis', 'file', 'edit']:
			self.page.locator('#tab-' + tab).click()
			self.assertTrue(self.page.locator('#panel-' + tab).is_visible())
			self.assertEqual(self.page.locator('[role="tabpanel"]:visible').count(), 1)

		self.page.locator('#sidebar-close').click()
		self.assertGreater(self.page.locator('#graph').bounding_box()['width'], box['width'])
		self.page.locator('#sidebar-open').click()
		self.assertTrue(self.page.locator('#sidebar').is_visible())
		self.page.locator('#tab-edit').focus()
		self.page.keyboard.press('ArrowDown')
		self.assertEqual(self.page.locator('#tab-theme').get_attribute('aria-selected'), 'true')

	def test_core_theme_rgba_history_and_codec(self):
		original = self.state()['theme_text']
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		self.page.locator('#theme-form [data-field="node.fill.a"]').fill('0')
		self.page.locator('#theme-form [data-field="node.borderWidth"]').fill('0')
		self.page.locator('#theme-form [data-field="node.fontBold"]').check()
		self.page.locator('#theme-form button[type="submit"]').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 0")
		self.assertEqual(self.state()['defaults']['node']['borderWidth'], 0)
		self.assertTrue(self.state()['defaults']['node']['fontBold'])
		with self.page.expect_download() as exported:
			self.page.locator('#theme-export').click()

		theme = exported.value.path().read_text(encoding='utf-8')
		self.assertTrue(theme.startswith('GV_THEME 1'))
		self.assertIn('node.fill=', theme)
		self.page.locator('#theme-text').fill(original)
		self.page.locator('#theme-apply').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 255")
		self.page.locator('#theme-text').fill(theme)
		self.page.locator('#theme-apply').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 0")
		self.page.locator('#tab-edit').click()
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 255")
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_selection_styles_edges_and_clipboard(self):
		self.page.locator('#object-picker').select_option('node:0')
		self.page.locator('#selection-form [data-field="label"]').fill('수정한 노드')
		self.page.locator('#selection-form').get_by_text('개별 스타일', exact=True).click()
		self.page.locator('#selection-form [data-inherit="style.fill"]').uncheck()
		self.page.locator('#selection-form [data-field="style.fill.a"]').fill('0')
		self.page.locator('#selection-form button[type="submit"]').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.label === '수정한 노드'")
		self.assertEqual(self.state()['nodes'][0]['style']['fill']['a'], 0)
		self.page.locator('#selection-form [data-inherit="style.fill"]').check()
		self.page.locator('#selection-form button[type="submit"]').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.style.fill === null")
		before = len(self.state()['nodes'])
		self.page.locator('[data-command="copy"]').click()
		self.page.locator('[data-command="paste"]').click()
		self.page.wait_for_function('count => gv.objects.nodes.size + gv.objects.frames.size === count + 1', arg=before)
		self.page.locator('#object-picker').select_option('edge:0')
		self.page.locator('#selection-form [data-inherit="weight"]').uncheck()
		self.page.locator('#selection-form [data-field="weight"]').fill('0')
		self.page.locator('#selection-form button[type="submit"]').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.edges[0].weight === 0")
		self.page.locator('#reverse-edge').click()
		self.page.wait_for_function("() => gv.objects.edges.get('0').visual.actualTarget === '0'")
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_analysis_and_advanced_options(self):
		self.page.locator('#tab-routing').click()
		self.page.locator('#options-form [data-field="parallelWiring"]').check()
		self.page.locator('#options-form [data-field="parallelSpacing"]').fill('28')
		self.page.locator('#options-form button[type="submit"]').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.options.parallelSpacing === 28")
		self.page.locator('#show-grid').uncheck()
		self.assertEqual(self.page.locator('#grid-area').get_attribute('visibility'), 'hidden')
		self.page.locator('#tab-analysis').click()
		self.page.locator('#algorithm-start').select_option('0')
		self.page.locator('#algorithm-target').select_option('18446744073709551615')
		self.page.locator('#algorithm-kind').select_option('2')
		self.page.locator('#algorithm-form button').click()
		self.page.wait_for_function("() => !document.querySelector('#algorithm-step').disabled")
		self.page.locator('#algorithm-step').fill('1')
		self.page.locator('#algorithm-step').dispatch_event('change')
		self.page.wait_for_function("() => [...gv.objects.nodes.values()].some(item => item.visual.highlighted)")
		self.assertNotEqual(self.page.locator('#algorithm-description').inner_text(), '')
		self.page.locator('[data-command="algorithm_clear"]').click()
		self.page.wait_for_function("() => [...gv.objects.nodes.values()].every(item => !item.visual.highlighted)")
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_connect_group_font_and_invalid_theme(self):
		self.page.locator('#connect-form').locator('..').locator('summary').click()
		self.page.locator('#connect-source').select_option('0')
		self.page.locator('#connect-target').select_option('2')
		self.page.locator('#connect-label').fill('추가 연결')
		self.page.locator('#connect-form button').click()
		self.page.wait_for_function("() => [...gv.objects.edges.values()].some(edge => edge.visual.text === '추가 연결')")
		self.page.locator('#object-picker').select_option('node:0')
		self.page.locator('[data-command="duplicate"]').click()
		self.page.wait_for_function('() => gv.objects.nodes.size === 5')
		self.page.locator('#nodes [data-id="0"] .shape').click(modifiers=['Shift'])
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.selected_nodes.length === 2")
		self.page.locator('[data-command="group"]').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.nodes.filter(node => node.subgraph).length === 2")
		self.page.locator('#expand').click()
		self.page.wait_for_function('() => gv.objects.frames.size === 2')
		self.page.locator('#ungroup').click()
		self.page.wait_for_function('() => gv.objects.frames.size === 1')
		self.page.locator('#tab-theme').click()
		self.page.locator('#font-form [data-field="fallbackFamily"]').fill('monospace')
		self.page.locator('#font-form [data-field="missing"]').select_option('1')
		self.page.locator('#font-form button').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.fonts.fallbackFamily === 'monospace'")
		before = self.state()
		self.page.locator('#theme-text').fill('GV_THEME 999\n')
		self.page.locator('#theme-apply').click()
		self.page.wait_for_function("() => document.querySelector('#error').textContent.length > 0")
		self.assertEqual(self.state()['canvas'], before['canvas'])
		self.page.locator('#theme-text').fill(before['theme_text'])
		self.page.locator('#theme-apply').click()
		self.page.wait_for_function("() => document.querySelector('#error').textContent === ''")
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_empty_graph_add_and_theme_sizes(self):
		self.page.locator('#tab-file').click()
		self.page.locator('#batch-text').fill(json.dumps({'removed_nodes': [node['id'] for node in self.state()['nodes']]}))
		self.page.locator('#batch-apply').click()
		self.page.wait_for_function('() => gv.objects.nodes.size === 0 && gv.objects.frames.size === 0')
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('기본 노드 크기', exact=True).click()
		self.page.locator('#theme-form [data-field="nodeSize.width"]').fill('120')
		self.page.locator('#theme-form [data-field="nodeSize.height"]').fill('120')
		self.page.locator('#theme-form button[type="submit"]').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.defaults.nodeSize.width === 120")
		self.page.locator('#tab-edit').click()
		self.page.locator('#add-node').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('1000')")
		self.assertEqual(self.page.evaluate("gv.objects.nodes.get('1000').visual.node.size.width"), 120)
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_named_profile_inheritance_and_settings(self):
		self.page.locator('#tab-theme').click()
		profiles = [{'id': 'signal', 'name': '신호', 'style': {'fill': {'r': 220, 'g': 40, 'b': 60, 'a': 255}}}]
		self.page.locator('#theme-form [data-field="nodeProfiles"]').fill(json.dumps(profiles))
		self.page.locator('#theme-form button[type="submit"]').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.defaults.nodeProfiles.length === 1")
		self.page.locator('#tab-edit').click()
		self.page.locator('#object-picker').select_option('node:0')
		self.page.locator('#selection-form [data-inherit="profile"]').uncheck()
		self.page.locator('#selection-form [data-field="profile"]').fill('signal')
		self.page.locator('#selection-form button[type="submit"]').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.r === 220")
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('캔버스', exact=True).click()
		self.page.locator('#theme-form [data-field="canvas.background"]').fill('#f5f7fb')
		self.page.locator('#theme-form button[type="submit"]').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.canvas.background.r === 245")
		self.assertEqual(self.state()['defaults']['nodeProfiles'][0]['id'], 'signal')
		self.assertEqual(self.page.evaluate("gv.objects.nodes.get('0').visual.style.fill.r"), 220)
		self.assertEqual(self.page.locator('#error').inner_text(), '')
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_renderer_brightness_does_not_edit_core_document(self):
		before = self.state()
		revision = self.page.evaluate('gv.documentRevision')
		appearance = self.page.locator('html').get_attribute('data-theme')
		background = self.page.locator('#graph').evaluate('(element) => getComputedStyle(element).backgroundColor')
		document = self.page.evaluate("async () => (await graphTransport.request('export')).file.document")
		self.page.locator('#theme').click()
		self.assertNotEqual(self.page.locator('html').get_attribute('data-theme'), appearance)
		self.assertEqual(self.page.locator('#graph').evaluate('(element) => getComputedStyle(element).backgroundColor'), background)
		self.assertEqual(self.page.evaluate('gv.documentRevision'), revision)
		for key in ['defaults', 'canvas', 'nodes', 'edges', 'fonts', 'undo_count']:
			self.assertEqual(self.state()[key], before[key])

		self.assertEqual(self.page.evaluate("async () => (await graphTransport.request('export')).file.document"), document)
		self.page.locator('#tab-theme').click()
		self.assertEqual(self.page.locator('#panel-theme h1').inner_text(), '스타일')
		self.assertEqual(self.page.locator('[id^="preset-"]').count(), 0)


if __name__ == '__main__':
	unittest.main(verbosity=2)
