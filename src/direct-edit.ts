import type {WorkspaceCore} from './transport.ts';
import type {Point, JsonObject, NodeEntry, EdgeEntry} from './renderer/types.ts';
import {flushStyles} from './panels.ts';
import type {WorkspaceState} from './explorer.ts';

const ns = 'http://www.w3.org/2000/svg';
interface Edit
{
	kind: string; id: string; index: number; end: string; start: Point; point: Point;
	pointer: number; revision: string; ready: Promise<WorkspaceState>; element?: Element; preview?: SVGLineElement; anchor?: Point;
}

export function startDirectEditing(core: WorkspaceCore, report: (error: unknown) => void): void
{
	const svg = document.getElementById('graph') as unknown as SVGSVGElement;
	let edit: Edit | undefined;
	const overlay = document.createElementNS(ns, 'g'); overlay.id = 'direct-layer';
	document.getElementById('camera')!.append(overlay);
	const endpointGroups = new Map<string, SVGGElement>();
	const world = (event: {clientX: number; clientY: number}): Point =>
	{
		const bounds = svg.getBoundingClientRect();
		const camera = window.gv!.camera;

		return {x: (event.clientX - bounds.left - camera.x) / camera.zoom, y: (event.clientY - bounds.top - camera.y) / camera.zoom};
	};
	const circle = (parent: Element, className: string): SVGCircleElement =>
	{
		const existing = parent.querySelector<SVGCircleElement>(`.${className}`);
		if (existing) return existing;

		const item = document.createElementNS(ns, 'circle');
		item.setAttribute('class', `direct-handle ${className}`);
		item.setAttribute('r', '6'); parent.append(item);

		return item;
	};
	const decorate = (changes?: {nodes: string[]; edges: string[]}): void =>
	{
		for (const [id, group] of endpointGroups)
			if (!window.gv!.objects.edges.get(id)?.visual.selected) {group.remove(); endpointGroups.delete(id);}

		const nodeEntries = changes ? changes.nodes.flatMap
		(
			(id): NodeEntry[] =>
			{
				const entry = window.gv!.objects.nodes.get(id) ?? window.gv!.objects.frames.get(id);

				return entry ? [entry] : [];
			}
		) : [...window.gv!.objects.frames.values(), ...window.gv!.objects.nodes.values()];
		for (const entry of nodeEntries)
		{
			const node = entry.visual.node;
			const handle = circle(entry.group, 'connect-handle');
			handle.setAttribute('cx', String(node.center.x + node.size.width / 2));
			handle.setAttribute('cy', String(node.center.y));
			handle.setAttribute('aria-label', '연결 만들기');
		}

		const edgeEntries = changes ? changes.edges.flatMap
		(
			(id): EdgeEntry[] =>
			{
				const entry = window.gv!.objects.edges.get(id);

				return entry ? [entry] : [];
			}
		) : [...window.gv!.objects.edges.values()];
		for (const entry of edgeEntries)
		{
			entry.group.dataset.selected = String(entry.visual.selected);
			entry.label.dataset.selected = String(entry.visual.selected);
			let group = endpointGroups.get(entry.visual.id);
			if (!group && entry.visual.selected)
			{
				group = document.createElementNS(ns, 'g');
				group.setAttribute('class', 'visual direct-edge-handles');
				group.dataset.id = entry.visual.id; group.dataset.kind = 'edge';
				overlay.append(group); endpointGroups.set(entry.visual.id, group);
			}

			for (const [end, point] of [['source', entry.visual.path[0]], ['target', entry.visual.path.at(-1)]] as const)
			{
				if (!group) continue;

				const handle = circle(group, `endpoint-${end}`);
				handle.dataset.end = end;
				handle.setAttribute('display', point && entry.visual.selected ? 'inline' : 'none');
				if (point) {handle.setAttribute('cx', String(point.x)); handle.setAttribute('cy', String(point.y));}
			}

			for (const [index, handle] of [...entry.group.querySelectorAll('.waypoints circle')].entries())
			{
				handle.setAttribute('data-waypoint-index', String(index));
				const point = entry.visual.waypoints[index];
				if (point) {handle.setAttribute('cx', String(point.x)); handle.setAttribute('cy', String(point.y));}
			}
		}
		if (document.getElementById('camera')!.lastElementChild !== overlay) document.getElementById('camera')!.append(overlay);
	};
	async function choose
	(
		state: WorkspaceState,
		source: string,
		target: string,
		revision: string
	): Promise<{source: string; target: string} | null>
	{
		const reply = await core.exchange({op: 'web_endpoints', ids: [source, target], expected_revision: revision});
		const candidates = reply.result.candidates as Record<string, string[]>;
		const sources = candidates[source];
		const targets = candidates[target];
		if (sources.length === 1 && targets.length === 1) return {source: sources[0], target: targets[0]};
		if (!sources.length || !targets.length) throw new Error('연결 가능한 내부 노드가 없습니다.');

		const dialog = document.createElement('dialog');
		dialog.className = 'endpoint-dialog';
		dialog.setAttribute('aria-label', '실제 연결할 내부 노드 선택');
		dialog.addEventListener('keydown', (event): void => {if (event.key === 'Escape') event.stopPropagation();});
		const form = document.createElement('form'); form.method = 'dialog';
		const title = document.createElement('h2'); title.textContent = '실제 연결할 내부 노드 선택'; form.append(title);
		const selects: HTMLSelectElement[] = [];
		for (const [label, ids] of [['시작 노드', sources], ['도착 노드', targets]] as const)
		{
			const field = document.createElement('label'); field.textContent = label;
			const select = document.createElement('select'); select.setAttribute('aria-label', label);
			for (const id of ids)
			{
				const node = state.nodes.find((node): boolean => node.id === id);
				select.add(new Option(`${node?.label || '노드'} · ${id}`, id));
			}
			field.append(select); form.append(field); selects.push(select);
		}

		for (const [text, value] of [['연결', 'connect'], ['취소', 'cancel']])
		{
			const button = document.createElement('button'); button.textContent = text; button.value = value; form.append(button);
		}
		dialog.append(form); document.body.append(dialog); dialog.showModal();
		document.body.dataset.directEditing = 'true';

		return new Promise
		(
			(resolve): void =>
			{
				dialog.addEventListener
				(
					'close',
					(): void =>
					{
						const result = dialog.returnValue === 'connect' ? {source: selects[0].value, target: selects[1].value} : null;
						dialog.remove(); resolve(result);
						document.body.dataset.directEditing = 'false';
					},
					{once: true}
				);
			}
		);
	}
	const cleanup = (): void =>
	{
		if (!edit) return;

		const current = edit;
		edit = undefined;
		document.body.dataset.directEditing = 'false';
		current.element?.removeAttribute('transform'); current.preview?.remove();
		if (svg.hasPointerCapture(current.pointer)) svg.releasePointerCapture(current.pointer);

		decorate();
	};
	const commit = async (current: Edit, event: PointerEvent): Promise<void> =>
	{
		const state = await current.ready;
		const edge = state.edges.find((edge): boolean => edge.id === current.id);
		let command: JsonObject;
		if (current.kind === 'label') command = {action: 'label_position', id: current.id,
			point: {x: current.anchor!.x + current.point.x - current.start.x, y: current.anchor!.y + current.point.y - current.start.y}};
		else if (current.kind === 'waypoint')
		{
			if (!edge) throw new Error('엣지가 더 이상 존재하지 않습니다.');

			const points = structuredClone(edge.waypoints); points[current.index] = current.point;
			command = {action: 'waypoints', id: current.id, points};
		}
		else
		{
			if (current.kind === 'reconnect' && !edge) throw new Error('엣지가 더 이상 존재하지 않습니다.');

			const target = document.elementsFromPoint(event.clientX, event.clientY)
				.map((item): Element | null => item.closest('.visual[data-kind="node"]')).find(Boolean) as HTMLElement | undefined;
			if (!target?.dataset.id) return;

			const source = current.kind === 'connect' ? current.id : current.end === 'source' ? target.dataset.id : edge!.source;
			const end = current.kind === 'connect' || current.end === 'target' ? target.dataset.id : edge!.target;
			const endpoints = await choose(state, source, end, current.revision);
			if (!endpoints) return;

			command = {action: current.kind === 'connect' ? 'connect' : 'reconnect', id: current.id, ...endpoints};
		}

		await core.exchange({op: 'web_edit', expected_revision: current.revision, ...command});
		await window.gv!.sync();
	};
	svg.addEventListener
	(
		'pointerdown',
		(event): void =>
		{
			if (event.button !== 0 || edit || window.gv!.editing) return;

			const target = event.target as Element;
			const group = target.closest<SVGElement>('.visual');
			const id = group?.dataset.id;
			if (!id) return;

			const kind = target.closest('.connect-handle') ? 'connect' : target.hasAttribute('data-waypoint-index') ? 'waypoint' :
				target.hasAttribute('data-end') ? 'reconnect' : group.classList.contains('edge-label') &&
				window.gv!.objects.edges.get(id)?.visual.selected ? 'label' : '';
			if (!kind) return;

			event.preventDefault(); event.stopImmediatePropagation();
			const point = world(event);
			const current: Edit = {kind, id, index: Number(target.getAttribute('data-waypoint-index')), end: target.getAttribute('data-end') ?? '',
				start: point, point, pointer: event.pointerId, revision: '', ready: Promise.resolve(null as unknown as WorkspaceState)};
			current.ready = flushStyles().then
			(
				async (): Promise<WorkspaceState> =>
				{
					const reply = await core.exchange({op: 'web_read'});
					current.revision = String(reply.result.document_revision);

					return reply.result.web as unknown as WorkspaceState;
				}
			);
			void current.ready.catch(report);
			if (kind === 'label') {current.element = group; current.anchor = {...window.gv!.objects.edges.get(id)!.visual.labelAnchor};}
			else if (kind === 'connect' || kind === 'reconnect')
			{
				const line = document.createElementNS(ns, 'line'); line.setAttribute('class', 'direct-preview');
				line.setAttribute('x1', String(point.x)); line.setAttribute('y1', String(point.y));
				line.setAttribute('x2', String(point.x)); line.setAttribute('y2', String(point.y));
				document.getElementById('camera')!.append(line); current.preview = line;
			}

			edit = current; document.body.dataset.directEditing = 'true'; svg.setPointerCapture(event.pointerId);
		},
		true
	);
	svg.addEventListener
	(
		'pointermove',
		(event): void =>
		{
			if (!edit || edit.pointer !== event.pointerId) return;

			event.preventDefault(); event.stopImmediatePropagation(); edit.point = world(event);
			edit.element?.setAttribute('transform', `translate(${edit.point.x - edit.start.x},${edit.point.y - edit.start.y})`);
			edit.preview?.setAttribute('x2', String(edit.point.x)); edit.preview?.setAttribute('y2', String(edit.point.y));
			if (edit.kind === 'waypoint')
			{
				const handle = window.gv!.objects.edges.get(edit.id)?.group.querySelector(`[data-waypoint-index="${edit.index}"]`);
				handle?.setAttribute('cx', String(edit.point.x)); handle?.setAttribute('cy', String(edit.point.y));
			}
		},
		true
	);
	svg.addEventListener
	(
		'pointerup',
		(event): void =>
		{
			if (!edit || edit.pointer !== event.pointerId) return;

			event.preventDefault(); event.stopImmediatePropagation();
			const current = edit; current.point = world(event);
			cleanup();
			if (Math.hypot(current.point.x - current.start.x, current.point.y - current.start.y) < 2 / window.gv!.camera.zoom) return;

			void commit(current, event).catch(report).finally(decorate);
		},
		true
	);
	for (const type of ['pointercancel', 'lostpointercapture'])
		svg.addEventListener(type, (): void => {cleanup();}, true);
	window.addEventListener('keydown', (event): void => {if (event.key === 'Escape') cleanup();}, true);
	window.addEventListener('blur', cleanup);
	window.addEventListener('gv-scene-change', (event): void =>
	{
		decorate((event as CustomEvent<{nodes: string[]; edges: string[]}>).detail);
	});
	window.addEventListener('gv-document-opened', cleanup);
	window.addEventListener('gv-cancel-direct', cleanup);
	const waypoint = async (event: MouseEvent, remove: boolean): Promise<void> =>
	{
		await flushStyles(); await window.gv!.sync();
		const target = event.target as Element;
		const id = target.closest<SVGElement>('.visual[data-kind="edge"]')?.dataset.id;
		const reply = await core.exchange({op: 'web_read'});
		const state = reply.result.web as unknown as WorkspaceState;
		const edge = state.edges.find((edge): boolean => edge.id === id);
		if (!edge) return;

		const points = structuredClone(edge.waypoints);
		if (remove) points.splice(Number(target.getAttribute('data-waypoint-index')), 1);
		else
		{
			const point = world(event);
			const source = state.nodes.find((node): boolean => node.id === edge.source)!.center;
			const end = state.nodes.find((node): boolean => node.id === edge.target)!.center;
			const path = [source, ...points, end];
			let index = 0;
			let best = Infinity;
			for (let segment = 0; segment < path.length - 1; ++segment)
			{
				const a = path[segment]; const b = path[segment + 1];
				const dx = b.x - a.x; const dy = b.y - a.y;
				const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
				const distance = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
				if (distance < best) {best = distance; index = segment;}
			}

			points.splice(index, 0, point);
		}

		await core.exchange({op: 'web_edit', action: 'waypoints', id, points, expected_revision: reply.result.document_revision});
		await window.gv!.sync();
	};
	svg.addEventListener('dblclick', (event): void =>
	{
		if (!(event.target as Element).closest('.wire')) return;

		event.preventDefault(); void waypoint(event, false).catch(report);
	});
	svg.addEventListener('contextmenu', (event): void =>
	{
		if (!(event.target as Element).hasAttribute('data-waypoint-index')) return;

		event.preventDefault(); void waypoint(event, true).catch(report);
	});
	decorate();
}
