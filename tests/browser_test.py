from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import base64
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
		cls.browser = cls.playwright.chromium.launch(executable_path=os.environ.get('GV_CHROMIUM'), headless=True)

	@classmethod
	def tearDownClass(cls):
		cls.browser.close()
		cls.playwright.stop()
		cls.http.shutdown()
		cls.http.server_close()

	def setUp(self):
		self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1050})
		self.page = self.context.new_page()
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
		self.context.close()
		self.assertEqual(self.errors, [])

	def test_wasm_and_no_backend(self):
		self.assertIn('브라우저 실행', self.page.locator('#engine-state').inner_text())
		self.assertTrue(any(url.endswith('.wasm') for url in self.requests))
		self.assertTrue(all(url.startswith(self.origin) for url in self.requests), self.requests)
		self.assertFalse(any('/api' in url or '/mcp' in url for url in self.requests))
		self.assertEqual(self.page.evaluate('gv.objects.nodes.size'), 4)
		self.assertEqual(self.page.evaluate('gv.objects.frames.size'), 1)
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_shared_shell_and_pretendard_font(self):
		self.assertTrue(self.page.evaluate('document.fonts.check(\'400 14px "Pretendard Variable"\', "그래프 Graph")'))
		families = self.page.evaluate('''() => ['body', '#tab-edit', '#nodes text'].map
			(selector => getComputedStyle(document.querySelector(selector)).fontFamily)''')
		self.assertTrue(all('Pretendard Variable' in family for family in families), families)
		self.assertTrue(any(url.endswith('/fonts/PretendardVariable.woff2') for url in self.requests))
		self.assertEqual(self.page.locator('[role=tab][aria-selected=true]').evaluate
			('(e) => getComputedStyle(e).color'), 'rgb(146, 173, 255)')
		self.assertEqual(self.page.locator('.tab-rail').bounding_box()['width'], 56)
		self.assertEqual(self.page.locator('.sidebar').bounding_box()['width'], 300)
		document = self.page.evaluate("async () => (await graphTransport.request('export')).file.document")
		self.page.locator('#theme').click()
		self.page.wait_for_function('''() => getComputedStyle
			(document.querySelector('[role=tab][aria-selected=true]')).color === 'rgb(82, 120, 220)' ''')
		self.page.set_viewport_size({'width': 390, 'height': 844})
		self.assertEqual(self.page.locator('.tab-rail').bounding_box()['width'], 48)
		self.assertEqual(self.page.locator('.sidebar').bounding_box()['x'], 48)
		self.assertEqual(self.page.locator('#graph').bounding_box()['width'], 342)
		self.assertEqual(self.page.evaluate("async () => (await graphTransport.request('export')).file.document"), document)
		self.page.set_viewport_size({'width': 1440, 'height': 1050})
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		self.page.locator('#theme-form [data-field="node.fontFamily"]').fill('Consolas')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fontFamily === 'Consolas'")
		self.assertEqual(self.page.locator('#nodes [data-id="0"] text').get_attribute('font-family'), 'Consolas')

	def test_png_embeds_and_renders_pretendard(self):
		self.page.evaluate('''() =>
		{
			const original = URL.createObjectURL;
			URL.createObjectURL = function(blob)
			{
				if (blob.type.startsWith('image/svg+xml')) window.exportSVG = blob;
				return original.call(this, blob);
			};
		}''')
		self.page.locator('#tab-file').click()
		self.page.locator('#export-toggle').click()
		with self.page.expect_download() as exported:
			self.page.locator('#export-image').click()

		self.assertEqual(exported.value.path().read_bytes()[:8], b'\x89PNG\r\n\x1a\n')
		result = self.page.evaluate('''async () =>
		{
			const source = await window.exportSVG.text();
			const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
			const font = xml.querySelector('style');
			const embedded = font.textContent.includes('base64,') && font.textContent.includes('Pretendard Variable');
			font.remove();
			async function pixels(text)
			{
				const url = URL.createObjectURL(new Blob([text], {type:'image/svg+xml'}));
				try
				{
					const image = new Image();
					image.src = url;
					await image.decode();
					const canvas = document.createElement('canvas');
					canvas.width = image.width; canvas.height = image.height;
					const context = canvas.getContext('2d');
					context.drawImage(image, 0, 0);
					return context.getImageData(0, 0, canvas.width, canvas.height).data;
				}
				finally {URL.revokeObjectURL(url);}
			}
			const [withFont, withoutFont] = await Promise.all
			([pixels(source), pixels(new XMLSerializer().serializeToString(xml))]);
			let changed = 0;
			for (let index = 0; index < withFont.length; index++)
				if (withFont[index] !== withoutFont[index]) changed++;
			return {embedded, changed};
		}''')
		self.assertTrue(result['embedded'])
		self.assertGreater(result['changed'], 100)

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

	def test_zoom_percent_input_preserves_document_and_center(self):
		before = self.page.evaluate('({revision:gv.documentRevision,camera:{...gv.camera}})')
		field = self.page.locator('#zoom-level')
		field.fill('125%')
		field.press('Enter')
		self.page.wait_for_function('() => gv.camera.zoom === 1.25')
		self.assertEqual(field.input_value(), '125%')
		self.assertEqual(self.page.evaluate('gv.documentRevision'), before['revision'])
		field.fill('10')
		field.press('Escape')
		self.assertEqual(self.page.evaluate('gv.camera.zoom'), 1.25)
		field.fill('0')
		field.press('Enter')
		self.assertEqual(self.page.evaluate('gv.camera.zoom'), 1.25)
		self.assertEqual(field.get_attribute('aria-invalid'), 'true')
		field.fill('200')
		field.press('Enter')
		self.assertEqual(self.page.evaluate('gv.camera.zoom'), 2)
		self.assertEqual(self.page.locator('#error').inner_text(), '')

	def test_node_multiline_wrap_clip_and_export(self):
		self.page.locator('#tab-file').click()
		self.page.locator('#batch-text').fill(json.dumps({'updated_nodes': [{'id': '0',
			'label': '중앙 CI 조정기\nOS + 기능 + 가용 슬롯 선택', 'size': {'width': 160, 'height': 85}, 'shape': 1}]}))
		self.page.locator('#batch-apply').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.label.includes('가용')")
		result = self.page.evaluate('''() =>
		{
			const group=gv.objects.nodes.get('0').group;
			const text=group.querySelector('text');
			const clip=group.querySelector('clipPath rect').getBBox();
			return {lines:text.children.length,widths:[...text.children].map(line=>line.getComputedTextLength()),
				clipWidth:clip.width,clipped:text.getAttribute('clip-path'),title:group.querySelector('title').textContent};
		}''')
		self.assertGreaterEqual(result['lines'], 2)
		self.assertTrue(all(width <= result['clipWidth'] + 0.5 for width in result['widths']))
		self.assertTrue(result['clipped'].startswith('url(#gv-text-'))
		self.assertIn('가용 슬롯', result['title'])
		self.page.locator('#export-toggle').click()
		with self.page.expect_download() as exported:
			self.page.locator('#export-svg').click()

		self.assertIn(b'clipPath', exported.value.path().read_bytes())

	def test_edge_label_identity_leader_and_manual_preview(self):
		self.page.locator('#tab-file').click()
		self.page.locator('#batch-text').fill(json.dumps({'updated_edges': [{'id': '1', 'label': '설명',
			'label_position': {'x': -180, 'y': -190}}]}))
		self.page.locator('#batch-apply').click()
		self.page.wait_for_function("() => gv.objects.edges.get('1').visual.labelStatus === 2")
		label = self.page.locator('#edge-labels [data-id="1"]')
		self.assertEqual(label.get_attribute('data-owner-edge'), '1')
		self.assertIn('→', label.locator('title').text_content())
		self.assertEqual(self.page.locator('#edges [data-id="1"] .label-leader').get_attribute('display'), 'inline')
		label.hover()
		self.assertIn('label-related', self.page.locator('#edges [data-id="1"]').get_attribute('class'))
		before = self.page.evaluate("({...gv.objects.edges.get('1').visual.labelAnchor})")
		self.page.evaluate('''() =>
		{
			const request=graphTransport.request.bind(graphTransport);
			graphTransport.request=async (op,fields)=>
			{
				if(op==='ui') await new Promise(resolve=>setTimeout(resolve,250));
				return request(op,fields);
			};
		}''')
		box = self.page.locator('#nodes [data-id="9007199254740993"] .shape').bounding_box()
		x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
		self.page.mouse.move(x, y)
		self.page.mouse.down()
		self.page.mouse.move(x - 35, y + 20, steps=4)
		self.page.evaluate('() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
		position = label.locator('text').evaluate('(text)=>({x:Number(text.getAttribute("x")),y:Number(text.getAttribute("y"))})')
		self.assertEqual(position, before)
		self.page.mouse.up()

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
			self.page.wait_for_url('**/?sample=' + sample)
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

	def document_file(self):
		return self.page.evaluate("async () => (await graphTransport.request('export')).file")

	def open_document(self, value, filename='opened.json'):
		payload = { 'name': filename, 'mimeType': 'application/json', 'buffer': json.dumps(value, ensure_ascii=False).encode('utf-8') }
		self.page.locator('#document-open').set_input_files(payload)

	def drafts(self, page=None):
		return (page or self.page).evaluate('''() => new Promise((resolve,reject) =>
		{
			const request = indexedDB.open('gv-web-workspace',1);
			request.onerror = () => reject(request.error);
			request.onsuccess = () =>
			{
				const database = request.result;
				const transaction = database.transaction('drafts','readonly');
				const result = transaction.objectStore('drafts').getAll();
				transaction.oncomplete = () => {database.close();resolve(result.result);};
			};
		})''')

	def test_document_open_roundtrip_and_invalid_preserves_original(self):
		file = self.document_file()
		file['document']['defaults']['node']['fill']['a'] = 0
		file['document']['nodes'][0]['label'] = '열기 검증'
		self.page.locator('#tab-file').click()
		self.open_document(file)
		self.page.wait_for_function("() => gv.objects.nodes.get('0')?.visual.node.label === '열기 검증'")
		self.assertEqual(self.document_file()['document'], file['document'])
		self.assertEqual(self.state()['undo_count'], 0)
		self.assertEqual(self.page.locator('#document-name').inner_text(), 'opened.json')
		self.assertEqual(self.page.locator('#document-state').inner_text(), '미저장 변경 없음')
		before = self.document_file()['document']
		invalid = json.loads(json.dumps(file))
		invalid['document']['edges'][0]['target'] = '999999'
		self.open_document(invalid, 'invalid.json')
		self.page.wait_for_function("() => document.querySelector('#error').textContent.length > 0")
		self.assertEqual(self.document_file()['document'], before)
		self.assertEqual(self.page.locator('#document-name').inner_text(), 'opened.json')
		payload = { 'name': 'big.json', 'mimeType': 'application/json', 'buffer': b' ' * 1_048_577 }
		self.page.locator('#document-open').set_input_files(payload)
		self.page.wait_for_function("() => document.querySelector('#error').textContent.includes('1 MiB')")
		self.assertEqual(self.document_file()['document'], before)
		self.page.locator('#document-new').click()
		self.page.wait_for_function('() => gv.objects.nodes.size === 0 && gv.objects.edges.size === 0')
		self.page.locator('#tab-edit').click()
		self.page.locator('#add-node').click()
		self.page.wait_for_function('() => gv.objects.nodes.size === 1')
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_autosave_recovery_off_and_undo_grouping(self):
		self.page.locator('#add-node').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('1000')")
		self.page.wait_for_function("() => document.querySelector('#autosave-state').textContent === '브라우저에 저장됨'")
		self.assertIn('1000', [node['id'] for node in self.drafts()[0]['file']['document']['nodes']])
		self.page.once('dialog', lambda dialog: dialog.accept())
		self.page.reload()
		self.page.wait_for_function("() => document.querySelector('#engine-state').textContent.includes('브라우저 실행')")
		self.assertTrue(self.page.locator('#recovery-prompt').is_visible())
		self.assertFalse(self.page.evaluate("gv.objects.nodes.has('1000')"))
		self.assertIn('1000', [node['id'] for node in self.drafts()[0]['file']['document']['nodes']])
		self.page.locator('#recovery-restore').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('1000')")
		self.assertEqual(self.page.locator('#document-state').inner_text(), '미저장 변경')
		self.page.locator('#autosave').uncheck()
		self.page.wait_for_function("() => document.querySelector('#autosave-state').textContent === '자동 저장 꺼짐'")
		self.assertEqual(self.drafts(), [])
		self.assertTrue(self.page.evaluate("gv.objects.nodes.has('1000')"))
		self.page.locator('#autosave').check()
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		field = self.page.locator('#theme-form [data-field="node.fontSize"]')
		self.page.evaluate("window.undoBefore=(async ()=>(await graphTransport.exchange({op:'web_read'})).result.web.undo_count)()")
		for value in [17, 18, 19, 20]:
			field.fill(str(value))
			self.page.wait_for_timeout(160)

		self.page.locator('#tab-edit').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.undo_count === await undoBefore + 1")

	def test_draft_tabs_are_isolated_and_storage_failure_is_nonfatal(self):
		self.page.locator('#add-node').click()
		self.page.wait_for_function("() => document.querySelector('#autosave-state').textContent === '브라우저에 저장됨'")
		first_id = self.page.evaluate("sessionStorage.getItem('gv-draft-id')")
		other = self.page.context.new_page()
		try:
			other.add_init_script("sessionStorage.setItem('gv-draft-id'," + json.dumps(first_id) + ")")
			other.goto(self.origin)
			other.wait_for_function("() => document.querySelector('#engine-state').textContent.includes('브라우저 실행')")
			self.assertNotEqual(other.evaluate("sessionStorage.getItem('gv-draft-id')"), first_id)
			self.assertTrue(other.locator('#recovery-prompt').is_visible())
			other.locator('#recovery-discard').click()
			self.assertEqual(len(self.drafts()), 1)
			other.locator('#tab-edit').click()
			other.locator('#add-node').click()
			other.wait_for_function("() => document.querySelector('#autosave-state').textContent === '브라우저에 저장됨'")
			self.assertEqual(len(self.drafts()), 2)
			self.page.locator('#tab-file').click()
			self.page.locator('#autosave').uncheck()
			self.page.wait_for_function("() => document.querySelector('#autosave-state').textContent === '자동 저장 꺼짐'")
			self.assertEqual(len(self.drafts()), 1)
			self.assertNotEqual(self.drafts()[0]['id'], first_id)
		finally:
			other.close()

		self.page.add_init_script("sessionStorage.setItem('gv-autosave','on');indexedDB.open=()=>{throw new DOMException('denied','SecurityError')}")
		self.page.once('dialog', lambda dialog: dialog.accept())
		self.page.reload()
		self.page.wait_for_function("() => document.querySelector('#engine-state').textContent.includes('브라우저 실행')")
		self.assertIn('사용할 수 없습니다', self.page.locator('#autosave-state').inner_text())
		self.page.locator('#tab-edit').click()
		self.page.locator('#add-node').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('1000')")

	def test_item_search_hidden_scope_and_navigation_do_not_edit_document(self):
		self.page.locator('#frames [data-id="10"] .disclosure').click()
		self.page.wait_for_function("() => !gv.objects.nodes.has('2')")
		before = self.document_file()['document']
		self.page.locator('#tab-items').click()
		self.page.locator('#item-search').fill('입력 검증')
		self.assertEqual(self.page.locator('#item-list .item-row').count(), 1)
		self.page.evaluate("window.itemButton=document.querySelector('#item-list .item-row button')")
		self.page.locator('#item-list .item-row button').first.focus()
		self.page.keyboard.press('Space')
		self.page.wait_for_function("() => itemButton.getAttribute('aria-pressed')==='true'")
		self.assertTrue(self.page.evaluate("itemButton===document.querySelector('#item-list .item-row button')"))
		self.assertTrue(self.page.evaluate('itemButton===document.activeElement'))
		self.page.locator('#item-list .item-row button').last.click()
		self.page.wait_for_function("() => gv.objects.nodes.has('9007199254740993') && gv.objects.nodes.get('9007199254740993').visual.selected")
		self.assertEqual(self.document_file()['document'], before)
		self.assertIn('처리 파이프라인', self.page.locator('#scope-path').inner_text())
		self.page.locator('#bookmark-name').fill('검증 위치')
		self.page.locator('#bookmark-add').click()
		self.page.wait_for_function("() => document.querySelector('#bookmark-list').textContent.includes('검증 위치')")
		self.page.locator('#view-back').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('10') && !gv.objects.nodes.has('2')")
		self.page.locator('#bookmark-list button').first.click()
		self.page.wait_for_function("() => gv.objects.nodes.has('9007199254740993')")
		self.assertEqual(self.document_file()['document'], before)

	def test_direct_connection_reconnect_and_label_drag_undo(self):
		before = self.state()
		source = self.page.locator('#nodes [data-id="0"] .shape')
		source.hover()
		handle = self.page.locator('#nodes [data-id="0"] .connect-handle').bounding_box()
		target = self.page.locator('#nodes [data-id="2"] .shape').bounding_box()
		self.page.mouse.move(handle['x'] + handle['width']/2, handle['y'] + handle['height']/2)
		self.page.mouse.down()
		self.page.mouse.move(target['x'] + target['width']/2, target['y'] + target['height']/2, steps=8)
		self.page.mouse.up()
		self.page.wait_for_function('count => gv.objects.edges.size === count + 1', arg=len(before['edges']))
		self.assertEqual(self.state()['undo_count'], before['undo_count'] + 1)
		self.page.locator('#undo').click()
		self.page.wait_for_function('count => gv.objects.edges.size === count', arg=len(before['edges']))
		self.page.locator('#object-picker').select_option('edge:1')
		self.page.wait_for_function("() => gv.objects.edges.get('1').visual.selected")
		target = self.page.locator('#nodes [data-id="18446744073709551615"] .shape').bounding_box()
		handle = self.page.locator('#direct-layer [data-id="1"] .endpoint-target').bounding_box()
		self.page.mouse.move(handle['x']+handle['width']/2, handle['y']+handle['height']/2)
		self.page.mouse.down()
		self.page.mouse.move(target['x']+target['width']/2, target['y']+target['height']/2, steps=6)
		self.page.mouse.up()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.edges.find(e=>e.id==='1').target === '18446744073709551615'")
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.objects.edges.get('1').visual.actualTarget === '2'")
		self.page.locator('#object-picker').select_option('edge:1')
		self.page.wait_for_function("() => gv.objects.edges.get('1').visual.selected")
		label = self.page.locator('#edge-labels [data-id="1"] .label-background').bounding_box()
		self.page.mouse.move(label['x']+label['width']/2, label['y']+label['height']/2)
		self.page.mouse.down()
		self.page.mouse.move(label['x']+label['width']/2+35, label['y']+label['height']/2-40, steps=6)
		self.page.mouse.up()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.edges.find(e=>e.id==='1').labelPosition !== null")
		self.page.locator('#undo').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.edges.find(e=>e.id==='1').labelPosition === null")
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_svg_png_options_and_keyboard(self):
		self.page.locator('#object-picker').select_option('node:0')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.selected")
		self.page.locator('#graph').focus()
		before = self.page.evaluate("gv.objects.nodes.get('0').visual.node.center.x")
		self.page.keyboard.press('ArrowRight')
		self.page.wait_for_function("x => gv.objects.nodes.get('0').visual.node.center.x > x", arg=before)
		self.page.keyboard.press('Control+z')
		self.page.wait_for_function("x => gv.objects.nodes.get('0').visual.node.center.x === x", arg=before)
		self.page.keyboard.press('Control+f')
		self.assertTrue(self.page.locator('#item-search').evaluate('(e)=>e===document.activeElement'))
		self.page.locator('#tab-file').click()
		self.page.get_by_text('이미지 출력 옵션', exact=True).click()
		self.page.locator('#export-area').select_option('selection')
		self.page.locator('#export-transparent').check()
		self.page.locator('#export-scale').select_option('2')
		self.page.locator('#export-toggle').click()
		with self.page.expect_download() as output:
			self.page.locator('#export-svg').click()

		svg = output.value.path().read_text(encoding='utf-8')
		self.assertIn('base64,', svg)
		self.assertIn('data-id="0"', svg)
		self.assertNotIn('data-id="2"', svg)
		self.assertNotIn('direct-handle', svg)
		self.page.locator('#export-toggle').click()
		with self.page.expect_download() as output:
			self.page.locator('#export-image').click()

		content = output.value.path().read_bytes()
		self.assertEqual(content[:8], b'\x89PNG\r\n\x1a\n')
		self.assertGreater(int.from_bytes(content[16:20], 'big'), 100)
		alpha = self.page.evaluate('''async data =>
		{
			const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
			const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
			const context=canvas.getContext('2d');context.drawImage(image,0,0);
			return context.getImageData(0,0,1,1).data[3];
		}''', base64.b64encode(content).decode())
		self.assertEqual(alpha,0)

	def test_nonfinite_deep_file_and_image_limits_are_rejected(self):
		file = self.document_file()
		before = file['document']
		file['document']['nodes'][0]['style']['fontSize'] = 123456789
		text = json.dumps(file).replace('123456789','1e999')
		payload = {'name':'nonfinite.json','mimeType':'application/json','buffer':text.encode()}
		self.page.locator('#document-open').set_input_files(payload)
		self.page.wait_for_function("() => document.querySelector('#error').textContent.includes('유한')")
		self.assertNotEqual(self.document_file()['document']['nodes'][0]['style']['fontSize'],123456789)
		text = json.dumps(self.document_file())[:-1] + ',"extra":' + '['*130 + '0' + ']'*130 + '}'
		payload = {'name':'deep.json','mimeType':'application/json','buffer':text.encode()}
		self.page.locator('#document-open').set_input_files(payload)
		self.page.wait_for_function("() => document.querySelector('#error').textContent.includes('중첩')")
		file = self.document_file()
		node = file['document']['nodes'][0]; node['center']={'x':0,'y':0}; node['size']={'width':9000,'height':72}
		file['document']['nodes']=[node];file['document']['edges']=[]
		self.open_document(file,'large-image.json')
		self.page.wait_for_function("() => gv.objects.nodes.size===1 && gv.objects.nodes.get('0').visual.node.size.width===9000")
		self.page.locator('#tab-file').click()
		self.page.locator('#export-toggle').click(); self.page.locator('#export-image').click()
		self.page.wait_for_function("() => document.querySelector('#error').textContent.includes('8192px')")
		self.assertTrue(self.page.evaluate('gv.ready'))
		self.assertEqual(self.document_file()['document']['nodes'][0]['size']['width'],9000)

	def test_dirty_replace_cancel_drop_and_quota_failure_preserves_document(self):
		file = self.document_file()
		self.page.locator('#add-node').click()
		self.page.wait_for_function("() => document.querySelector('#autosave-state').textContent === '브라우저에 저장됨'")
		self.page.locator('#tab-file').click()
		self.page.once('dialog', lambda dialog: dialog.dismiss())
		self.page.locator('#document-new').click()
		self.assertTrue(self.page.evaluate("gv.objects.nodes.has('1000')"))
		self.page.evaluate("() => {IDBObjectStore.prototype.put=()=>{throw new DOMException('quota','QuotaExceededError')}}")
		self.page.locator('#tab-edit').click()
		self.page.locator('#update-data').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('2').visual.node.label === '수신 1'")
		self.page.wait_for_function("() => document.querySelector('#autosave-state').textContent.includes('자동 저장 실패')")
		self.assertEqual(len(self.drafts()), 1)
		self.assertTrue(self.page.evaluate("gv.objects.nodes.has('1000')"))
		file['document']['nodes'][0]['label'] = '드롭으로 열기'
		self.page.once('dialog', lambda dialog: dialog.accept())
		self.page.evaluate('''file =>
		{
			const transfer = new DataTransfer();
			transfer.items.add(new File([JSON.stringify(file)],'dropped.json',{type:'application/json'}));
			document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
		}''', file)
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.label === '드롭으로 열기'")
		self.assertEqual(self.page.locator('#document-name').inner_text(), 'dropped.json')

	def test_concurrent_document_open_is_serialized(self):
		file = self.document_file()
		file['document']['nodes'][0]['label'] = '첫 문서'
		second = json.loads(json.dumps(file)); second['document']['nodes'][0]['label'] = '두 번째 문서'
		self.page.evaluate('''() =>
		{
			const exchange=graphTransport.exchange.bind(graphTransport);
			let delayed=false;
			graphTransport.exchange=async request=>
			{
				if(request.op==='web_validate'&&!delayed)
				{
					delayed=true;await new Promise(resolve=>setTimeout(resolve,150));
				}
				return exchange(request);
			};
		}''')
		self.open_document(file,'first.json')
		self.open_document(second,'second.json')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.label==='첫 문서'")
		self.assertFalse(self.page.locator('.app-shell').evaluate('(e)=>e.inert'))
		self.open_document(second,'second.json')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.label==='두 번째 문서'")
		self.assertEqual(self.page.locator('#document-name').inner_text(),'second.json')

	def test_waypoint_add_drag_cancel_delete_and_undo(self):
		self.page.locator('#object-picker').select_option('edge:0')
		self.page.wait_for_function("() => gv.objects.edges.get('0').visual.selected")
		point = self.page.locator('#edges [data-id="0"] .wire').evaluate('''path =>
		{
			const p=path.getPointAtLength(path.getTotalLength()*0.3), r=document.querySelector('#graph').getBoundingClientRect();
			return {clientX:r.left+gv.camera.x+p.x*gv.camera.zoom,clientY:r.top+gv.camera.y+p.y*gv.camera.zoom};
		}''')
		self.page.locator('#edges [data-id="0"] .wire').dispatch_event('dblclick', point)
		self.page.wait_for_function("() => gv.objects.edges.get('0').visual.waypoints.length === 1")
		before = self.state()['undo_count']
		old = self.page.evaluate("gv.objects.edges.get('0').visual.waypoints[0].y")
		handle = self.page.locator('#edges [data-id="0"] [data-waypoint-index="0"]').bounding_box()
		x, y = handle['x']+handle['width']/2, handle['y']+handle['height']/2
		self.page.mouse.move(x,y); self.page.mouse.down(); self.page.mouse.move(x,y-50,steps=6); self.page.mouse.up()
		self.page.wait_for_function("y => gv.objects.edges.get('0').visual.waypoints[0].y < y", arg=old)
		self.assertEqual(self.state()['undo_count'], before+1)
		before_file = self.document_file()['document']
		handle = self.page.locator('#edges [data-id="0"] [data-waypoint-index="0"]').bounding_box()
		x, y = handle['x']+handle['width']/2, handle['y']+handle['height']/2
		self.page.mouse.move(x,y); self.page.mouse.down(); self.page.mouse.move(x+30,y-20,steps=4)
		self.page.keyboard.press('Escape'); self.page.mouse.up()
		self.assertEqual(self.document_file()['document'], before_file)
		self.page.locator('#edges [data-id="0"] [data-waypoint-index="0"]').click(button='right')
		self.page.wait_for_function("() => gv.objects.edges.get('0').visual.waypoints.length === 0")
		self.page.locator('#tab-edit').click()
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.objects.edges.get('0').visual.waypoints.length === 1")

	def test_collapsed_connection_asks_for_actual_endpoint(self):
		self.page.locator('#frames [data-id="10"] .disclosure').click()
		self.page.wait_for_function("() => gv.objects.nodes.has('10')")
		before = len(self.state()['edges'])
		self.page.locator('#nodes [data-id="0"] .shape').hover()
		handle = self.page.locator('#nodes [data-id="0"] .connect-handle').bounding_box()
		target = self.page.locator('#nodes [data-id="10"] .shape').bounding_box()
		self.page.mouse.move(handle['x']+handle['width']/2,handle['y']+handle['height']/2)
		self.page.mouse.down()
		self.page.mouse.move(target['x']+target['width']/2,target['y']+target['height']/2,steps=6)
		self.page.mouse.up()
		dialog = self.page.get_by_role('dialog')
		dialog.wait_for()
		dialog.get_by_role('combobox', name='도착 노드').select_option('2')
		dialog.get_by_role('button', name='연결', exact=True).click()
		self.page.wait_for_function('''count => gv.objects.edges.size > 2 &&
			[...gv.objects.edges.values()].some(e=>e.visual.actualSource==='0' && e.visual.actualTarget==='2')''', arg=before)
		self.assertEqual(len(self.state()['edges']), before+1)
		edge = next(edge for edge in self.state()['edges'] if edge['source']=='0' and edge['target']=='2')
		self.assertEqual(self.page.evaluate("id=>gv.objects.edges.get(id).visual.target", edge['id']), '10')

	def test_pinch_and_diagnostics_preserve_document(self):
		file = self.document_file()
		before = file['document']
		zoom = self.page.evaluate('gv.camera.zoom')
		cdp = self.context.new_cdp_session(self.page)
		cdp.send('Emulation.setTouchEmulationEnabled', {'enabled': True, 'maxTouchPoints': 2})
		cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':700,'y':800},{'x':900,'y':800}]})
		cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':650,'y':800},{'x':950,'y':800}]})
		cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
		self.page.wait_for_function('zoom => gv.camera.zoom > zoom*1.2', arg=zoom)
		self.assertEqual(self.document_file()['document'], before)
		cdp.detach()
		first, last = before['nodes'][0], before['nodes'][-1]
		first['center'] = {'x':-100,'y':0}; first['size'] = {'width':50,'height':50}
		last['center'] = {'x':100,'y':0}; last['size'] = {'width':50,'height':50}
		wall = json.loads(json.dumps(first)); wall['id']='42'; wall['label']='장애물'
		wall['center']={'x':0,'y':0}; wall['size']={'width':1000,'height':1000}
		before['nodes']=[first,last,wall]
		edge = before['edges'][0]; edge['source']=first['id']; edge['target']=last['id']
		before['edges']=[edge]; before['options']['minimumNodeGap']=0
		self.open_document(file,'blocked.json')
		self.page.wait_for_function("() => gv.objects.nodes.has('42')")
		self.page.locator('#tab-analysis').click()
		self.page.locator('#diagnostic-list button').first.wait_for()
		self.assertIn('경로 없음',self.page.locator('#diagnostic-list').inner_text())
		self.page.locator('#diagnostic-list button').first.click()
		self.page.wait_for_function("() => gv.objects.edges.get('0').visual.selected")
		self.assertEqual(self.page.locator('#edges [data-id="0"] .wire').get_attribute('d'), '')

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
		self.page.keyboard.press('End')
		self.assertEqual(self.page.locator('#tab-file').get_attribute('aria-selected'), 'true')
		self.page.keyboard.press('Home')
		self.assertEqual(self.page.locator('#tab-edit').get_attribute('aria-selected'), 'true')

	def test_core_theme_rgba_history_and_codec(self):
		original = self.state()['theme_text']
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		self.page.locator('#theme-form [data-field="node.fill.a"]').fill('0')
		self.page.locator('#theme-form [data-field="node.borderWidth"]').fill('0')
		self.page.locator('#theme-form [data-field="node.fontBold"]').check()
		self.page.wait_for_function("() => {const style=gv.objects.nodes.get('0').visual.style; return style.fill.a === 0 && style.borderWidth === 0 && style.fontBold}")
		self.assertEqual(self.state()['defaults']['node']['borderWidth'], 0)
		self.assertTrue(self.state()['defaults']['node']['fontBold'])
		with self.page.expect_download() as exported:
			self.page.locator('#theme-export').click()

		theme = exported.value.path().read_text(encoding='utf-8')
		self.assertTrue(theme.startswith('GV_THEME 1'))
		self.assertIn('node.fill=', theme)
		self.page.locator('#theme-text').fill(original)
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 255")
		self.page.locator('#theme-export').focus()
		self.page.locator('#theme-text').fill(theme)
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 0")
		self.page.locator('#tab-edit').click()
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 255")
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_selection_styles_edges_and_clipboard(self):
		self.page.locator('#object-picker').select_option('node:0')
		self.page.get_by_text('기하와 연결 속성', exact=True).click()
		self.page.locator('#selection-form [data-field="label"]').fill('수정한 노드')
		self.page.locator('#selection-form button[type="submit"]').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.node.label === '수정한 노드'")
		self.page.locator('#selection-style-form').get_by_text('개별 스타일', exact=True).click()
		self.page.locator('#selection-style-form [data-inherit="style.fill"]').uncheck()
		self.page.locator('#selection-style-form [data-field="style.fill.a"]').fill('0')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.a === 0")
		self.assertEqual(self.state()['nodes'][0]['style']['fill']['a'], 0)
		self.page.locator('#selection-style-form [data-inherit="style.fill"]').check()
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
		self.page.wait_for_function("async () => {const fonts=(await graphTransport.exchange({op:'web_read'})).result.web.fonts;return fonts.fallbackFamily === 'monospace' && fonts.missing === 1}")
		before = self.state()
		self.page.locator('#theme-text').fill('GV_THEME 999\n')
		self.page.locator('#theme-text').press('Tab')
		self.page.wait_for_function("() => document.querySelector('#error').textContent.length > 0")
		self.assertEqual(self.state()['canvas'], before['canvas'])
		self.page.locator('#theme-text').fill(before['theme_text'])
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
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.defaults.nodeProfiles.length === 1")
		self.page.locator('#tab-edit').click()
		self.page.locator('#object-picker').select_option('node:0')
		self.page.locator('#selection-style-form [data-inherit="profile"]').uncheck()
		self.page.locator('#selection-style-form [data-field="profile"]').fill('signal')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fill.r === 220")
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('캔버스', exact=True).click()
		self.page.locator('#theme-form [data-field="canvas.background"]').fill('#f5f7fb')
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

	def test_live_style_focus_undo_and_input_queue(self):
		before = self.state()
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		field = self.page.locator('#theme-form [data-field="node.borderWidth"]')
		field.fill('2')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.borderWidth === 2")
		self.assertTrue(field.evaluate('(element) => element === document.activeElement'))
		field.fill('3')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.borderWidth === 3")
		field.fill('4')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.borderWidth === 4")
		self.assertEqual(self.page.locator('#theme-form button[type="submit"]').count(), 0)
		self.assertEqual(self.state()['undo_count'], before['undo_count'])
		self.page.locator('#tab-edit').click()
		self.page.wait_for_function("async () => (await graphTransport.exchange({op:'web_read'})).result.web.undo_count === 1")
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.borderWidth === 1.5")
		self.page.locator('#redo').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.borderWidth === 4")
		self.page.locator('#tab-theme').click()
		field.evaluate("element => {element.focus();for(let i=0;i<90;i++){element.value=String(i/10);element.dispatchEvent(new Event('input',{bubbles:true}))}}")
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.borderWidth === 8.9")
		self.assertTrue(field.evaluate('(element) => element === document.activeElement'))
		self.assertEqual(self.page.locator('#error').inner_text(), '')
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)

	def test_live_invalid_value_keeps_last_valid_style(self):
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		field = self.page.locator('#theme-form [data-field="node.fontSize"]')
		field.fill('20')
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fontSize === 20")
		field.fill('-1')
		self.page.locator('#tab-edit').click()
		self.page.wait_for_function("() => document.querySelector('#error').textContent.length > 0")
		self.assertEqual(self.page.evaluate("gv.objects.nodes.get('0').visual.style.fontSize"), 20)
		self.page.locator('#undo').click()
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fontSize === 14")

	def test_live_text_and_export_keep_latest_value(self):
		self.page.locator('#tab-theme').click()
		self.page.locator('#theme-form').get_by_text('노드', exact=True).click()
		field = self.page.locator('#theme-form [data-field="node.fontFamily"]')
		field.fill('')
		field.press_sequentially('Consolas', delay=12)
		self.page.wait_for_function("() => gv.objects.nodes.get('0').visual.style.fontFamily === 'Consolas'")
		self.assertTrue(field.evaluate('(element) => element === document.activeElement'))
		field.fill('Segoe UI')
		exported = self.page.evaluate("async () => {const [,reply]=await Promise.all([graphTransport.beforeExport(),graphTransport.request('export')]);return reply.file.document}")
		self.assertEqual(exported['defaults']['node']['fontFamily'], 'Segoe UI')
		self.assertEqual(self.page.locator('#error').inner_text(), '')
		self.assertEqual(self.page.evaluate('gv.metrics.fullResets'), 0)


if __name__ == '__main__':
	unittest.main(verbosity=2)
