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
		const text = JSON.stringify(request);
		if (new TextEncoder().encode(text).length > 1_048_576)
			throw new Error('요청이 1 MiB를 초과했습니다.');

		const result = JSON.parse(module.ccall('gv_request', 'string', ['string'], [text]));
		self.postMessage({id, ...result});
	}
	catch (error)
	{
		self.postMessage({id, error: {code: 'engine_error', message: String(error)}});
	}
};
