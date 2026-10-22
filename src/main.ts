import {BrowserCore} from './transport.ts';
import {samples} from './samples.ts';
import {startPanels, selectTab, flushStyles} from './panels.ts';
import {readyDefaultFont} from './renderer/font.ts';
import {startDocuments} from './documents.ts';
import {startExplorer} from './explorer.ts';
import {startDirectEditing} from './direct-edit.ts';
import {startCommands} from './commands.ts';
import {startWebUpdates} from './updates.ts';

const report = (error: unknown): void =>
{
	document.getElementById('error')!.textContent = error instanceof Error ? error.message : String(error);
};
const parameters = new URLSearchParams(location.search);
const key = Object.hasOwn(samples, parameters.get('sample') ?? '') ? parameters.get('sample')! : 'workflow';
const sample = samples[key];
const selection = document.getElementById('sample') as HTMLSelectElement;
selection.value = key;
document.getElementById('sample-description')!.textContent = sample.description;
selection.onchange = (): void =>
{
	const url = new URL(location.href);
	url.searchParams.set('sample', selection.value);
	location.assign(url);
};
let preferredTheme = window.graphWorkspace ? document.documentElement.dataset.theme : 'dark';
try {preferredTheme = localStorage.getItem('gv-theme') ?? preferredTheme;}
catch { /* 샌드박스에서는 호스트 밝기 유지 */ }

document.documentElement.dataset.theme = preferredTheme ?? 'dark';
document.getElementById('theme')!.onclick = (): void =>
{
	const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
	document.documentElement.dataset.theme = theme;
	try {localStorage.setItem('gv-theme', theme);}
	catch { /* 현재 뷰 밝기는 유지 */ }
};

try
{
	const host = window.graphWorkspace;
	const core = host?.core ?? new BrowserCore();
	await readyDefaultFont();
	if (!host) await core.exchange({op: 'create', changes: sample.changes, options: sample.options});
	window.graphTransport = core;
	await import('./renderer/app.ts');
	if (!window.gv?.ready) throw new Error('렌더러를 시작하지 못했습니다.');
	await startPanels(core, report);
	await startDocuments(core, report, host?.name ?? sample.name);
	await startExplorer(core, report);
	startDirectEditing(core, report);
	startCommands(core, report);
	startWebUpdates(core);

	document.getElementById('engine-state')!.textContent = host?.status ?? 'C++ 코어 · 브라우저 실행';
	document.getElementById('engine-state')!.classList.add('ready');
	for (const button of document.querySelectorAll<HTMLButtonElement>('[data-engine]')) button.disabled = false;
	if (host)
	{
		selection.disabled = true;
		document.getElementById('sample-description')!.textContent = host.name;
		document.getElementById('update-data')!.hidden = true;
	}
	document.getElementById('zoom-in')!.onclick = (): void => {window.gv?.zoomBy(1.3);};
	document.getElementById('zoom-out')!.onclick = (): void => {window.gv?.zoomBy(1 / 1.3);};
	let updates = 0;
	let nextID = 1000n;
	let changing = false;
	const action = async (operation: () => Promise<void>): Promise<void> =>
	{
		if (changing) return;

		changing = true;
		document.getElementById('error')!.textContent = '';
		try {await flushStyles(); await operation();}
		catch (error) {report(error);}
		finally {changing = false;}
	};
	document.getElementById('update-data')!.onclick = (): void =>
	{
		void action(async (): Promise<void> =>
		{
			updates += 1;
			await core.update({updated_nodes: [{id: '2', label: `수신 ${updates}`} ]});
			await core.exchange({op: 'ui', action: 'active', kind: 'edge', id: '1', active: true});
			setTimeout
			(
				(): void => {void core.exchange({op: 'ui', action: 'active', kind: 'edge', id: '1', active: false}).catch(report);},
				250
			);
		});
	};
	document.getElementById('add-node')!.onclick = (): void =>
	{
		void action(async (): Promise<void> =>
		{
			const current = await core.exchange({op: 'web_read'});
			const state = current.result.web as {defaults: {nodeSize: {width: number; height: number}};
				nodes: {id: string}[]; edges: {id: string}[]};
			const ids = new Set([...state.nodes, ...state.edges].map((item): string => item.id));
			while (ids.has(String(nextID))) nextID += 1n;

			const id = String(nextID++);
			const defaults = state.defaults;
			await core.update({added_nodes: [{id, label: `노드 ${id}`, shape: null, size: defaults.nodeSize,
				center: {x: (Number(nextID % 4n) - 2) * 200, y: 240 + Number(nextID % 2n) * 110}}],
				added_edges: state.nodes.some((node): boolean => node.id === '2')
					? [{id, source: '2', target: id, label: '추가', routing: null}] : []});
		});
	};
	(document.getElementById('routing') as HTMLSelectElement).onchange = (event): void =>
	{
		const routing = Number((event.target as HTMLSelectElement).value);
		void action(async (): Promise<void> =>
		{
			const reply = await core.request('query', {kind: 'edges', limit: 500});
			await core.update({updated_edges: (reply.items as {id: string}[]).map((edge) => ({id: edge.id, routing}))});
		});
	};
	const options = (await core.exchange({op: 'status'})).result.options as {obstacleAvoidance: boolean};
	(document.getElementById('avoid') as HTMLInputElement).checked = options.obstacleAvoidance;
	document.getElementById('avoid')!.onchange = (event): void =>
	{
		void window.gv!.enqueue({action: 'options', options: {obstacleAvoidance: (event.target as HTMLInputElement).checked}}).catch(report);
	};
	window.addEventListener('resize', (): void => {window.gv?.fit();});
	window.addEventListener('keydown', (event): void =>
	{
		if (event.key === 'Escape') selectTab(null);
	});
}
catch (error)
{
	document.getElementById('engine-state')!.textContent = '실행 실패';
	report(error);
}
