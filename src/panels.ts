import type {BrowserCore} from './transport.ts';
import type {JsonObject, Color} from './renderer/types.ts';

type Data = Record<string, unknown>;
interface State
{
	defaults: Data;
	canvas: Data;
	options: Data;
	nodes: Data[];
	edges: Data[];
	selected_nodes: string[];
	selected_edges: string[];
	theme_text: string;
	undo_limit: number;
	undo_count: number;
	fonts: Data;
	algorithm?: {summary: string; steps: {text: string}[]; found: boolean; negativeCycle: boolean; weight: number};
}
const labels: Record<string, string> =
{
	defaults: '기본 스타일', canvas: '캔버스', node: '노드', edge: '엣지', fill: '채우기', borderColor: '테두리 색',
	textColor: '텍스트 색', color: '선 색', borderWidth: '테두리 굵기', width: '너비', height: '높이', shape: '모양',
	fontFamily: '글꼴', fontSize: '글자 크기', fontBold: '굵게', fontItalic: '기울임', fontUnderline: '밑줄',
	fontStrikeOut: '취소선', padding: '안쪽 여백', left: '왼쪽', top: '위', right: '오른쪽', bottom: '아래',
	arrowLength: '화살표 길이', curveTension: '베지어 곡률', routing: '배선', nodeSize: '기본 노드 크기',
	subgraphSize: '기본 그룹 크기', subgraphPadding: '그룹 여백', nodeProfiles: '명명 노드 프로파일 (JSON)',
	edgeProfiles: '명명 엣지 프로파일 (JSON)', background: '배경', grid: '격자', selection: '선택 선',
	selectionFill: '선택 영역', highlight: '분석 강조', connectionTarget: '연결 대상', handleFill: '핸들',
	obstacleClearance: '장애물 여유', edgeClearance: '엣지 여유', minimumNodeGap: '최소 노드 간격',
	subgraphGap: '그룹 간격', allowParallelEdges: '중복 엣지 허용', parallelWiring: '평행 배선',
	parallelSpacing: '평행 간격', curveRadius: '최소 핸들 길이', gridOrigin: '격자 원점',
	label: '라벨', center: '중심 좌표', size: '크기', style: '개별 스타일', parent: '부모 그룹 ID',
	profile: '프로파일 ID', subgraph: '그룹', expanded: '펼침', source: '시작 노드 ID', target: '도착 노드 ID',
	direction: '방향', weight: '가중치', waypoints: '경유점 (JSON)', pathLocked: '경로 잠금', labelPosition: '라벨 좌표',
	embed: '폰트 포함 정책', missing: '누락 글꼴 정책', fallbackFamily: '대체 글꼴'
};
const enums: Record<string, string[]> =
{
	shape: ['원', '사각형'], routing: ['직선', '직각', '8방향', '베지어'], direction: ['무향', '유향'],
	missing: ['확인 요청', '대체', '거절']
};
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const record = (value: unknown): Data => value as Data;
const isRecord = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
let activeTab = 'edit';

export function selectTab(name: string | null): void
{
	document.body.classList.toggle('sidebar-collapsed', name === null);
	byId('sidebar-open').setAttribute('aria-expanded', String(name !== null));
	if (name === null) return;

	activeTab = name;
	for (const button of document.querySelectorAll<HTMLElement>('[data-tab]'))
	{
		const active = button.dataset.tab === name;
		button.setAttribute('aria-selected', String(active));
		button.tabIndex = active ? 0 : -1;
		byId(`panel-${button.dataset.tab}`).hidden = !active;
	}
}

