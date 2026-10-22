import type {
	JsonObject, Layer, Point, Color, FontStyle, NodeVisual, EdgeVisual, Context, Delta, ViewState, Snapshot,
	NodeEntry, EdgeEntry, GraphItem, Query, GraphError, GridOptions
} from './types.ts';
import {previewEdge} from './preview.ts';
import {download, pngImage, svgImage, type ImageOptions} from './export.ts';
import {defaultFontFamily} from './font.ts';
import {drawText, nearestPoint} from './text.ts';
export {imageSVG} from './export.ts';

type Attributes = Record<string, string | number | boolean>;
type PanGesture = {type: 'pan'; start: Point; camera: Camera; id?: never; group?: never};
type EditGesture = {
	type: 'drag' | 'resize'; id: string; group: SVGGElement; start: Point; origin: Point; current: Point; ending?: boolean;
	origins: Map<string, Point>; initial: NodeVisual; resizePoint?: Point
};
interface Camera {x: number; y: number; zoom: number}

const ns = 'http://www.w3.org/2000/svg';
function byId<T extends Element = HTMLElement>(id: string): T
{
	const target = document.getElementById(id);
	if (!target) throw new Error(`Missing graph element: ${id}`);
	return target as unknown as T;
}
const parameters = new URLSearchParams(location.hash.slice(1));
const token = parameters.get('token');
const graphId = window.graphTransport?.graphId ?? parameters.get('graph');
window.addEventListener('hashchange', () => location.reload());
const viewId = crypto.randomUUID();
const svg = byId<SVGSVGElement>('graph');
const layers = {frames: byId<SVGGElement>('frames'), nodes: byId<SVGGElement>('nodes'), edges: byId<SVGGElement>('edges')};
const objects = {frames: new Map<string, NodeEntry>(), nodes: new Map<string, NodeEntry>(), edges: new Map<string, EdgeEntry>()};
const metrics = {snapshots: 0, fullResets: 0, upserts: {frames: 0, nodes: 0, edges: 0}, requests: {} as Record<string, number>};
let revision = '0';
let documentRevision = '0';
let acknowledgedDocumentRevision = '0';
let renderedDocumentRevision = '0';
let context: Context;
let camera = {x: 100, y: 100, zoom: 1};
let gridOrigin: Point = {x: 0, y: 0};
let gridSpacing = 25;
let gesture: PanGesture | EditGesture | null = null;
let selected: {id: string; kind: string; value?: GraphItem} | null = null;
let chain: Promise<unknown> = Promise.resolve();
let stopped = false;
let ready = false;
let focusEvent = '0';
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotPending: Promise<void> | undefined;
let pollPending = false;
let inputPending = 0;
let previewFrame: number | undefined;
const interactionMetrics = {previewFrames: 0, lastPreviewMs: 0,
	uiRoundTrips: [] as {action: string; queueMs: number; ms: number}[]};
let diagnosticSignature = '';

if (!document.documentElement.dataset.theme)
	document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

export class Pulse
{
	now: () => number;
	event: string;
	until: number;
	constructor(now: () => number = () => performance.now())
	{
		this.now = now;
		this.event = '0';
		this.until = 0;
	}

	accept(event: string, active: boolean): void
	{
		if (event !== this.event)
		{
			this.event = event;
			this.until = active ? this.now() + 300 : 0;
		}
	}

	get active(): boolean { return this.now() < this.until; }
}
const pulse = new Pulse();

async function api<T = ViewState>(op: string, fields: JsonObject = {}): Promise<T>
{
	if (stopped) throw Object.assign(new Error('Graph view is closed'), {code: 'view_closed'});
	metrics.requests[op] = (metrics.requests[op] ?? 0) + 1;
	if (window.graphTransport)
	{
		const data = await window.graphTransport.request(op, fields);
		if (stopped) throw Object.assign(new Error('Graph view is closed'), {code: 'view_closed'});
		return data as unknown as T;
	}

	const response = await fetch('/api', {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
		body: JSON.stringify({op, graph_id: graphId, ...fields})
	});
	const reply = await response.json() as {ok: boolean; error: {message: string; code: string}; data: T};
	if (stopped) throw Object.assign(new Error('Graph view is closed'), {code: 'view_closed'});
	if (!reply.ok)
	{
		const error: GraphError = new Error(reply.error.message);
		error.code = reply.error.code;
		throw error;
	}

	return reply.data;
}

function errorMessage(error: unknown): void
{
	if (stopped) return;
	const failure = error instanceof Error ? error as GraphError : new Error(String(error));
	byId('error').textContent = `${(failure as GraphError).code ?? 'network'}: ${failure.message}`;
}

function enqueue(event: JsonObject): Promise<ViewState>
{
	if (stopped) return Promise.reject(Object.assign(new Error('Graph view is closed'), {code: 'view_closed'}));
	inputPending += 1;
	const queued = performance.now();
	const task = chain.then(async () => {
		const started = performance.now();
		const state = await syncView('ui', {event: {view_id: viewId, expected_revision: documentRevision, ...event}});
		interactionMetrics.uiRoundTrips.push({action: String(event.action), queueMs: started - queued, ms: performance.now() - started});
		if (interactionMetrics.uiRoundTrips.length > 100) interactionMetrics.uiRoundTrips.shift();
		schedulePoll(0);
		return state;
	}).finally((): void => {inputPending -= 1;});
	chain = task.catch(errorMessage);

	return task;
}

function element<K extends keyof SVGElementTagNameMap>(tag: K, parent: Element, attributes: Attributes = {}): SVGElementTagNameMap[K]
{
	const result = document.createElementNS(ns, tag);
	for (const [key, value] of Object.entries(attributes))
		result.setAttribute(key, String(value));

	parent.append(result);
	return result;
}

function attrs(target: Element, values: Attributes): void
{
	for (const [key, value] of Object.entries(values))
	{
		if (target.getAttribute(key) !== String(value))
			target.setAttribute(key, String(value));
	}
}

function color(value: Color): string
{
	return `rgba(${value.r},${value.g},${value.b},${value.a / 255})`;
}

function font(text: Element, style: FontStyle, fill: Color | string): void
{
	attrs(text, {
		fill: typeof fill === 'string' ? fill : color(fill),
		'font-family': style.fontFamily || context.fallbackFontFamily || defaultFontFamily,
		'font-size': style.fontSize, 'font-weight': style.fontBold ? 'bold' : 'normal',
		'font-style': style.fontItalic ? 'italic' : 'normal',
		'text-decoration': [style.fontUnderline ? 'underline' : '', style.fontStrikeOut ? 'line-through' : ''].join(' ')
	});
}

