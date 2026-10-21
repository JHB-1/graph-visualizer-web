interface Engine
{
	ccall(name: string, result: string, types: string[], values: string[]): string;
}

const engine = (async (): Promise<Engine> =>
{
	const source = await import(new URL('./wasm/gv-core.mjs', self.location.href).href);
	return source.default();
})();

self.onmessage = async (event: MessageEvent): Promise<void> =>
{
	const {id, request} = event.data;
	try
	{
		const module = await engine;
		const pending: {value: unknown; depth: number}[] = [{value: request, depth: 0}];
		while (pending.length)
		{
			const current = pending.pop()!;
			if (current.depth > 128) throw new Error('JSON 중첩이 너무 깊습니다.');
			if (typeof current.value === 'number' && !Number.isFinite(current.value)) throw new Error('숫자는 유한 값이어야 합니다.');
			if (current.value && typeof current.value === 'object')
				for (const child of Object.values(current.value)) pending.push({value: child, depth: current.depth + 1});
		}

		const text = JSON.stringify(request);
		const maximum = ['web_open', 'web_validate'].includes(request.op) ? 1_049_600 : 1_048_576;
		if (new TextEncoder().encode(text).length > maximum)
			throw new Error('요청이 1 MiB를 초과했습니다.');

		const result = JSON.parse(module.ccall('gv_request', 'string', ['string'], [text]));
		self.postMessage({id, ...result});
	}
	catch (error)
	{
		self.postMessage({id, error: {code: 'engine_error', message: String(error)}});
	}
};
