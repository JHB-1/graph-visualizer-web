import type {WorkspaceCore} from './transport.ts';

declare const GV_WEB_VERSION: string;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function newerVersion(candidate: string, installed: string): boolean
{
	if (!versionPattern.test(candidate) || !versionPattern.test(installed)) return false;

	const left = candidate.split('.').map(BigInt);
	const right = installed.split('.').map(BigInt);
	for (let index = 0; index < 3; index += 1)
		if (left[index] !== right[index]) return left[index] > right[index];

	return false;
}

export function startWebUpdates(_core: WorkspaceCore): void
{
	if (window.graphWorkspace || !['https:', 'http:'].includes(location.protocol) || !('serviceWorker' in navigator)) return;

	const notice = document.createElement('aside');
	notice.className = 'update-notice';
	notice.setAttribute('aria-label', '업데이트');
	notice.hidden = true;
	const status = document.createElement('span');
	status.setAttribute('role', 'status');
	const save = document.createElement('button');
	save.textContent = '그래프 저장';
	save.onclick = (): void => {document.getElementById('export-graph')!.click();};
	notice.append(status, save);
	document.getElementById('workspace')!.append(notice);
	let registration: ServiceWorkerRegistration | undefined;
	let pending = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const show = (text: string): void =>
	{
		notice.hidden = false;
		status.textContent = text;
	};
	const installed = (): void =>
	{
		if (!registration?.waiting) return;

		show('새 버전이 준비됐습니다. 그래프를 저장하고 모든 GV 탭을 닫은 뒤 다시 열면 적용됩니다.');
		notice.dataset.ready = 'true';
	};
	const check = async (): Promise<void> =>
	{
		if (pending || stopped || document.hidden) return;

		clearTimeout(timer);
		pending = true;
		try
		{
			const response = await fetch(new URL('update-manifest.json', document.baseURI),
				{cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000)});
			if (!response.ok) return;

			const text = await response.text();
			if (text.length > 65536) throw new Error('업데이트 목록이 너무 큽니다.');

			const manifest = JSON.parse(text) as {schema?: unknown; product?: unknown; component?: unknown; version?: unknown};
			if (manifest.schema !== 1 || manifest.product !== 'gv' || manifest.component !== 'web' ||
				typeof manifest.version !== 'string' || !newerVersion(manifest.version, GV_WEB_VERSION)) return;

			await registration?.update();
			installed();
		}
		catch
		{
			// 조회 실패 시 실행 중인 문서와 이전 프로그램 유지
		}
		finally
		{
			pending = false;
			if (!stopped && !document.hidden) timer = setTimeout((): void => {void check();}, 300000);
		}
	};
	void navigator.serviceWorker.register(new URL('update-worker.js', document.baseURI), {updateViaCache: 'none'}).then
	(
		(value: ServiceWorkerRegistration): void =>
		{
			registration = value;
			installed();
			value.addEventListener('updatefound', (): void =>
			{
				const worker = value.installing;
				worker?.addEventListener('statechange', (): void => {if (worker.state === 'installed') installed();});
			});
			void check();
		},
		(): void => {},
	);
	document.addEventListener('visibilitychange', (): void => {clearTimeout(timer); if (!document.hidden) void check();});
	window.addEventListener('pagehide', (): void => {stopped = true; clearTimeout(timer);});
}