function createNode(layer: 'nodes' | 'frames', id: string): SVGGElement
{
	const group = element('g', layers[layer], {class: 'visual', 'data-id': id, 'data-kind': 'node'});
	element('rect', group, {class: 'shape'});
	element('ellipse', group, {class: 'circle'});
	element('text', group, {'text-anchor': 'middle', 'dominant-baseline': 'middle'});
	element('rect', group, {class: 'frame-border', fill: 'none', stroke: 'transparent', 'stroke-width': 16});
	element('rect', group, {class: 'frame-header', fill: 'transparent'});
	element('rect', group, {class: 'outline', fill: 'none'});
	element('rect', group, {class: 'resize', width: 10, height: 10});
	const toggle = element('g', group, {class: 'disclosure', role: 'button', tabindex: 0});
	element('rect', toggle, {width: 22, height: 22, rx: 5});
	element('path', toggle, {fill: 'none'});
	const clip = element('clipPath', element('defs', group), {id: `gv-text-${viewId}-${id}`});
	element('rect', clip);
	element('ellipse', clip);
	element('title', group);

	return group;
}

function nodeColor(visual: NodeVisual, property: 'fill' | 'borderColor' | 'textColor'): string
{
	if (context.follow_host_theme && visual.node.profile === null && visual.node.style[property] == null)
	{
		const fill = visual.node.style.fill;
		if (property === 'textColor' && fill?.a === 255)
		{
			const linear = [fill.r, fill.g, fill.b].map((channel: number): number => {
				const value = channel / 255;
				return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
			});
			return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 > 0.179 ? '#111111' : '#ffffff';
		}

		const role = {fill: 'fill', borderColor: 'border', textColor: 'text'}[property];
		return `var(--gv-node-${role})`;
	}

	return color(visual.style[property]);
}

function canvasColor(property: keyof Context['canvas']): string
{
	return context.follow_host_theme ? `var(--gv-${property})` : color(context.canvas[property]);
}

function updateNode(layer: 'nodes' | 'frames', visual: NodeVisual): void
{
	const node = visual.node;
	let entry = objects[layer].get(node.id);
	if (!entry)
	{
		entry = {group: createNode(layer, node.id), visual};
		objects[layer].set(node.id, entry);
	}
	entry.visual = visual;
	const group = entry.group;
	const [rect, circle, text, frameBorder, frameHeader, outline, resize] = group.children;
	const {x, y} = node.center;
	const w = node.size.width;
	const h = node.size.height;
	const style = visual.style;
	const circular = style.shape === 0 && layer !== 'frames';
	attrs(rect, {x: x - w / 2, y: y - h / 2, width: w, height: h, display: circular ? 'none' : 'inline'});
	attrs(rect, {'pointer-events': layer === 'frames' ? 'none' : 'auto'});
	attrs(circle, {cx: x, cy: y, rx: w / 2, ry: h / 2, display: circular ? 'inline' : 'none'});
	for (const shape of [rect, circle])
		attrs(shape, {fill: nodeColor(visual, 'fill'), stroke: nodeColor(visual, 'borderColor'), 'stroke-width': style.borderWidth});

	font(text, style, nodeColor(visual, 'textColor'));
	nodeText(group, visual, visual.textBounds, layer === 'frames');
	const decorated = visual.engaged || visual.selected || visual.active || visual.highlighted;
	const decoration = canvasColor(visual.engaged || visual.selected ? 'selection' : visual.active ? 'connectionTarget' : 'highlight');
	attrs(outline, {
		x: x - w / 2 - 3, y: y - h / 2 - 3, width: w + 6, height: h + 6,
		stroke: decoration, 'stroke-width': 2, display: decorated ? 'inline' : 'none'
	});
	attrs(resize, {
		x: x + w / 2 - 5, y: y + h / 2 - 5, fill: canvasColor('handleFill'),
		stroke: canvasColor('selection'), display: visual.selected && layer !== 'frames' ? 'inline' : 'none'
	});
	attrs(frameBorder, {x: x - w / 2, y: y - h / 2, width: w, height: h,
		display: layer === 'frames' ? 'inline' : 'none', 'pointer-events': 'stroke'});
	attrs(frameHeader, {x: x - w / 2, y: y - h / 2, width: w, height: Math.min(36, h),
		display: layer === 'frames' ? 'inline' : 'none'});
	const toggle = group.children[7];
	attrs(toggle, {display: node.subgraph ? 'inline' : 'none', transform: `translate(${x + w / 2 - 28},${y - h / 2 + 5})`,
		'aria-label': node.expanded ? '서브그래프 접기' : '서브그래프 펼치기', 'aria-expanded': String(node.expanded)});
	attrs(toggle.children[1], {d: node.expanded ? 'M 6 11 L 16 11' : 'M 6 11 L 16 11 M 11 6 L 11 16'});
	group.dataset.parent = node.parent ?? '';
	group.dataset.active = String(visual.active);
	group.dataset.hovered = String(visual.hovered);
	group.dataset.engaged = String(visual.engaged);
	group.dataset.selected = String(visual.selected);
	attrs(group, {tabindex: 0, role: 'group', 'aria-label': `${node.label || '노드'}, ID ${node.id}`});
	if (gesture?.type === 'drag' && gesture.origins.has(node.id))
		previewDrag(entry, gesture);
	else
		group.removeAttribute('transform');
	if (gesture?.type === 'resize' && gesture.id === node.id && gesture.resizePoint) previewResize(gesture);

	metrics.upserts[layer] += 1;
}

function nodeText(group: SVGGElement, visual: NodeVisual, area: NodeVisual['textBounds'], frame: boolean): void
{
	const text = group.children[2] as SVGTextElement;
	const region = {...area, width: Math.max(0, area.width), height: Math.max(0, area.height)};
	if (frame) region.height = Math.min(region.height, visual.style.fontSize * 1.5);
	const clip = group.querySelector('clipPath')!;
	const circular = visual.style.shape === 0 && !frame;
	attrs(clip.children[0], {...region, display: circular ? 'none' : 'inline'});
	attrs(clip.children[1], {cx: region.x + region.width / 2, cy: region.y + region.height / 2,
		rx: region.width / 2, ry: region.height / 2, display: circular ? 'inline' : 'none'});
	attrs(text, {'clip-path': `url(#${clip.id})`, 'aria-label': visual.node.label});
	drawText(text, visual.node.label, region);
	group.querySelector('title')!.textContent = visual.node.label;
}

