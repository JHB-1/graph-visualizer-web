import type {WorkspaceCore} from './transport.ts';
import type {JsonObject} from './renderer/types.ts';
import {Drafts, type Draft} from './drafts.ts';
import {flushStyles, selectTab} from './panels.ts';

const maximumFileBytes = 1_048_576;
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function checkFile(value: unknown): JsonObject
{
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('그래프 JSON 객체가 필요합니다.');

	const file = value as JsonObject;
	if (file.format !== 'graph-visualizer' || file.version !== 1 || !file.document || typeof file.document !== 'object')
		throw new Error('지원하지 않는 그래프 파일 형식/버전입니다.');

	const pending = [{value, depth: 0}];
	while (pending.length)
	{
		const current = pending.pop()!;
		if (current.depth > 128) throw new Error('JSON 중첩이 너무 깊습니다.');
		if (typeof current.value === 'number' && !Number.isFinite(current.value)) throw new Error('숫자는 유한 값이어야 합니다.');
		if (current.value && typeof current.value === 'object')
			for (const child of Object.values(current.value)) pending.push({value: child, depth: current.depth + 1});
	}

	if (new TextEncoder().encode(JSON.stringify(file)).length > maximumFileBytes)
		throw new Error('그래프 파일은 1 MiB 이하여야 합니다.');

	return file;
}

