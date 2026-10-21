import type {JsonObject, GraphTransport, Delta, Scene, ViewState} from './renderer/types.ts';

interface NativeReply
{
	result: JsonObject;
	delta?: Delta;
	snapshot?: Scene;
}

export type WorkspaceCore = Pick<BrowserCore, 'graphId' | 'exchange' | 'request' | 'update' | 'beforeExport' | 'downloadFile'>;
export interface WorkspaceHost
{
	core: WorkspaceCore;
	name: string;
	status: string;
	drafts?: Pick<import('./drafts.ts').Drafts, 'id' | 'open' | 'latest' | 'save' | 'remove' | 'clear'>;
}
declare global {interface Window {graphWorkspace?: WorkspaceHost; graphTransport?: GraphTransport}}

export class BrowserCore implements GraphTransport
{
	readonly graphId: string = 'browser-session';
	beforeExport?: () => Promise<void>;
	private worker = new Worker(new URL('engine-worker.js', document.baseURI), {type: 'module'});
	private sequence = 0;
	private waiting = new Map<number, {resolve: (value: NativeReply) => void; reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>}>();
	private events: {delta: Delta; document_revision: string}[] = [];
	private pulse = '0';
	private closed = false;
	private renderOffset = 0n;
	private lastRender = 0n;
	private documentRevision = '';

	constructor()
	{
		this.worker.onmessage = (event: MessageEvent): void =>
		{
			const pending = this.waiting.get(event.data.id);
			if (!pending) return;

			clearTimeout(pending.timer);
			this.waiting.delete(event.data.id);
			if (event.data.error)
				pending.reject(Object.assign(new Error(event.data.error.message), {code: event.data.error.code}));
			else
				pending.resolve(event.data);
		};
		this.worker.onerror = (event): void => {this.close(new Error(event.message || 'WASM 실행에 실패했습니다.'));};
	}

	private close(error: Error): void
	{
		this.closed = true;
		this.worker.terminate();
		for (const pending of this.waiting.values())
		{
			clearTimeout(pending.timer);
			pending.reject(error);
		}

		this.waiting.clear();
	}

	async exchange(request: JsonObject): Promise<NativeReply>
	{
		if (this.closed) throw new Error('브라우저 코어가 종료되었습니다. 페이지를 새로 여세요.');
		if (this.waiting.size >= 64) throw new Error('처리 대기 중인 요청이 너무 많습니다.');

		const id = ++this.sequence;
		const reply = await new Promise<NativeReply>
		(
			(resolve, reject): void =>
			{
				const timer = setTimeout((): void => {this.close(new Error('코어 응답 시간이 초과되었습니다.'));}, 20_000);
				this.waiting.set(id, {resolve, reject, timer});
				this.worker.postMessage({id, request: {graph_id: this.graphId, ...request}});
			}
		);
		if (reply.result.replaced)
		{
			this.renderOffset = this.lastRender;
			this.events = [];
		}

		if (reply.result.render_revision !== undefined)
		{
			const mapped = BigInt(String(reply.result.render_revision)) + this.renderOffset;
			reply.result.render_revision = String(mapped);
			if (this.lastRender < mapped) this.lastRender = mapped;
		}

		if (reply.delta)
		{
			reply.delta.previous_revision = String(BigInt(reply.delta.previous_revision) + this.renderOffset);
			reply.delta.revision = String(BigInt(reply.delta.revision) + this.renderOffset);
			reply.delta.context.follow_host_theme = false;
			if (reply.delta.revision !== reply.delta.previous_revision)
			{
				this.events.push({delta: reply.delta, document_revision: String(reply.result.document_revision)});
				if (this.events.length > 64) this.events.shift();
				window.dispatchEvent(new Event('gv-core-update'));
			}
		}

		const revision = String(reply.result.document_revision ?? this.documentRevision);
		if (revision !== this.documentRevision)
		{
			this.documentRevision = revision;
			window.dispatchEvent(new CustomEvent('gv-document-change', {detail: {revision}}));
		}

		return reply;
	}

	async state(revision: string): Promise<JsonObject>
	{
		const reply = await this.exchange({op: 'status'});
		const events = this.events.filter((event): boolean => BigInt(event.delta.revision) > BigInt(revision));
		if (events.length && events[0].delta.previous_revision !== revision)
			throw Object.assign(new Error('표시 변경분을 다시 동기화합니다.'), {code: 'resync_required'});

		return {...reply.result, events, tcp: {state: 'browser'}, pulse: {event_id: this.pulse, active: true}};
	}

	async request(op: string, fields: JsonObject = {}): Promise<JsonObject>
	{
		if (op === 'snapshot')
		{
			const reply = await this.exchange({op});
			if (!reply.snapshot) throw new Error('초기 그래프가 없습니다.');

			reply.snapshot.follow_host_theme = false;
			return {...reply.result, scene: reply.snapshot};
		}

		if (op === 'ui')
		{
			await this.exchange({op, ...fields.event as JsonObject});
			return this.state(String(fields.revision ?? '0'));
		}

		if (op === 'poll' || op === 'ack') return this.state(String(fields.revision ?? '0'));
		if (op === 'query' || op === 'status') return (await this.exchange({op, ...fields})).result;
		if (op === 'export')
		{
			await this.beforeExport?.();
			const reply = await this.exchange({op});
			(reply.result.file as JsonObject).followHostTheme = false;
			return reply.result;
		}

		if (op === 'dispose') return {};

		throw new Error('이 페이지에서는 지원하지 않는 작업입니다.');
	}

	async update(changes: JsonObject): Promise<void>
	{
		const current = await this.exchange({op: 'query'});
		await this.exchange({op: 'apply', expected_revision: current.result.document_revision, changes});
		this.pulse = String(current.result.document_revision) + '-' + String(this.sequence);
	}

	async downloadFile(name: string, content: Blob): Promise<void>
	{
		const url = URL.createObjectURL(content);
		const link = document.createElement('a');
		link.href = url;
		link.download = name;
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout((): void => {URL.revokeObjectURL(url);}, 30_000);
	}
}
