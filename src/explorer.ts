import type {BrowserCore} from './transport.ts';
import type {Node, Point} from './renderer/types.ts';
import {flushStyles} from './panels.ts';

export interface DocumentEdge
{
	id: string; source: string; target: string; label: string; waypoints: Point[];
}
export interface WorkspaceState
{
	nodes: Node[];
	edges: DocumentEdge[];
	scope: string | null;
	selected_nodes: string[];
	selected_edges: string[];
	options: {gridSnap: boolean; gridSpacing: number};
}
interface View {scope: string | null; camera: {x: number; y: number; zoom: number}}
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export async function readWorkspace(core: BrowserCore): Promise<WorkspaceState>
{
	return (await core.exchange({op: 'web_read'})).result.web as unknown as WorkspaceState;
}

export async function startExplorer(core: BrowserCore, report: (error: unknown) => void): Promise<void>
{
	let state = await readWorkspace(core);
	let limit = 200;
	let refreshing = false;
	let repeat = false;
	let history: View[] = [];
	let historyIndex = -1;
	const bookmarks = new Map<string, View>();
	const rows = new Map<string, HTMLElement>();
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const current = (): View => ({scope: state.scope, camera: {...window.gv!.camera}});
	const remember = (): void =>
	{
		const view = current();
		if (JSON.stringify(history[historyIndex]) === JSON.stringify(view)) return;

		history = history.slice(0, historyIndex + 1);
		history.push(view);
		if (history.length > 100) history.shift();

		historyIndex = history.length - 1;
	};
	const restore = async (view: View): Promise<void> =>
	{
		await flushStyles();
		await window.gv!.enqueue({action: 'scope', id: view.scope});
		window.gv!.setView(view.camera);
		state = await readWorkspace(core);
		render();
	};
	const locate = async (kind: string, id: string): Promise<void> =>
	{
		await flushStyles();
		state = await readWorkspace(core);
		remember();
		const gv = window.gv!;
		if (kind === 'node')
		{
			const node = state.nodes.find((node): boolean => node.id === id);
			if (!node) throw new Error('항목이 더 이상 존재하지 않습니다.');
			if (!gv.objects.nodes.has(id) && !gv.objects.frames.has(id)) await gv.enqueue({action: 'scope', id: node.parent});

			await gv.enqueue({action: 'select', kind, id});
			gv.fit([id]);
		}
		else
		{
			const edge = state.edges.find((edge): boolean => edge.id === id);
			if (!edge) throw new Error('항목이 더 이상 존재하지 않습니다.');
			if (!gv.objects.edges.has(id))
			{
				const parents = (nodeId: string): (string | null)[] =>
				{
					const result: (string | null)[] = [];
					let parent = state.nodes.find((node): boolean => node.id === nodeId)?.parent ?? null;
					while (parent !== null)
					{
						result.push(parent);
						parent = state.nodes.find((node): boolean => node.id === parent)?.parent ?? null;
					}
					result.push(null);

					return result;
				};
				const targets = new Set(parents(edge.target));
				const scope = parents(edge.source).find((parent): boolean => targets.has(parent)) ?? null;
				await gv.enqueue({action: 'scope', id: scope});
			}

			await gv.enqueue({action: 'select', kind, id});
			const visual = gv.objects.edges.get(id)?.visual;
			gv.fit(visual ? [visual.source, visual.target] : []);
		}

		await gv.inspect(id, kind);
		state = await readWorkspace(core);
		remember();
		render();
	};
	const safe = (operation: () => Promise<unknown>): void =>
	{
		void operation().catch((error: Error & {code?: string}): void => {if (error.code !== 'gesture_busy') report(error);});
	};
	const row = (label: string, kind: string, id: string, depth = 0): HTMLElement =>
	{
		const key = `${kind}:${id}`;
		let item = rows.get(key);
		if (!item)
		{
			item = document.createElement('div');
			item.className = 'item-row'; item.dataset.id = id; item.dataset.kind = kind;
			const button = document.createElement('button');
			button.onclick = (): void =>
			{
				safe(async (): Promise<void> =>
				{
					await flushStyles();
					await window.gv!.enqueue({action: 'select', kind, id});
					await window.gv!.inspect(id, kind);
					await refresh();
				});
			};
			const move = document.createElement('button'); move.textContent = '이동';
			move.onclick = (): void => {safe(() => locate(kind, id));};
			item.append(button, move); rows.set(key, item);
		}

		item.style.setProperty('--item-depth', String(Math.min(depth, 8)));
		const button = item.children[0] as HTMLButtonElement;
		if (button.textContent !== label) button.textContent = label;

		button.title = `${label} · ID ${id}`;
		button.setAttribute('aria-label', `선택: ${label}, ID ${id}`);
		button.setAttribute('aria-pressed', String((kind === 'node' ? state.selected_nodes : state.selected_edges).includes(id)));
		item.children[1].setAttribute('aria-label', `위치 찾기: ${label}, ID ${id}`);

		return item;
	};
	const render = (): void =>
	{
		const query = byId<HTMLInputElement>('item-search').value.trim().toLocaleLowerCase();
		const kind = byId<HTMLSelectElement>('item-kind').value;
		const matches = (item: {id: string; label: string}): boolean =>
			!query || item.id.includes(query) || item.label.toLocaleLowerCase().includes(query);
		const list = byId('item-list');
		const wanted: HTMLElement[] = [];
		let count = 0;
		const children = new Map<string | null, Node[]>();
		for (const node of state.nodes)
		{
			if (!children.has(node.parent)) children.set(node.parent, []);

			children.get(node.parent)!.push(node);
		}

		const stack = (children.get(null) ?? []).map((node): {node: Node; depth: number} => ({node, depth: 0})).reverse();
		while (stack.length)
		{
			const {node, depth} = stack.pop()!;
			if (kind !== 'edge' && matches(node))
			{
				if (++count <= limit) wanted.push(row(`${node.subgraph ? '▸ ' : ''}${node.label || '노드'} · ${node.id}`, 'node', node.id, depth));
			}

			stack.push(...(children.get(node.id) ?? []).map((node): {node: Node; depth: number} => ({node, depth: depth + 1})).reverse());
		}

		for (const edge of state.edges)
			if (kind !== 'node' && matches(edge))
				if (++count <= limit) wanted.push(row(`${edge.label || `${edge.source} → ${edge.target}`} · ${edge.id}`, 'edge', edge.id));

		byId('item-count').textContent = `${count}개 항목${count > limit ? ` · ${limit}개 표시` : ''}`;
		if (count > limit)
		{
			const more = document.createElement('button');
			more.textContent = '더 보기'; more.onclick = (): void => {limit += 200; render();};
			wanted.push(more);
		}
		for (const child of [...list.children])
			if (!wanted.includes(child as HTMLElement)) child.remove();

		for (const [index, child] of wanted.entries())
			if (list.children[index] !== child) list.insertBefore(child, list.children[index] ?? null);

		for (const [key, item] of rows)
			if (!wanted.includes(item)) rows.delete(key);

		const scope = state.nodes.find((node): boolean => node.id === state.scope);
		byId('scope-path').textContent = scope ? `현재 범위: ${scope.label || scope.id}` : '현재 범위: 최상위';
		byId<HTMLButtonElement>('view-back').disabled = historyIndex <= 0;
		byId<HTMLButtonElement>('view-forward').disabled = historyIndex >= history.length - 1;
	};
	const refresh = async (): Promise<void> =>
	{
		if (refreshing) {repeat = true; return;}

		refreshing = true;
		try
		{
			do {repeat = false; state = await readWorkspace(core); render();} while (repeat);
		}
		finally {refreshing = false;}
	};
	byId('item-search').oninput = (): void => {limit = 200; render();};
	byId('item-kind').onchange = (): void => {limit = 200; render();};
	for (const [id, delta] of [['view-back', -1], ['view-forward', 1]] as const)
		byId(id).onclick = (): void =>
		{
			const index = historyIndex + delta;
			if (index < 0 || history.length <= index) return;

			safe(async (): Promise<void> => {await restore(history[index]); historyIndex = index; render();});
		};
	byId('fit-selection').onclick = (): void =>
	{
		safe(async (): Promise<void> =>
		{
			state = await readWorkspace(core);
			const ids = [...state.selected_nodes];
			for (const id of state.selected_edges)
			{
				const edge = window.gv!.objects.edges.get(id)?.visual;
				if (edge) ids.push(edge.source, edge.target);
			}

			if (!ids.length) throw new Error('먼저 항목을 선택하세요.');

			remember(); window.gv!.fit(ids); remember(); render();
		});
	};
	byId('bookmark-add').onclick = (): void =>
	{
		safe(async (): Promise<void> =>
		{
			const name = byId<HTMLInputElement>('bookmark-name').value.trim();
			if (!name) throw new Error('북마크 이름을 입력하세요.');

			state = await readWorkspace(core);
			bookmarks.set(name, current());
			const list = byId('bookmark-list');
			list.replaceChildren();
			for (const [label, view] of bookmarks)
			{
				const item = document.createElement('div'); item.className = 'item-row';
				const open = document.createElement('button'); open.textContent = label;
				open.onclick = (): void => {safe(async (): Promise<void> => {remember(); await restore(view); remember(); render();});};
				const remove = document.createElement('button'); remove.textContent = '삭제';
				remove.onclick = (): void => {bookmarks.delete(label); item.remove();};
				item.append(open, remove); list.append(item);
			}
		});
	};
	const scheduleRefresh = (): void =>
	{
		if (refreshTimer !== undefined) return;

		refreshTimer = setTimeout
		(
			(): void =>
			{
				refreshTimer = undefined;
				if (window.gv!.editing) {scheduleRefresh(); return;}

				safe(refresh);
			},
			120
		);
	};
	window.addEventListener('gv-scene-change', (event): void =>
	{
		const changes = (event as CustomEvent<{nodes: string[]; edges: string[]; visibilityChanged: boolean}>).detail;
		if (!changes || changes.visibilityChanged) {scheduleRefresh(); return;}

		const gv = window.gv!;
		if (changes.nodes.some((id): boolean =>
			Boolean((gv.objects.nodes.get(id) ?? gv.objects.frames.get(id))?.visual.selected) !== state.selected_nodes.includes(id)) ||
			changes.edges.some((id): boolean => Boolean(gv.objects.edges.get(id)?.visual.selected) !== state.selected_edges.includes(id)))
			scheduleRefresh();
	});
	window.addEventListener('gv-document-change', scheduleRefresh);
	window.addEventListener('gv-document-opened', (): void =>
	{
		history = []; historyIndex = -1; bookmarks.clear(); byId('bookmark-list').replaceChildren();
		rows.clear();
		safe(async (): Promise<void> => {await refresh(); remember(); render();});
	});
	window.addEventListener('gv-locate', (event): void =>
	{
		const {kind, id} = (event as CustomEvent<{kind: string; id: string}>).detail;
		safe(() => locate(kind, id));
	});
	remember(); render();
}