// 코어 값과 별도 보관한 입력으로 폼 작성, 적용 전까지 문서 변경 없음
function fields(parent: HTMLElement, data: Data, template: Data = {}, prefix = ''): () => Data
{
	const readers: [string, () => unknown][] = [];
	for (const key of new Set([...Object.keys(data), ...Object.keys(template)]))
	{
		const stored = data[key];
		const fallback = key === 'weight' ? 0 : key === 'labelPosition' ? {x: 0, y: 0}
			: ['fill', 'borderColor', 'textColor', 'color'].includes(key) ? {r: 0, g: 0, b: 0, a: 255} : '';
		const value = stored ?? template[key] ?? fallback;
		const path = prefix ? `${prefix}.${key}` : key;
		if (isRecord(value) && !('r' in value))
		{
			const section = document.createElement('details');
			const summary = document.createElement('summary');
			summary.textContent = labels[key] ?? key;
			section.append(summary);
			const group = document.createElement('div');
			group.className = 'field-list';
			section.append(group);
			parent.append(section);
			const readGroup = fields(group, isRecord(stored) ? stored : value,
				isRecord(template[key]) ? template[key] : {}, path);
			if (stored === null || stored === undefined || key === 'labelPosition' || path === 'style.padding')
			{
				const inherit = document.createElement('input');
				inherit.type = 'checkbox'; inherit.checked = stored == null; inherit.dataset.inherit = path;
				const hint = document.createElement('label');
				hint.className = 'optional'; hint.append(inherit, document.createTextNode('상속 / 미지정'));
				section.insertBefore(hint, group);
				readers.push([key, (): unknown => inherit.checked ? null : readGroup()]);
			}
			else readers.push([key, readGroup]);
			continue;
		}

		const row = document.createElement('label');
		const title = document.createElement('span');
		title.textContent = labels[key] ?? key;
		row.append(title);
		let read: () => unknown;
		const controls: (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] = [];
		if (isRecord(value) && 'r' in value)
		{
			const color = value as unknown as Color;
			const group = document.createElement('span');
			group.className = 'color-control';
			const rgb = document.createElement('input');
			rgb.type = 'color';
			rgb.value = '#' + [color.r, color.g, color.b].map((channel): string => channel.toString(16).padStart(2, '0')).join('');
			rgb.setAttribute('aria-label', `${title.textContent} RGB`);
			rgb.dataset.field = path;
			const alpha = document.createElement('input');
			alpha.type = 'number'; alpha.min = '0'; alpha.max = '255'; alpha.step = '1'; alpha.value = String(color.a);
			alpha.setAttribute('aria-label', `${title.textContent} 알파 (0–255)`);
			alpha.dataset.field = path + '.a';
			group.append(rgb, alpha);
			row.append(group);
			controls.push(rgb, alpha);
			read = (): Color => ({r: parseInt(rgb.value.slice(1, 3), 16), g: parseInt(rgb.value.slice(3, 5), 16),
				b: parseInt(rgb.value.slice(5, 7), 16), a: Number(alpha.value)});
		}
		else if (Array.isArray(value))
		{
			row.className = 'wide-field';
			const input = document.createElement('textarea');
			input.rows = 4;
			input.value = JSON.stringify(value, null, '\t');
			input.dataset.field = path;
			row.append(input);
			controls.push(input);
			read = (): unknown => JSON.parse(input.value);
		}
		else
		{
			const choices = enums[key];
			const input = choices ? document.createElement('select') : document.createElement('input');
			if (input instanceof HTMLSelectElement)
			{
				for (const [index, text] of choices.entries()) input.add(new Option(text, String(index)));
				input.value = String(value ?? 0);
			}
			else
			{
				input.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text';
				input.step = 'any';
				input.value = String(value ?? '');
				input.checked = value === true;
			}

			input.dataset.field = path;
			row.append(input);
			controls.push(input);
			read = (): unknown => input instanceof HTMLSelectElement || typeof value === 'number' ? Number(input.value)
				: typeof value === 'boolean' ? (input as HTMLInputElement).checked : input.value;
		}

		if (stored === null || stored === undefined || prefix === 'style' ||
			['shape', 'routing', 'parent', 'profile', 'weight'].includes(key) && prefix === '')
		{
			const inherit = document.createElement('input');
			inherit.type = 'checkbox'; inherit.checked = stored == null;
			inherit.dataset.inherit = path;
			const hint = document.createElement('span');
			hint.className = 'optional'; hint.append(inherit, document.createTextNode('상속 / 미지정'));
			row.append(hint);
			const toggle = (): void => {for (const control of controls) control.disabled = inherit.checked;};
			inherit.onchange = toggle;
			toggle();
			const readValue = read;
			read = (): unknown => inherit.checked ? null : readValue();
		}

		readers.push([key, read]);
		parent.append(row);
	}

	return (): Data => Object.fromEntries(readers.map(([key, read]): [string, unknown] => [key, read()]));
}