function pathData(visual: EdgeVisual): string
{
	if (!visual.path.length || visual.status >= 2)
		return '';

	let result = `M ${visual.path[0].x} ${visual.path[0].y}`;
	if (!visual.segments.length)
		return result + visual.path.slice(1).map((point: Point): string => ` L ${point.x} ${point.y}`).join('');

	for (const segment of visual.segments)
	{
		if (segment.cubic)
			result += ` C ${segment.control1.x} ${segment.control1.y} ${segment.control2.x} ${segment.control2.y}`;
		else
			result += ' L';

		result += ` ${segment.end.x} ${segment.end.y}`;
	}

	return result;
}

function updateEdge(visual: EdgeVisual): void
{
	let entry = objects.edges.get(visual.id);
	if (!entry)
	{
		const group = element('g', layers.edges, {class: 'visual', 'data-id': visual.id, 'data-kind': 'edge'});
		element('path', group, {class: 'wire', fill: 'none'});
		element('polygon', group);
		element('g', group, {class: 'waypoints'});
		const label = element('g', byId('edge-labels'), {class: 'visual edge-label', 'data-id': visual.id, 'data-kind': 'edge'});
		element('rect', label, {class: 'label-background', rx: 3});
		element('text', label, {'text-anchor': 'middle', 'dominant-baseline': 'middle'});
		element('rect', label, {class: 'label-bounds', fill: 'none', 'pointer-events': 'none'});
		element('path', group, {class: 'label-leader', fill: 'none', 'pointer-events': 'none'});
		element('title', label);
		for (const event of ['pointerenter', 'focusin'])
			label.addEventListener(event, (): void => {group.classList.add('label-related');});
		for (const event of ['pointerleave', 'focusout'])
			label.addEventListener(event, (): void => {group.classList.remove('label-related');});
		entry = {group, label, visual};
		objects.edges.set(visual.id, entry);
	}
	entry.visual = visual;
	drawEdge(entry, edgePreview(visual));
	metrics.upserts.edges += 1;
}

function drawEdge(entry: EdgeEntry, visual: EdgeVisual): void
{
	const [path, arrow, waypoints] = entry.group.children;
	const [background, text, bounds] = entry.label.children;
	const style = visual.style;
	const route = pathData(visual);
	const routed = route !== '';
	const stroke = visual.engaged || visual.selected ? context.canvas.selection
		: visual.active ? context.canvas.connectionTarget : visual.highlighted ? context.canvas.highlight : style.color;
	attrs(path, {d: route, stroke: color(stroke), 'stroke-width': style.width});
	attrs(arrow, {points: routed ? visual.arrow.map((point) => `${point.x},${point.y}`).join(' ') : '', fill: color(stroke)});
	attrs(text, {x: visual.labelAnchor.x, y: visual.labelAnchor.y, display: routed ? 'inline' : 'none'});
	font(text, style, style.textColor ?? style.color);
	drawText(text as SVGTextElement, visual.text, visual.labelBounds, false);
	attrs(entry.label, {display: routed && visual.text !== '' ? 'inline' : 'none'});
	// 실제 글리프 범위까지 덮는 배경판, 별도 레이어로 다른 엣지의 글자 관통 방지
	const measured = (text as SVGGraphicsElement).getBBox();
	const left = Math.min(measured.x, visual.labelBounds.x);
	const top = Math.min(measured.y, visual.labelBounds.y);
	attrs(background, {x: left - 4, y: top - 2,
		width: Math.max(measured.x + measured.width, visual.labelBounds.x + visual.labelBounds.width) - left + 8,
		height: Math.max(measured.y + measured.height, visual.labelBounds.y + visual.labelBounds.height) - top + 4,
		fill: canvasColor('background'), stroke: color(style.color), 'stroke-width': 0.75});
	const ownerName = (id: string): string =>
		`${(objects.nodes.get(id) ?? objects.frames.get(id))?.visual.node.label.replace(/\r?\n/g, ' ') || '노드'} [${id}]`;
	const owner = `${ownerName(visual.actualSource)} → ${ownerName(visual.actualTarget)}`;
	attrs(entry.label, {tabindex: 0, role: 'group', 'aria-label': `엣지 ${visual.id}, ${owner}: ${visual.text}`,
		'data-source': visual.source, 'data-target': visual.target, 'data-owner-edge': visual.id});
	entry.label.querySelector('title')!.textContent = `엣지 ${visual.id}: ${owner}\n${visual.text}`;
	const anchor = nearestPoint(visual.path, visual.labelAnchor);
	const dx = anchor.x - visual.labelAnchor.x;
	const dy = anchor.y - visual.labelAnchor.y;
	const halfWidth = Number(background.getAttribute('width')) / 2;
	const halfHeight = Number(background.getAttribute('height')) / 2;
	const fraction = Math.min(dx ? halfWidth / Math.abs(dx) : Infinity, dy ? halfHeight / Math.abs(dy) : Infinity);
	const endpoint = {x: visual.labelAnchor.x + dx * fraction, y: visual.labelAnchor.y + dy * fraction};
	attrs(entry.group.querySelector('.label-leader')!, {
		d: fraction < 1 ? `M ${anchor.x} ${anchor.y} L ${endpoint.x} ${endpoint.y}` : '', stroke: color(style.color),
		'stroke-width': 1, 'stroke-dasharray': '4 3',
		display: routed && fraction < 1 && Math.hypot(anchor.x - endpoint.x, anchor.y - endpoint.y) > 6 ? 'inline' : 'none'
	});
	attrs(bounds, {
		...visual.labelBounds, stroke: color(context.canvas.highlight),
		display: routed && visual.labelStatus === 1 ? 'inline' : 'none'
	});
	while (waypoints.children.length > visual.waypoints.length)
		waypoints.lastChild!.remove();

	visual.waypoints.forEach((point, index) => {
		const circle = waypoints.children[index] ?? element('circle', waypoints, {r: 4});
		attrs(circle, {cx: point.x, cy: point.y, fill: color(context.canvas.handleFill), stroke: color(style.color)});
	});
	entry.group.dataset.source = visual.source;
	entry.group.dataset.target = visual.target;
	entry.group.dataset.actualSource = visual.actualSource;
	entry.group.dataset.actualTarget = visual.actualTarget;
	entry.group.dataset.routeStatus = String(visual.status);
	entry.group.dataset.selected = String(visual.selected);
	attrs(entry.group, {tabindex: 0, role: 'group', 'aria-label': `${visual.text || '엣지'}, ID ${visual.id}`});
}

function applyContext(value: Context): void
{
	context = value;
	svg.style.backgroundColor = canvasColor('background');
	attrs(byId('grid-path'), {stroke: canvasColor('grid')});
}