export async function startDocuments(core: WorkspaceCore, report: (error: unknown) => void, initialName = '새 문서'): Promise<void>
{
	const drafts = window.graphWorkspace?.drafts ?? new Drafts();
	const storageHint = window.graphWorkspace?.drafts ? '변경 시 이 기기에 자동 저장됩니다.' : '변경 시 브라우저에 자동 저장됩니다.';
	const checkpointFile = async (): Promise<JsonObject> =>
		(await core.exchange({op: 'web_checkpoint'})).result.file as JsonObject;
	const initial = await checkpointFile();
	const empty = structuredClone(initial);
	(empty.document as JsonObject).nodes = [];
	(empty.document as JsonObject).edges = [];
	let baseline = JSON.stringify(initial.document);
	let latest = baseline;
	let name = initialName;
	let enabled = true;
	let candidate: Draft | undefined;
	let replacing = false;
	let pending = false;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let storageReady = false;
	let updatingAutosave = false;
	let allowLeave = false;
	let saving: Promise<void> = Promise.resolve();
	let storageState = storageHint;
	try {enabled = sessionStorage.getItem('gv-autosave') !== 'off';}
	catch {storageState = '브라우저 설정 저장을 사용할 수 없습니다.';}

	const dirty = (): boolean => latest !== baseline;
	const render = (): void =>
	{
		byId('document-name').textContent = name;
		byId('document-state').textContent = dirty() ? '미저장 변경' : '미저장 변경 없음';
		byId('save-indicator').textContent = dirty() ? '· 미저장' : '';
		byId('autosave-state').textContent = updatingAutosave ? '자동 저장 설정 중…' : enabled ? storageState :
			storageReady ? '자동 저장 꺼짐' : '자동 저장 꺼짐 · 복구 저장소에 접근할 수 없습니다.';
		byId<HTMLInputElement>('autosave').checked = enabled;
		byId('recovery-prompt').hidden = !candidate;
		document.title = `${dirty() ? '● ' : ''}${name} · Graph Visualizer`;
	};
	const collect = async (): Promise<void> =>
	{
		if (window.gv!.editing) {schedule(); return;}
		if (pending) {again = true; return saving;}

		pending = true;
		try
		{
			do
			{
				again = false;
				const file = await checkpointFile();
				latest = JSON.stringify(file.document);
				render();
				if (!enabled || !storageReady || candidate || replacing) continue;

				checkFile(file);
				storageState = '저장 중…';
				render();
				await drafts.save({name, file, dirty: dirty()});
				storageState = window.graphWorkspace?.drafts ? '이 기기에 저장됨' : '브라우저에 저장됨';
			}
			while (again);
		}
		catch (error)
		{
			storageState = `자동 저장 실패: ${error instanceof Error ? error.message : String(error)}`;
		}
		finally {pending = false; render();}
	};
	const schedule = (): void =>
	{
		if (timer !== undefined) return;

		timer = setTimeout
		(
			(): void => {timer = undefined; saving = collect();},
			400
		);
	};
	const confirmReplace = async (): Promise<boolean> =>
	{
		await flushStyles();
		await window.gv!.sync();
		latest = JSON.stringify((await checkpointFile()).document);
		render();

		return !dirty() || confirm('미저장 변경이 있습니다. 현재 문서를 바꿀까요?');
	};
	const replace = async (file: JsonObject, title: string, recovered = false): Promise<void> =>
	{
		if (replacing) throw new Error('문서를 여는 중입니다.');
		if (window.gv!.editing) throw new Error('편집을 마친 뒤 문서를 여세요.');

		replacing = true;
		let accepted = false;
		const shell = document.querySelector<HTMLElement>('.app-shell')!;
		try
		{
			checkFile(file);
			await core.exchange({op: 'web_validate', file});
			if (!await confirmReplace()) return;

			shell.inert = true;
			await saving;
			const current = await core.exchange({op: 'status'});
			await core.exchange({op: 'web_open', file, expected_revision: current.result.document_revision});
			await window.gv!.sync();
			latest = JSON.stringify((await checkpointFile()).document);
			baseline = recovered ? '' : latest;
			name = title;
			candidate = undefined;
			byId('error').textContent = '';
			window.dispatchEvent(new Event('gv-document-opened'));
			window.gv!.fit();
			storageState = storageHint;
			accepted = true;
		}
		finally
		{
			shell.inert = false;
			replacing = false;
			render();
			if (accepted || dirty()) schedule();
		}
	};
	const open = async (file: File): Promise<void> =>
	{
		if (file.size > maximumFileBytes) throw new Error('그래프 파일은 1 MiB 이하여야 합니다.');

		const parsed = checkFile(JSON.parse(await file.text()));
		await replace(parsed, file.name);
	};
	const safe = (operation: () => Promise<void>): void => {void operation().catch(report);};
	window.addEventListener('gv-document-change', schedule);
	window.addEventListener('pageshow', (event): void =>
	{
		if (!event.persisted) return;

		safe(async (): Promise<void> => {await drafts.open(); storageReady = true; schedule();});
	});
	window.addEventListener('gv-document-saved', (event): void =>
	{
		const file = (event as CustomEvent<JsonObject>).detail;
		baseline = JSON.stringify(file.document);
		render(); schedule();
	});
	window.addEventListener('beforeunload', (event): void =>
	{
		if (!allowLeave && (dirty() || timer !== undefined || pending || window.gv!.editing))
		{
			event.preventDefault();
			event.returnValue = '';
		}
	});
	byId('document-new').onclick = (): void => {safe(() => replace(empty, '새 문서'));};
	byId<HTMLInputElement>('document-open').onchange = (event): void =>
	{
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) safe(() => open(file));
	};
	document.addEventListener('dragover', (event): void =>
	{
		if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
	});
	document.addEventListener('drop', (event): void =>
	{
		if (!event.dataTransfer?.files.length) return;

		event.preventDefault();
		if (event.dataTransfer.files.length !== 1) {report(new Error('그래프 파일을 하나씩 여세요.')); return;}

		safe(() => open(event.dataTransfer!.files[0]));
	});
	byId('recovery-restore').onclick = (): void =>
	{
		const draft = candidate;
		if (draft) safe(() => replace(checkFile(draft.file), draft.name, draft.dirty));
	};
	byId('recovery-discard').onclick = (): void =>
	{
		safe(async (): Promise<void> =>
		{
			if (candidate?.id === drafts.id) await drafts.remove();

			candidate = undefined;
			render();
			if (dirty()) schedule();
		});
	};
	byId('autosave').onchange = (): void =>
	{
		enabled = byId<HTMLInputElement>('autosave').checked;
		updatingAutosave = true;
		render();
		safe(async (): Promise<void> =>
		{
			try
			{
				try {sessionStorage.setItem('gv-autosave', enabled ? 'on' : 'off');}
				catch { /* 현재 탭의 자동 저장 설정은 유지 */ }

				await saving;
				if (!enabled) {await drafts.remove(); candidate = undefined;}
				else schedule();

			}
			finally {updatingAutosave = false; render();}
		});
	};
	byId('draft-clear').onclick = (): void =>
	{
		if (!confirm('이 제품의 로컬 복구 기록을 지울까요? 현재 문서는 유지됩니다.')) return;

		safe(async (): Promise<void> =>
		{
			if (timer !== undefined) {clearTimeout(timer); timer = undefined;}

			await saving;
			await drafts.clear();
			candidate = undefined;
			storageState = '로컬 기록을 지웠습니다. 다음 변경부터 다시 저장됩니다.';
			render();
		});
	};
	const sample = byId<HTMLSelectElement>('sample');
	sample.onchange = (): void =>
	{
		const next = sample.value;
		safe(async (): Promise<void> =>
		{
			if (!await confirmReplace()) return;

			const url = new URL(location.href);
			url.searchParams.set('sample', next);
			allowLeave = true;
			location.assign(url);
		});
	};
	try
	{
		await drafts.open();
		storageReady = true;
		if (enabled) candidate = await drafts.latest();
		else await drafts.remove();

		if (candidate)
		{
			byId('recovery-info').textContent = `${candidate.name} · ${new Date(candidate.updated).toLocaleString()}`;
			selectTab('file');
		}
	}
	catch (error) {storageState = `자동 저장을 사용할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`;}

	render();
}