function form(id: string, data: Data, submit: (value: Data) => Promise<void>, report: (error: unknown) => void,
	template: Data = {}): void
{
	const target = byId<HTMLFormElement>(id);
	const open = new Set([...target.querySelectorAll('details[open]')].map((node): string => node.querySelector('summary')!.textContent!));
	target.replaceChildren();
	const read = fields(target, data, template);
	for (const section of target.querySelectorAll('details')) section.open = open.has(section.querySelector('summary')!.textContent!);
	const apply = document.createElement('button');
	apply.textContent = '적용'; apply.type = 'submit'; apply.className = 'primary';
	target.append(apply);
	target.onsubmit = (event): void =>
	{
		event.preventDefault();
		try {void submit(read()).catch(report);}
		catch (error) {report(error);}
	};
}

export async function startPanels(core: BrowserCore, report: (error: unknown) => void): Promise<void>
{
	let state: State;
	let revision = '';
	let initialDefaults: Data;
	let initialCanvas: Data;
	let item: {kind: string; id: string} | null = null;
	let busy = false;
	let steps: {text: string}[] = [];
	const readReply = (reply: {result: Data}): State => reply.result.web as State;
	const run = async (action: string, value: Data = {}): Promise<State> =>
	{
		if (busy) throw new Error('이전 작업을 마친 뒤 다시 시도하세요.');

		busy = true;
		byId('error').textContent = '';
		try
		{
			const current = await core.exchange({op: 'status'});
			const reply = await core.exchange({op: 'web_edit', expected_revision: current.result.document_revision, action, ...value});
			state = readReply(reply);
			revision = String(reply.result.document_revision);
			render();

			return state;
		}
		finally {busy = false;}
	};
	const refresh = async (): Promise<void> =>
	{
		const reply = await core.exchange({op: 'web_read'});
		state = readReply(reply);
		revision = String(reply.result.document_revision);
		render();
	};
	const safe = (task: () => Promise<unknown>): void => {void task().catch(report);};
	const fillNodes = (id: string, optional = false): void =>
	{
		const select = byId<HTMLSelectElement>(id);
		const before = select.value;
		select.replaceChildren();
		if (optional) select.add(new Option('자동 / 없음', ''));
		for (const node of state.nodes) select.add(new Option(`${node.label || '노드'} · ${node.id}`, String(node.id)));
		if ([...select.options].some((option): boolean => option.value === before)) select.value = before;
	};
	const render = (): void =>
	{
		for (const id of ['connect-source', 'connect-target']) fillNodes(id);
		for (const id of ['algorithm-start', 'algorithm-target']) fillNodes(id, true);
		const picker = byId<HTMLSelectElement>('object-picker');
		picker.replaceChildren(new Option('선택 없음', ''));
		for (const [kind, objects] of [['node', state.nodes], ['edge', state.edges]] as const)
			for (const object of objects)
				picker.add
				(
					new Option(`${kind === 'node' ? '노드' : '엣지'} · ${object.label || object.id}`, `${kind}:${object.id}`)
				);

		byId('selection-count').textContent = String(state.selected_nodes.length + state.selected_edges.length);
		const selectedNodes = state.nodes.filter((node): boolean => state.selected_nodes.includes(String(node.id)));
		const canGroup = selectedNodes.length >= 2 && selectedNodes.every((node): boolean => node.parent === selectedNodes[0].parent);
		const groupButton = document.querySelector<HTMLButtonElement>('[data-command="group"]')!;
		groupButton.disabled = !canGroup;
		groupButton.title = canGroup ? '선택한 노드 묶기' : '같은 부모의 노드를 2개 이상 선택하세요.';
		if (!item || !(item.kind === 'node' ? state.selected_nodes : state.selected_edges).includes(item.id))
			item = state.selected_nodes.length ? {kind: 'node', id: state.selected_nodes[0]}
				: state.selected_edges.length ? {kind: 'edge', id: state.selected_edges[0]} : null;
		if (item && !(item.kind === 'node' ? state.nodes : state.edges).some((object): boolean => object.id === item!.id)) item = null;
		picker.value = item ? `${item.kind}:${item.id}` : '';
		const selectedObject = item && (item.kind === 'node' ? state.nodes : state.edges)
			.find((object): boolean => object.id === item!.id);
		for (const id of ['expand', 'scope', 'ungroup']) byId<HTMLButtonElement>(id).disabled = !selectedObject?.subgraph;
		byId<HTMLButtonElement>('reverse-edge').disabled = item?.kind !== 'edge';
		byId<HTMLButtonElement>('reset-style').disabled = !item;
		if (!item) byId('selection-form').replaceChildren();
		if (item)
		{
			const current = item;
			const source = (current.kind === 'node' ? state.nodes : state.edges).find((node): boolean => node.id === current.id)!;
			const {id: ignored, ...editable} = source;
			const style = record(state.defaults[current.kind]);
			const {shape: ignoredShape, routing: ignoredRouting, ...styleTemplate} = style;
			const template = {style: styleTemplate};
			form('selection-form', editable, async (value): Promise<void> =>
			{
				if (current.kind === 'edge')
				{
					value.path_locked = value.pathLocked; delete value.pathLocked;
					value.label_position = value.labelPosition; delete value.labelPosition;
				}

				await core.update({[current.kind === 'node' ? 'updated_nodes' : 'updated_edges']: [{id: current.id, ...value}]});
				await refresh();
			}, report, template);
		}

		form('theme-form', {node: state.defaults.node, edge: state.defaults.edge, nodeSize: state.defaults.nodeSize,
			subgraphSize: state.defaults.subgraphSize, subgraphPadding: state.defaults.subgraphPadding,
			canvas: state.canvas, nodeProfiles: state.defaults.nodeProfiles, edgeProfiles: state.defaults.edgeProfiles},
			async (value): Promise<void> =>
			{
				const {canvas, ...defaults} = value;
				await run('settings', {defaults, canvas});
			}, report);
		if (document.activeElement !== byId('theme-text')) byId<HTMLTextAreaElement>('theme-text').value = state.theme_text;
		form('font-form', state.fonts, async (value): Promise<void> => {await run('fonts', value);}, report);
		const {obstacleAvoidance, gridSnap, gridSpacing, ...advanced} = state.options;
		byId<HTMLInputElement>('avoid').checked = Boolean(obstacleAvoidance);
		form('options-form', advanced, async (value): Promise<void> =>
		{
			await window.gv!.enqueue({action: 'options', options: value});
			await refresh();
		}, report);
		byId<HTMLInputElement>('history-limit').value = String(state.undo_limit);
	};

	for (const tab of document.querySelectorAll<HTMLElement>('[data-tab]'))
	{
		tab.onclick = (): void => {selectTab(tab.dataset.tab!);};
		tab.onkeydown = (event): void =>
		{
			const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab]')];
			const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
			if (!direction) return;

			event.preventDefault();
			const next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
			selectTab(next.dataset.tab!); next.focus();
		};
	}

	byId('sidebar-close').onclick = (): void => {selectTab(null);};
	byId('sidebar-open').onclick = (): void => {selectTab(activeTab);};
	if (matchMedia('(max-width: 700px)').matches) selectTab(null);
	byId('show-grid').onchange = (): void =>
	{
		document.getElementById('grid-area')!.setAttribute('visibility', byId<HTMLInputElement>('show-grid').checked ? 'visible' : 'hidden');
	};
	for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]'))
		button.onclick = (): void => {safe(() => run(button.dataset.command!));};

	byId('object-picker').onchange = (): void =>
	{
		const value = byId<HTMLSelectElement>('object-picker').value;
		if (!value) {item = null; safe(() => run('clear_selection')); return;}

		const [kind, id] = value.split(':');
		safe(async (): Promise<void> =>
		{
			await window.gv!.enqueue({action: 'select', kind, id});
			await window.gv!.inspect(id, kind);
			await refresh();
		});
	};
	window.addEventListener('gv-selection', (event): void =>
	{
		item = (event as CustomEvent<{kind: string; id: string}>).detail;
		void refresh().catch((error: Error & {code?: string}): void => {if (error.code !== 'gesture_busy') report(error);});
	});
	byId('expand').onclick = (): void =>
	{
		const node = state.nodes.find((node): boolean => node.id === item?.id);
		if (node?.subgraph) safe(() => window.gv!.enqueue({action: 'expand', id: node.id, expanded: !node.expanded}));
	};
	byId('scope').onclick = (): void =>
	{
		const node = state.nodes.find((node): boolean => node.id === item?.id);
		if (node?.subgraph) safe(async (): Promise<void> => {await window.gv!.enqueue({action: 'scope', id: node.id}); window.gv!.fit();});
	};
	for (const [id, action] of [['ungroup', 'ungroup'], ['reset-style', 'reset_style'], ['reverse-edge', 'reverse']])
		byId(id).onclick = (): void =>
		{
			if (item) safe(() => run(action, {id: item!.id, kind: item!.kind}));
		};

	byId<HTMLFormElement>('connect-form').onsubmit = (event): void =>
	{
		event.preventDefault();
		safe(() => run('connect', {source: byId<HTMLSelectElement>('connect-source').value,
			target: byId<HTMLSelectElement>('connect-target').value, direction: Number(byId<HTMLSelectElement>('connect-direction').value),
			label: byId<HTMLInputElement>('connect-label').value}));
	};
	byId<HTMLFormElement>('history-form').onsubmit = (event): void =>
	{
		event.preventDefault(); safe(() => run('history_limit', {limit: Number(byId<HTMLInputElement>('history-limit').value)}));
	};
	byId<HTMLFormElement>('region-form').onsubmit = (event): void =>
	{
		event.preventDefault();
		const region = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) =>
			[key, Number(byId<HTMLInputElement>(`region-${key}`).value)]));
		safe(() => run('select_region', {region}));
	};
	byId('theme-apply').onclick = (): void => {safe(() => run('theme', {text: byId<HTMLTextAreaElement>('theme-text').value}));};
	byId('theme-export').onclick = (): void =>
	{
		safe(() => core.downloadFile('theme.gvtheme', new Blob([state.theme_text], {type: 'text/plain;charset=utf-8'})));
	};
	byId<HTMLInputElement>('theme-import').onchange = (): void =>
	{
		const file = byId<HTMLInputElement>('theme-import').files?.[0];
		if (!file) return;
		if (file.size > 1_048_576) {report(new Error('테마 파일은 1 MiB 이하여야 합니다.')); return;}

		safe(async (): Promise<void> => {await run('theme', {text: await file.text()});});
	};
	for (const name of ['core', 'light', 'dark'])
		byId(`preset-${name}`).onclick = (): void =>
		{
			const defaults = structuredClone(initialDefaults);
			const canvas = structuredClone(initialCanvas);
			defaults.nodeProfiles = structuredClone(state.defaults.nodeProfiles);
			defaults.edgeProfiles = structuredClone(state.defaults.edgeProfiles);
			if (name !== 'core')
			{
				const dark = name === 'dark';
				const rgb = (r: number, g: number, b: number): Color => ({r, g, b, a: 255});
				Object.assign(record(defaults.node), {fill: dark ? rgb(35, 45, 63) : rgb(255, 255, 255),
					borderColor: dark ? rgb(111, 133, 173) : rgb(133, 151, 185), textColor: dark ? rgb(229, 237, 248) : rgb(37, 48, 69)});
				Object.assign(record(defaults.edge), {color: dark ? rgb(136, 161, 210) : rgb(91, 118, 166), textColor: null});
				Object.assign(canvas, {background: dark ? rgb(19, 23, 32) : rgb(245, 247, 251),
					grid: dark ? rgb(34, 42, 56) : rgb(225, 230, 239)});
			}

			safe(() => run('settings', {defaults, canvas}));
		};
	byId('batch-apply').onclick = (): void =>
	{
		safe(async (): Promise<void> => {await core.update(JSON.parse(byId<HTMLTextAreaElement>('batch-text').value)); await refresh();});
	};
	byId<HTMLFormElement>('algorithm-form').onsubmit = (event): void =>
	{
		event.preventDefault();
		safe(async (): Promise<void> =>
		{
			const result = await run('algorithm', {kind: Number(byId<HTMLSelectElement>('algorithm-kind').value),
				start: byId<HTMLSelectElement>('algorithm-start').value || null, target: byId<HTMLSelectElement>('algorithm-target').value || null});
			steps = result.algorithm!.steps;
			byId('algorithm-result').textContent = result.algorithm!.summary;
			const slider = byId<HTMLInputElement>('algorithm-step');
			slider.max = String(Math.max(0, steps.length - 1)); slider.value = '0'; slider.disabled = !steps.length;
			byId('algorithm-description').textContent = steps[0]?.text ?? '';
		});
	};
	byId('algorithm-step').onchange = (): void =>
	{
		const step = Number(byId<HTMLInputElement>('algorithm-step').value);
		byId('algorithm-description').textContent = steps[step]?.text ?? '';
		safe(() => run('algorithm_step', {step}));
	};
	await refresh();
	initialDefaults = structuredClone(state!.defaults);
	initialCanvas = structuredClone(state!.canvas);
	setInterval
	(
		(): void =>
		{
			if (busy || !window.gv?.ready || revision === window.gv.documentRevision ||
				document.activeElement?.closest('form, textarea')) return;

			void refresh().catch((error: Error & {code?: string}): void => {if (error.code !== 'gesture_busy') report(error);});
		},
		400
	);
}