function applyDelta(delta: Delta): void
{
	if (BigInt(delta.revision) <= BigInt(revision))
		return;

	if (delta.previous_revision !== revision)
		throw Object.assign(new Error('Render sequence missing'), {code: 'resync_required'});

	const visibilityChanged = delta.removed_nodes.length > 0 || delta.removed_frames.length > 0
		|| delta.upserted_nodes.some((visual) => !objects.nodes.has(visual.node.id))
		|| delta.upserted_frames.some((visual) => !objects.frames.has(visual.node.id));
	applyContext(delta.context);
	for (const layer of ['edges', 'nodes', 'frames'] as const)
	{
		for (const id of delta[`removed_${layer}`])
		{
			if (layer === 'edges') objects.edges.get(id)?.label.remove();
			objects[layer].get(id)?.group.remove();
			objects[layer].delete(id);
		}
	}
	for (const layer of ['frames', 'nodes'] as const)
	{
		for (const visual of delta[`upserted_${layer}`])
			updateNode(layer, visual);
	}
	for (const visual of delta.upserted_edges)
		updateEdge(visual);
	if (gesture && gesture.type !== 'pan') schedulePreview();

	for (const [layer, key] of [['frames', 'frame_order'], ['nodes', 'node_order'], ['edges', 'edge_order']] as const)
	{
		if (delta[key] !== null)
		{
			for (const id of delta[key])
			{
				layers[layer].append(objects[layer].get(id)!.group);
				if (layer === 'edges') byId('edge-labels').append(objects.edges.get(id)!.label);
			}
		}
	}
	revision = delta.revision;
	if (ready && visibilityChanged && !gesture) ensureVisible();
	window.dispatchEvent(new CustomEvent('gv-scene-change', {detail: {visibilityChanged,
		nodes: [...delta.upserted_frames, ...delta.upserted_nodes].map((visual): string => visual.node.id),
		edges: delta.upserted_edges.map((visual): string => visual.id)}}));
}

function setCamera(): void
{
	attrs(byId('camera'), {transform: `translate(${camera.x},${camera.y}) scale(${camera.zoom})`});
	updateGrid(gridSpacing);
	const zoom = byId<HTMLInputElement>('zoom-level');
	if (document.activeElement !== zoom) zoom.value = `${Number((camera.zoom * 100).toFixed(2))}%`;
}

const zoomInput = byId<HTMLInputElement>('zoom-level');
const zoomError = '줌 배율은 0.1%에서 800% 사이의 숫자로 입력하세요.';
zoomInput.addEventListener('focus', (): void => {zoomInput.select();});
zoomInput.addEventListener('keydown', (event): void =>
{
	if (event.key === 'Escape') {event.preventDefault(); zoomInput.value = `${camera.zoom * 100}%`; zoomInput.blur();}
	if (event.key === 'Enter') {event.preventDefault(); zoomInput.blur();}
});
zoomInput.addEventListener('blur', (): void =>
{
	const raw = zoomInput.value.trim().replace(/%$/, '').trim();
	const percent = Number(raw);
	if (!raw || !Number.isFinite(percent) || percent < 0.1 || 800 < percent)
	{
		zoomInput.value = `${Number((camera.zoom * 100).toFixed(2))}%`;
		zoomInput.setAttribute('aria-invalid', 'true');
		errorMessage(new Error(zoomError));
		return;
	}

	zoomInput.removeAttribute('aria-invalid');
	if (byId('error').textContent?.endsWith(zoomError)) byId('error').textContent = '';
	zoomBy(percent / 100 / camera.zoom);
});

function zoomBy(factor: number): void
{
	if (stopped || !ready || !Number.isFinite(factor) || factor <= 0) return;

	const bounds = svg.getBoundingClientRect();
	const x = bounds.width / 2;
	const y = bounds.height / 2;
	const next = Math.max(0.001, Math.min(8, camera.zoom * factor));
	const ratio = next / camera.zoom;
	camera.x = x - (x - camera.x) * ratio;
	camera.y = y - (y - camera.y) * ratio;
	camera.zoom = next;
	setCamera();
}

function fit(ids: string[] = []): void
{
	if (stopped) return;
	let bounds = context?.bounds;
	if (ids.length)
	{
		const nodes = [...objects.nodes.values(), ...objects.frames.values()]
			.filter((entry) => ids.includes(entry.visual.node.id)).map((entry) => entry.visual.node);
		if (nodes.length)
		{
			const x = Math.min(...nodes.map((node) => node.center.x - node.size.width / 2));
			const y = Math.min(...nodes.map((node) => node.center.y - node.size.height / 2));
			bounds = {x, y, width: Math.max(...nodes.map((node) => node.center.x + node.size.width / 2)) - x,
				height: Math.max(...nodes.map((node) => node.center.y + node.size.height / 2)) - y};
		}
	}
	if (!bounds)
		return;

	const size = svg.getBoundingClientRect();
	camera.zoom = Math.max(0.001, Math.min(2,
		Math.max(1, size.width - 100) / Math.max(100, bounds.width), Math.max(1, size.height - 100) / Math.max(100, bounds.height)));
	camera.x = size.width / 2 - (bounds.x + bounds.width / 2) * camera.zoom;
	camera.y = size.height / 2 - (bounds.y + bounds.height / 2) * camera.zoom;
	setCamera();
}

function ensureVisible(): void
{
	if (!context) return;
	const size = svg.getBoundingClientRect();
	const bounds = context.bounds;
	if (bounds.x * camera.zoom + camera.x < 16 || bounds.y * camera.zoom + camera.y < 16
		|| (bounds.x + bounds.width) * camera.zoom + camera.x > size.width - 16
		|| (bounds.y + bounds.height) * camera.zoom + camera.y > size.height - 16)
		fit();
}

function world(event: {clientX: number; clientY: number}): Point
{
	const size = svg.getBoundingClientRect();

	return {x: (event.clientX - size.left - camera.x) / camera.zoom, y: (event.clientY - size.top - camera.y) / camera.zoom};
}

async function inspect(id: string, kind: string): Promise<void>
{
	const node = objects.nodes.get(id)?.visual.node ?? objects.frames.get(id)?.visual.node;
	selected = {id, kind, value: node as unknown as GraphItem};
	if (byId('inspector').hasAttribute('hidden'))
		return;

	const data = await api<Query>('query', {kind: kind === 'node' ? 'nodes' : 'edges', filter: {ids: [id]}});
	selected = {id, kind, value: data.items[0]};
	const visual = kind === 'edge' ? objects.edges.get(id)?.visual : null;
	const details = visual ? {...selected.value, routing_status: visual.status,
		visible_source: visual.source, visible_target: visual.target,
		actual_source: visual.actualSource, actual_target: visual.actualTarget} : selected.value;
	byId('details').textContent = JSON.stringify(details, null, 2);
	window.dispatchEvent(new CustomEvent('gv-selection', {detail: {id, kind}}));
}

