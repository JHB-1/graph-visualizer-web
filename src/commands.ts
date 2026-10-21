import type {BrowserCore} from './transport.ts';
import {readWorkspace} from './explorer.ts';
import {flushStyles, selectTab} from './panels.ts';

export function startCommands(core: BrowserCore, report: (error: unknown) => void): void
{
	let operations: Promise<void> = Promise.resolve();
	let generation = 0;
	window.addEventListener('gv-document-opened', (): void => {generation += 1;});
	const enqueue = (operation: () => Promise<void>): Promise<void> =>
	{
		const expectedGeneration = generation;
		const task = operations.then
		(
			async (): Promise<void> =>
			{
				if (generation !== expectedGeneration) return;

				await operation();
			}
		);
		operations = task.catch((): void => {});

		return task;
	};
	const perform = (action: string): Promise<void> => enqueue
	(
		async (): Promise<void> =>
		{
			await flushStyles(); await window.gv!.sync();
			if (action === 'undo' || action === 'redo') await window.gv!.enqueue({action});
			else
			{
				const current = await core.exchange({op: 'status'});
				await core.exchange({op: 'web_edit', action, expected_revision: current.result.document_revision});
			}

			await window.gv!.sync();
		}
	);
	window.addEventListener('keydown', (event): void =>
	{
		if (event.defaultPrevented || event.isComposing) return;

		const target = event.target as HTMLElement;
		if (target.closest('dialog')) return;

		const typing = target.closest('input, textarea, select, [contenteditable=true]');
		const command = event.ctrlKey || event.metaKey;
		const key = event.key.toLowerCase();
		if (command && !event.altKey && ['s', 'o', 'f'].includes(key))
		{
			event.preventDefault();
			if (window.gv!.editing) return;

			if (key === 's') document.getElementById('export-graph')!.click();
			else if (key === 'o') (document.getElementById('document-open') as HTMLInputElement).click();
			else {selectTab('items'); document.getElementById('item-search')!.focus();}

			return;
		}
		if (typing || target.closest('dialog') || window.gv!.editing) return;

		let action = '';
		if (command && key === 'z') action = event.shiftKey ? 'redo' : 'undo';
		else if (command && key === 'y') action = 'redo';
		else if (command && key === 'a') action = 'select_all';
		else if (command && key === 'c') action = 'copy';
		else if (command && key === 'v') action = 'paste';
		else if (command && key === 'd') action = 'duplicate';
		else if (key === 'delete' || key === 'backspace') action = 'delete';
		if (action)
		{
			event.preventDefault(); void perform(action).catch(report);

			return;
		}
		if ((key === 'enter' || key === ' ') && target.closest('.visual') && !target.closest('.disclosure'))
		{
			event.preventDefault();
			const group = target.closest<SVGElement>('.visual')!;
			void window.gv!.enqueue({action: 'select', kind: group.dataset.kind, id: group.dataset.id}).then
			(
				async (): Promise<void> => {await window.gv!.inspect(group.dataset.id!, group.dataset.kind!);}
			).catch(report);

			return;
		}
		if (!command && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && target.closest('#graph'))
		{
			event.preventDefault();
			void enqueue(async (): Promise<void> =>
			{
				await flushStyles();
				const state = await readWorkspace(core);
				const step = (state.options.gridSnap ? state.options.gridSpacing : 1) * (event.shiftKey ? 10 : 1);
				const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
				const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
				if (!state.selected_nodes.length) return;

				const current = await core.exchange({op: 'status'});
				await core.exchange({op: 'web_edit', action: 'nudge', offset: {x: dx, y: dy},
					expected_revision: current.result.document_revision});
				await window.gv!.sync();
			}).catch(report);
		}
	});
}
