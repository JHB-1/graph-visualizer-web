import {BrowserCore} from './transport.ts';
import {samples} from './samples.ts';
import {startPanels, selectTab, flushStyles} from './panels.ts';

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
document.documentElement.dataset.theme = localStorage.getItem('gv-theme') ??
	'dark';
document.getElementById('theme')!.onclick = (): void =>
{
	const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
	document.documentElement.dataset.theme = theme;
	localStorage.setItem('gv-theme', theme);
};

try
{
	const core = new BrowserCore();
	await core.exchange({op: 'create', changes: sample.changes, options: sample.options});
	window.graphTransport = core;
	await import('./renderer/app.ts');
	if (!window.gv?.ready) throw new Error('렌더러를 시작하지 못했습니다.');
	await startPanels(core, report);

	document.getElementById('engine-state')!.textContent = 'C++ 코어 · 브라우저 실행';
	document.getElementById('engine-state')!.classList.add('ready');
	for (const button of document.querySelectorAll<HTMLButtonElement>('[data-engine]')) button.disabled = false;
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
	(document.getElementById('avoid') as HTMLInputElement).checked = true;
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