let movePending = false;
let queuedMove: Point | null = null;

function endpointShift(id: string, point: Point): Point
{
	const current = gesture;
	const entry = objects.nodes.get(id) ?? objects.frames.get(id);
	if (!current || current.type === 'pan' || !entry) return {x: 0, y: 0};
	const node = entry.visual.node;
	if (current.type === 'drag')
	{
		const origin = current.origins.get(id);
		return origin ? {x: origin.x + current.current.x - current.origin.x - node.center.x,
			y: origin.y + current.current.y - current.origin.y - node.center.y} : {x: 0, y: 0};
	}
	if (current.id !== id || !current.resizePoint) return {x: 0, y: 0};
	const initial = current.initial.node;
	const x = initial.center.x - initial.size.width / 2;
	const y = initial.center.y - initial.size.height / 2;
	let width = Math.max(20, current.resizePoint.x - x);
	let height = Math.max(20, current.resizePoint.y - y);
	if (current.initial.style.shape === 0) width = height = Math.max(width, height);
	return {x: x + (point.x - node.center.x + node.size.width / 2) * width / node.size.width - point.x,
		y: y + (point.y - node.center.y + node.size.height / 2) * height / node.size.height - point.y};
}

function edgePreview(visual: EdgeVisual): EdgeVisual
{
	if (!gesture || gesture.type === 'pan' || visual.path.length < 2) return visual;
	const source = endpointShift(visual.source, visual.path[0]);
	const target = endpointShift(visual.target, visual.path.at(-1)!);
	return source.x || source.y || target.x || target.y ? previewEdge(visual, source, target) : visual;
}

function schedulePreview(): void
{
	if (previewFrame !== undefined || stopped) return;
	previewFrame = requestAnimationFrame((): void => {
		previewFrame = undefined;
		if (!gesture || gesture.type === 'pan' || stopped) return;
		const started = performance.now();
		if (gesture.type === 'drag')
		{
			for (const id of gesture.origins.keys())
			{
				const entry = objects.nodes.get(id) ?? objects.frames.get(id);
				if (entry) previewDrag(entry, gesture);
			}
		}
		else previewResize(gesture);
		for (const entry of objects.edges.values())
		{
			if (gesture.origins.has(entry.visual.source) || gesture.origins.has(entry.visual.target))
				drawEdge(entry, edgePreview(entry.visual));
		}
		interactionMetrics.previewFrames += 1;
		interactionMetrics.lastPreviewMs = performance.now() - started;
	});
}

function previewOrigins(id: string, selectedNode: boolean): Map<string, Point>
{
	const entries = [...objects.frames.values(), ...objects.nodes.values()];
	const roots = new Set(selectedNode
		? entries.filter((entry: NodeEntry): boolean => entry.visual.selected).map((entry: NodeEntry): string => entry.visual.node.id)
		: [id]);
	const origins = new Map<string, Point>();
	for (const entry of entries)
	{
		let node: NodeVisual['node'] | undefined = entry.visual.node;
		while (node)
		{
			if (roots.has(node.id)) {origins.set(entry.visual.node.id, {...entry.visual.node.center}); break;}
			node = node.parent ? (objects.frames.get(node.parent) ?? objects.nodes.get(node.parent))?.visual.node : undefined;
		}
	}
	return origins;
}

function previewDrag(entry: NodeEntry, current: EditGesture): void
{
	const origin = current.origins.get(entry.visual.node.id);
	if (!origin) return;
	attrs(entry.group, {transform: `translate(${origin.x + current.current.x - current.origin.x - entry.visual.node.center.x},`
		+ `${origin.y + current.current.y - current.origin.y - entry.visual.node.center.y})`});
}

function previewResize(current: EditGesture): void
{
	const point = current.resizePoint;
	if (!point) return;
	const node = current.initial.node;
	const x = node.center.x - node.size.width / 2;
	const y = node.center.y - node.size.height / 2;
	let width = Math.max(20, point.x - x);
	let height = Math.max(20, point.y - y);
	if (current.initial.style.shape === 0) width = height = Math.max(width, height);
	const [rect, circle, text] = current.group.children;
	attrs(rect, {x, y, width, height});
	attrs(circle, {cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2});
	const padding = current.initial.style.padding;
	nodeText(current.group, current.initial, {x: x + padding.left, y: y + padding.top,
		width: width - padding.left - padding.right, height: height - padding.top - padding.bottom}, false);
	attrs(current.group.querySelector('.outline')!, {x: x - 3, y: y - 3, width: width + 6, height: height + 6});
	attrs(current.group.querySelector('.resize')!, {x: x + width - 5, y: y + height - 5});
}

function clearPreview(current: EditGesture): void
{
	for (const id of current.origins.keys()) (objects.nodes.get(id) ?? objects.frames.get(id))?.group.removeAttribute('transform');
	if (current.type === 'resize')
	{
		const entry = objects.nodes.get(current.id);
		if (entry) updateNode('nodes', entry.visual);
	}
	for (const entry of objects.edges.values())
	{
		if (current.origins.has(entry.visual.source) || current.origins.has(entry.visual.target)) drawEdge(entry, entry.visual);
	}
}

function sendMove(point: Point): void
{
	if (!gesture || gesture.type === 'pan' || gesture.ending)
		return;
	queuedMove = point;
	if (movePending)
		return;

	movePending = true;
	const run = async (): Promise<void> => {
		// Do not queue obsolete moves behind a slow begin; a drop already carries the final pointer.
		await chain;
		while (queuedMove && gesture && gesture.type !== 'pan' && !gesture.ending)
		{
			const value = queuedMove;
			queuedMove = null;
			await enqueue({action: 'gesture_move', point: value});
		}
	};
	run().catch(errorMessage).finally(() => {movePending = false;});
}

