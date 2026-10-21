import type {JsonObject} from './renderer/types.ts';

export interface Draft
{
	id: string;
	version: 1;
	name: string;
	file: JsonObject;
	dirty: boolean;
	updated: number;
}

// 제품별 DB/탭별 키 분리, 다른 탭의 복구 기록을 자동으로 덮어쓰지 않음
export class Drafts
{
	id: string = crypto.randomUUID();
	private database?: IDBDatabase;
	private release?: () => void;

	private claim(): Promise<void>
	{
		return new Promise<void>
		(
			(resolve, reject): void =>
			{
				void navigator.locks.request
				(
					`gv-draft:${this.id}`, {ifAvailable: true},
					async (lock): Promise<void> =>
					{
						if (!lock)
						{
							this.id = crypto.randomUUID();
							await this.claim(); resolve();

							return;
						}

						resolve();
						await new Promise<void>((release): void => {this.release = release;});
					}
				).catch(reject);
			}
		);
	}

	async open(): Promise<void>
	{
		try {this.id = sessionStorage.getItem('gv-draft-id') ?? this.id;}
		catch { /* 저장소 제한 시 새 탭 식별자 사용 */ }

		if (navigator.locks) await this.claim();
		else this.id = crypto.randomUUID();

		try {sessionStorage.setItem('gv-draft-id', this.id);}
		catch { /* 복구 목록은 IndexedDB에 유지 */ }

		this.database = await new Promise<IDBDatabase>
		(
			(resolve, reject): void =>
			{
				const request = indexedDB.open('gv-web-workspace', 1);
				request.onupgradeneeded = (): void => {request.result.createObjectStore('drafts', {keyPath: 'id'});};
				request.onsuccess = (): void => {resolve(request.result);};
				request.onerror = (): void => {reject(request.error);};
				request.onblocked = (): void => {reject(new Error('다른 탭이 복구 저장소를 사용 중입니다.'));};
			}
		);
		this.database.onversionchange = (): void => {this.database?.close(); this.database = undefined;};
		window.addEventListener('pagehide', (): void => {this.database?.close(); this.release?.();});
	}

	private transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T>
	{
		return new Promise<T>
		(
			(resolve, reject): void =>
			{
				if (!this.database) {reject(new Error('복구 저장소를 사용할 수 없습니다.')); return;}

				const transaction = this.database.transaction('drafts', mode);
				const request = action(transaction.objectStore('drafts'));
				transaction.oncomplete = (): void => {resolve(request.result);};
				transaction.onabort = (): void => {reject(transaction.error ?? request.error);};
				transaction.onerror = (): void => {reject(transaction.error ?? request.error);};
			}
		);
	}

	async latest(): Promise<Draft | undefined>
	{
		const drafts = await this.transact('readonly', (store): IDBRequest<Draft[]> => store.getAll());
		const valid = drafts.filter((draft): boolean => draft.version === 1 && typeof draft.updated === 'number');

		return valid.find((draft): boolean => draft.id === this.id) ?? valid.sort((a, b): number => b.updated - a.updated)[0];
	}

	async save(draft: Omit<Draft, 'id' | 'version' | 'updated'>): Promise<void>
	{
		await this.transact
		(
			'readwrite',
			(store): IDBRequest<IDBValidKey> => store.put({...draft, id: this.id, version: 1, updated: Date.now()})
		);
	}

	async remove(): Promise<void>
	{
		await this.transact('readwrite', (store): IDBRequest<undefined> => store.delete(this.id));
	}

	async clear(): Promise<void>
	{
		await this.transact('readwrite', (store): IDBRequest<undefined> => store.clear());
	}
}