svg.addEventListener('pointerdown', (event) => {
	if (stopped || !ready || gesture || event.button !== 0)
		return;

	byId('error').textContent = '';
	const target = event.target as Element;
	if (target.closest('.disclosure'))
		return;
	const group = target.closest<SVGGElement>('.visual');
	const point = world(event);
	svg.setPointerCapture(event.pointerId);
	if (!group)
	{
		gesture = {type: 'pan', start: {x: event.clientX, y: event.clientY}, camera: {...camera}};
		return;
	}
	const id = group.dataset.id!;
	const kind = group.dataset.kind!;
	inspect(id, kind).catch(errorMessage);
	if (kind === 'edge' || event.shiftKey)
	{
		enqueue({action: 'select', id, kind, additive: event.shiftKey}).catch(errorMessage);
		return;
	}
	const entry = objects.nodes.get(id) ?? objects.frames.get(id)!;
	const node = entry.visual.node;
	const resize = target.classList.contains('resize');
	gesture = {type: resize ? 'resize' : 'drag', id, group, start: point, origin: node.center, current: {...node.center},
		origins: previewOrigins(id, entry.visual.selected), initial: entry.visual};
	const started = gesture;
	enqueue({action: resize ? 'resize_begin' : 'drag_begin', id, point}).catch(() => {
		if (gesture === started)
		{
			gesture = null;
			clearPreview(started);
		}
	});
});

svg.addEventListener('pointermove', (event) => {
	if (stopped || !ready) return;
	if (!gesture)
	{
		queueHover(world(event));
		return;
	}
	if (gesture.type !== 'pan' && gesture.ending)
		return;

	if (gesture.type === 'pan')
	{
		camera.x = gesture.camera.x + event.clientX - gesture.start.x;
		camera.y = gesture.camera.y + event.clientY - gesture.start.y;
		setCamera();
		return;
	}
	const point = world(event);
	gesture.current = {x: gesture.origin.x + point.x - gesture.start.x, y: gesture.origin.y + point.y - gesture.start.y};
	if (gesture.type === 'resize') gesture.resizePoint = point;
	schedulePreview();
	sendMove(point);
});

async function finishGesture(event: PointerEvent, cancel: boolean = false): Promise<void>
{
	if (!gesture)
		return;

	const current = gesture;
	if (current.type === 'pan')
	{
		gesture = null;
		return;
	}
	if (current.ending)
		return;

	current.ending = true;
	queuedMove = null;
	const point = world(event);
	if (!cancel)
	{
		current.current = {x: current.origin.x + point.x - current.start.x, y: current.origin.y + point.y - current.start.y};
		if (current.type === 'resize') current.resizePoint = point;
		schedulePreview();
	}
	try
	{
		await enqueue(cancel ? {action: 'cancel'} : {action: 'gesture_end', point});
	}
	catch (error)
	{
		errorMessage(error);
	}
	finally
	{
		if (gesture === current)
		{
			gesture = null;
			clearPreview(current);
			if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
			const bounds = svg.getBoundingClientRect();
			const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
				&& event.clientY >= bounds.top && event.clientY <= bounds.bottom;
			queueHover(!cancel && inside ? world(event) : null);
		}
		else if (gesture?.group !== current.group) current.group.removeAttribute('transform');
	}
}
svg.addEventListener('pointerup', (event) => {finishGesture(event);});
svg.addEventListener('pointercancel', (event) => {finishGesture(event, true);});
svg.addEventListener('lostpointercapture', (event) => {finishGesture(event, true);});
window.addEventListener('blur', () => {
	if (gesture && gesture.type !== 'pan')
	{
		const current = gesture;
		gesture = null;
		clearPreview(current);
		enqueue({action: 'cancel'}).catch(errorMessage);
	}
	else gesture = null;
	queueHover(null);
});
window.addEventListener('pagehide', () => {
	if (window.graphTransport)
	{
		window.graphTransport.request('dispose', {view_id: viewId}).catch(errorMessage);
		return;
	}
	fetch('/api', {
		method: 'POST', keepalive: true,
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
		body: JSON.stringify({op: 'ui', graph_id: graphId, event: {action: 'cancel', view_id: viewId}})
	}).catch(() => {});
});
svg.addEventListener('wheel', (event) => {
	event.preventDefault();
	if (stopped || !ready) return;
	const point = world(event);
	const next = Math.max(0.05, Math.min(10, camera.zoom * Math.exp(-event.deltaY / 500)));
	camera.x += point.x * (camera.zoom - next);
	camera.y += point.y * (camera.zoom - next);
	camera.zoom = next;
	setCamera();
}, {passive: false});
const touchPoints = new Map<number, Point>();
let pinch: {distance: number; zoom: number; anchor: Point} | undefined;
const pinchStart = (): void =>
{
	const [a, b] = [...touchPoints.values()];
	if (!a || !b) return;

	const center = {clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2};
	pinch = {distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), zoom: camera.zoom, anchor: world(center)};
};
svg.addEventListener('pointerdown', (event): void =>
{
	if (event.pointerType !== 'touch') return;

	touchPoints.set(event.pointerId, {x: event.clientX, y: event.clientY});
	if (touchPoints.size < 2) return;

	event.preventDefault(); event.stopImmediatePropagation();
	window.dispatchEvent(new Event('gv-cancel-direct'));
	void finishGesture(event, true);
	svg.setPointerCapture(event.pointerId); pinchStart();
}, true);
svg.addEventListener('pointermove', (event): void =>
{
	if (!touchPoints.has(event.pointerId)) return;

	touchPoints.set(event.pointerId, {x: event.clientX, y: event.clientY});
	if (!pinch) return;

	event.preventDefault(); event.stopImmediatePropagation();
	const [a, b] = [...touchPoints.values()];
	if (!a || !b) return;

	const bounds = svg.getBoundingClientRect();
	camera.zoom = Math.max(0.001, Math.min(8, pinch.zoom * Math.hypot(b.x - a.x, b.y - a.y) / pinch.distance));
	camera.x = (a.x + b.x) / 2 - bounds.left - pinch.anchor.x * camera.zoom;
	camera.y = (a.y + b.y) / 2 - bounds.top - pinch.anchor.y * camera.zoom;
	setCamera();
}, true);
for (const type of ['pointerup', 'pointercancel'] as const)
	svg.addEventListener(type, (event): void =>
	{
		touchPoints.delete(event.pointerId);
		if (!pinch) return;

		event.preventDefault(); event.stopImmediatePropagation();
		if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
		if (!touchPoints.size) pinch = undefined;
	}, true);
window.addEventListener('blur', (): void => {touchPoints.clear(); pinch = undefined;});
let hoverPending = false;
let hoverPoint: Point | null | undefined;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
function queueHover(point: Point | null): void
{
	if (stopped) return;
	hoverPoint = point;
	clearTimeout(hoverTimer);
	hoverTimer = setTimeout((): void => {void flushHover();}, 50);
}

async function flushHover(): Promise<void>
{
	if (stopped || hoverPoint === undefined) return;
	if (gesture || inputPending || hoverPending)
	{
		hoverTimer = setTimeout((): void => {void flushHover();}, 50);
		return;
	}
	const point = hoverPoint;
	hoverPoint = undefined;
	hoverPending = true;
	try
	{
		await syncView('ui', {event: {view_id: viewId, action: 'hover', point}});
	}
	catch (error: unknown) {errorMessage(error);}
	finally {hoverPending = false;}
}
svg.addEventListener('pointerover', (event) => {
	if (gesture)
		return;

	const target = (event.target as Element).closest('.visual');
	const previous = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.visual') : null;
	if (target !== previous) queueHover(world(event));
});
svg.addEventListener('pointerleave', () => {
	if (!gesture)
		queueHover(null);
});
byId('fit').onclick = () => fit();
byId('undo').onclick = () => enqueue({action: 'undo'}).catch(errorMessage);
byId('redo').onclick = () => enqueue({action: 'redo'}).catch(errorMessage);
byId('scope-root').onclick = () => enqueue({action: 'scope', id: null}).then(() => fit()).catch(errorMessage);
byId('scope').onclick = () => {
	if (selected?.value?.subgraph)
		enqueue({action: 'scope', id: selected.id}).then(() => fit()).catch(errorMessage);
};
byId('expand').onclick = () => {
	if (selected?.value?.subgraph)
		toggleSubgraph(selected.id);
};
function toggleSubgraph(id: string): void
{
	const entry = objects.nodes.get(id) ?? objects.frames.get(id);
	if (entry?.visual.node.subgraph)
		enqueue({action: 'expand', id, expanded: !entry.visual.node.expanded}).catch(errorMessage);
}
svg.addEventListener('click', (event: MouseEvent): void => {
	const control = (event.target as Element).closest('.disclosure');
	const id = control?.closest<SVGGElement>('.visual')?.dataset.id;
	if (id) toggleSubgraph(id);
});
svg.addEventListener('keydown', (event: KeyboardEvent): void => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	const id = (event.target as Element).closest('.disclosure')?.closest<SVGGElement>('.visual')?.dataset.id;
	if (id) {event.preventDefault(); toggleSubgraph(id);}
});
function setOptions(): void
{
	const spacing = Number(byId<HTMLInputElement>('spacing').value);
	if (!Number.isFinite(spacing) || spacing <= 0)
	{
		errorMessage(new Error('격자 간격은 0보다 커야 합니다.'));
		return;
	}
	enqueue({action: 'options', options: {gridSnap: byId<HTMLInputElement>('snap').checked, gridSpacing: spacing}}).catch(errorMessage);
}
byId('snap').onchange = setOptions;
byId('spacing').onchange = setOptions;

function closeExportMenu(): void
{
	byId('export-menu').setAttribute('hidden', '');
	byId('export-toggle').setAttribute('aria-expanded', 'false');
}

byId('export-toggle').onclick = (): void =>
{
	const hidden = byId('export-menu').toggleAttribute('hidden');
	byId('export-toggle').setAttribute('aria-expanded', String(!hidden));
	if (!hidden) byId<HTMLButtonElement>('export-image').focus();
};
document.addEventListener
(
	'click',
	(event): void =>
	{
		if (!(event.target as Element).closest('.export-control')) closeExportMenu();
	}
);
document.addEventListener
(
	'keydown',
	(event): void =>
	{
		if (event.key === 'Escape') closeExportMenu();
	}
);

async function exportFile(kind: 'image' | 'graph' | 'svg'): Promise<void>
{
	closeExportMenu();
	if (stopped || !ready) return;
	if (gesture || inputPending || document.body.dataset.directEditing === 'true') throw new Error('편집을 마친 뒤 출력하세요.');
	await window.graphTransport?.beforeExport?.();
	await syncView('poll', {view_id: viewId});

	const button = byId<HTMLButtonElement>('export-toggle');
	button.disabled = true;
	byId('error').textContent = '';
	try
	{
		const options: ImageOptions = {scale: Number(byId<HTMLSelectElement>('export-scale').value),
			transparent: byId<HTMLInputElement>('export-transparent').checked,
			area: byId<HTMLSelectElement>('export-area').value as ImageOptions['area']};
		const content = kind === 'image' ? await pngImage(svg, options) : kind === 'svg' ? (await svgImage(svg, options)).blob
			: new Blob([JSON.stringify((await api<{file: JsonObject}>('export')).file, null, '\t') + '\n'],
				{type: 'application/json;charset=utf-8'});
		await download(`graph.${kind === 'image' ? 'png' : kind === 'svg' ? 'svg' : 'json'}`, content, window.graphTransport);
		if (kind === 'graph')
			window.dispatchEvent(new CustomEvent('gv-document-saved', {detail: JSON.parse(await content.text())}));
	}
	finally
	{
		button.disabled = stopped || !ready;
	}
}
byId('export-image').onclick = (): void => {void exportFile('image').catch(errorMessage);};
byId('export-svg').onclick = (): void => {void exportFile('svg').catch(errorMessage);};
byId('export-graph').onclick = (): void => {void exportFile('graph').catch(errorMessage);};

async function snapshot(): Promise<void>
{
	if (snapshotPending) return snapshotPending;
	snapshotPending = loadSnapshot().finally((): void => {snapshotPending = undefined;});
	return snapshotPending;
}

async function loadSnapshot(): Promise<void>
{
	const state = await api<Snapshot>('snapshot', {view_id: viewId});
	if (BigInt(state.render_revision) < BigInt(revision)) return;
	metrics.snapshots += 1;
	if (metrics.snapshots > 1)
		metrics.fullResets += 1;

	for (const layer of Object.keys(objects) as Layer[])
	{
		for (const entry of objects[layer].values())
		{
			if ('label' in entry) entry.label.remove();
			entry.group.remove();
		}

		objects[layer].clear();
	}
	applyContext(state.scene);
	for (const layer of ['frames', 'nodes'] as const)
	{
		for (const visual of state.scene[layer])
			updateNode(layer, visual);
	}
	for (const visual of state.scene.edges)
		updateEdge(visual);

	focusEvent = state.focus_event ?? focusEvent;
	revision = state.render_revision;
	documentRevision = state.document_revision;
	renderedDocumentRevision = documentRevision;
	applyOptions(state.options);
	window.dispatchEvent(new Event('gv-scene-change'));
	// The next poll/UI request acknowledges this scene without delaying the first fit/paint.
}

function updateGrid(spacing: number): void
{
	gridSpacing = spacing;
	const pixels = spacing * camera.zoom;
	// 스냅 값과 독립적인 표시 간격, 축소 시 원래 격자의 10배 단위로 대표 선 유지
	const stride = Math.max(1, 10 ** Math.ceil(Math.log10(8 / pixels)));
	const pitch = Number.isFinite(pixels * stride) && pixels * stride >= 8 ? pixels * stride : 8;
	attrs(byId('grid'), {width: pitch, height: pitch, 'data-stride': stride,
		patternTransform: `translate(${camera.x + gridOrigin.x * camera.zoom},${camera.y + gridOrigin.y * camera.zoom})`});
	attrs(byId('grid-path'), {d: `M ${pitch} 0 L 0 0 0 ${pitch}`});
}

function applyOptions(options: GridOptions): void
{
	const spacing = byId<HTMLInputElement>('spacing');
	if (inputPending === 0)
	{
		byId<HTMLInputElement>('snap').checked = options.gridSnap;
		if (document.activeElement !== spacing) spacing.value = String(options.gridSpacing);
	}

	gridOrigin = options.gridOrigin;
	updateGrid(options.gridSpacing);
	setCamera();
}

function applyUpdate(state: ViewState): void
{
	for (const event of state.events ?? []) applyDelta(event.delta);
	if (BigInt(state.document_revision) > BigInt(documentRevision)) documentRevision = state.document_revision;
	if (state.options && state.document_revision === documentRevision) applyOptions(state.options);
	if (state.focus_event && BigInt(state.focus_event) > BigInt(focusEvent) && !gesture)
	{
		fit(state.focus_ids ?? []);
		focusEvent = state.focus_event;
	}
	if (BigInt(state.render_revision) <= BigInt(revision) && BigInt(state.document_revision) > BigInt(renderedDocumentRevision))
		renderedDocumentRevision = state.document_revision;

	if (state.pulse) pulse.accept(state.pulse.event_id, state.pulse.active);
	const failures = state.routing_failures?.length ?? 0;
	byId('route-status').textContent = failures ? `경로를 찾지 못한 엣지 ${failures}개` : '';
	const signature = JSON.stringify([state.routing_failures ?? [], state.label_overlaps ?? []]);
	if (signature !== diagnosticSignature)
	{
		diagnosticSignature = signature;
		const list = byId('diagnostic-list'); list.replaceChildren();
		const entries = [...(state.routing_failures ?? []).map((item) => ({id: item.id,
			text: item.status === 3 ? '탐색 한도 초과' : '경로 없음'})),
			...(state.label_overlaps ?? []).map((id) => ({id, text: '라벨 겹침'}))];
		for (const item of entries)
		{
			const button = document.createElement('button'); button.textContent = `${item.text} · 엣지 ${item.id} · 위치 찾기`;
			button.onclick = (): void =>
			{
				window.dispatchEvent(new CustomEvent('gv-locate', {detail: {kind: 'edge', id: item.id}}));
			};
			list.append(button);
		}
	}
	byId('connection').textContent = `문서 ${documentRevision} · 렌더 ${revision}`;
	if (!byId('inspector').hasAttribute('hidden'))
		byId('status').textContent = JSON.stringify({routing_failures: state.routing_failures,
			label_overlaps: state.label_overlaps, tcp: state.tcp?.state}, null, 2);
}

async function syncView(op: 'poll' | 'ui', fields: JsonObject): Promise<ViewState>
{
	const acknowledged = renderedDocumentRevision;
	const state = await api(op, {...fields, revision, render_revision: revision, document_revision: acknowledged});
	acknowledgedDocumentRevision = BigInt(acknowledged) > BigInt(acknowledgedDocumentRevision)
		? acknowledged : acknowledgedDocumentRevision;
	applyUpdate(state);
	return state;
}

function schedulePoll(delay: number): void
{
	if (stopped) return;
	clearTimeout(pollTimer);
	pollTimer = setTimeout((): void => {void poll();}, delay);
}

async function poll(): Promise<void>
{
	if (stopped || pollPending)
		return;

	if (gesture || inputPending) {schedulePoll(200); return;}
	pollPending = true;
	try
	{
		await syncView('poll', {view_id: viewId});
	}
	catch (error)
	{
		if ((error as GraphError).code === 'resync_required')
			await snapshot().catch(errorMessage);
		else
		{
			errorMessage(error);
			if ((error as GraphError).code === 'closed_graph')
				stopRenderer();
		}
	}
	finally
	{
		pollPending = false;
	}
	schedulePoll(window.graphTransport ? 200 : 80);
}
const pulseTimer = setInterval(() => byId('pulse').classList.toggle('on', pulse.active), 60);
window.addEventListener('gv-core-update', (): void => {if (ready && !stopped) schedulePoll(0);});
const debug = {get graphId() {return window.graphTransport?.graphId ?? graphId;}, objects, metrics, interactionMetrics,
	api, enqueue, fit, zoomBy, Pulse, pulse,
	inspect,
	setView: (value: Camera): void =>
	{
		if (![value.x, value.y, value.zoom].every(Number.isFinite) || value.zoom <= 0) throw new Error('잘못된 카메라입니다.');

		camera = {...value}; setCamera();
	},
	get editing() {return Boolean(gesture || inputPending || document.body.dataset.directEditing === 'true');},
	sync: async (): Promise<ViewState> => syncView('poll', {view_id: viewId}),
	get revision() {return revision;}, get documentRevision() {return documentRevision;}, get camera() {return camera;},
	get acknowledgedDocumentRevision() {return acknowledgedDocumentRevision;},
	get ready() {return ready;}, get viewId() {return viewId;}, resync: snapshot, stop: stopRenderer};
declare global {interface Window {gv?: typeof debug}}
window.gv = debug;
if ((token || window.graphTransport) && graphId)
{
	try
	{
		await snapshot();
		if (!stopped)
		{
			fit();
			ready = true;
			byId<HTMLButtonElement>('export-toggle').disabled = false;
			poll();
		}
	}
	catch (error)
	{
		errorMessage(error);
	}
}
else
	byId('error').textContent = 'MCP show_graph 도구로 이 세션의 주소를 확인하세요.';

/** @returns {void} */
export function stopRenderer(): void
{
	stopped = true;
	ready = false;
	byId<HTMLButtonElement>('export-toggle').disabled = true;
	closeExportMenu();
	byId('pulse').classList.remove('on');
	if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
	previewFrame = undefined;
	clearTimeout(pollTimer);
	clearTimeout(hoverTimer);
	hoverPoint = undefined;
	clearInterval(pulseTimer);
	queuedMove = null;
	const current = gesture;
	gesture = null;
	if (current && current.type !== 'pan') clearPreview(current);
}
