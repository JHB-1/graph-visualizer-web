import type {GraphTransport} from './types.ts';
import {defaultFontData} from './font.ts';

// 계산된 스타일 고정, 테마 CSS 변수 없이 독립 SVG로 변환
export interface ImageOptions {scale?: number; transparent?: boolean; area?: 'all' | 'selection' | 'viewport'}

export function imageSVG(source: SVGSVGElement, options: ImageOptions = {}): {text: string; width: number; height: number}
{
	const copy = source.cloneNode(true) as SVGSVGElement;
	const originals = [source, ...source.querySelectorAll('*')];
	const copies = [copy, ...copy.querySelectorAll('*')];
	const properties = ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'font-style',
		'text-decoration', 'display', 'opacity', 'fill-opacity', 'stroke-opacity', 'visibility', 'paint-order'];

	for (const [index, original] of originals.entries())
	{
		const style = getComputedStyle(original);
		for (const property of properties)
			copies[index].setAttribute(property, style.getPropertyValue(property));
	}

	// 편집 장식과 격자 제외, 현재 scope의 전체 그래프를 카메라와 독립적으로 출력
	const decorations = '#grid-area, #direct-layer, :scope > defs, .outline, .resize, .disclosure, ' +
		'.waypoints, .label-bounds, .direct-handle, .direct-preview';
	copy.querySelectorAll(decorations).forEach
	(
		(item): void => { item.remove(); }
	);
	if (options.area === 'selection')
	{
		const selected = [...source.querySelectorAll<SVGGElement>('[data-kind=node][data-selected=true]')];
		const nodes = new Set(selected.map((node): string => node.dataset.id!));
		let changed = true;
		while (changed)
		{
			changed = false;
			for (const node of source.querySelectorAll<SVGGElement>('[data-kind=node]'))
				if (nodes.has(node.dataset.parent!) && !nodes.has(node.dataset.id!)) {nodes.add(node.dataset.id!); changed = true;}
		}

		const edges = new Set([...source.querySelectorAll<SVGGElement>('#edges [data-kind=edge]')]
			.filter((edge): boolean => edge.dataset.selected === 'true' || nodes.has(edge.dataset.source!) && nodes.has(edge.dataset.target!))
			.map((edge): string => edge.dataset.id!));
		if (!nodes.size && !edges.size) throw new Error('출력할 항목을 먼저 선택하세요.');

		for (const node of copy.querySelectorAll<SVGGElement>('[data-kind=node]'))
			if (!nodes.has(node.dataset.id!)) node.remove();

		for (const edge of copy.querySelectorAll<SVGGElement>('[data-kind=edge]'))
			if (!edges.has(edge.dataset.id!)) edge.remove();
	}

	copy.classList.add('export-measure'); document.body.append(copy);
	let bounds: DOMRect;
	try {bounds = copy.querySelector<SVGGElement>('#camera')!.getBBox();}
	finally {copy.remove(); copy.classList.remove('export-measure');}

	if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
		throw new Error('이미지로 출력할 수 없는 그래프 범위입니다.');

	const viewport = options.area === 'viewport';
	const padding = viewport ? 0 : 24;
	const worldWidth = viewport ? source.getBoundingClientRect().width : Math.max(1, bounds.width + padding * 2);
	const worldHeight = viewport ? source.getBoundingClientRect().height : Math.max(1, bounds.height + padding * 2);
	const requestedScale = options.scale ?? 1;
	if (!Number.isFinite(requestedScale) || requestedScale <= 0 || 3 < requestedScale) throw new Error('출력 배율이 잘못됐습니다.');
	if (8192 < worldWidth * requestedScale || 8192 < worldHeight * requestedScale ||
		32_000_000 < worldWidth * worldHeight * requestedScale ** 2)
		throw new Error('이미지는 각 변 8192px, 전체 32MP 이하여야 합니다. 범위나 배율을 줄이세요.');

	const scale = requestedScale;
	const width = Math.max(1, Math.floor(worldWidth * scale));
	const height = Math.max(1, Math.floor(worldHeight * scale));
	copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	copy.setAttribute('width', String(width));
	copy.setAttribute('height', String(height));
	copy.setAttribute('viewBox', `0 0 ${worldWidth} ${worldHeight}`);
	copy.removeAttribute('style');
	if (!viewport) copy.querySelector('#camera')!.setAttribute('transform', `translate(${padding - bounds.x},${padding - bounds.y})`);

	const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
	background.setAttribute('width', '100%');
	background.setAttribute('height', '100%');
	background.setAttribute('fill', getComputedStyle(source).backgroundColor);
	if (!options.transparent) copy.prepend(background);

	return {text: new XMLSerializer().serializeToString(copy), width, height};
}

export async function svgImage(source: SVGSVGElement, options: ImageOptions = {}): Promise<{blob: Blob; width: number; height: number}>
{
	await document.fonts.ready;
	const image = imageSVG(source, options);
	const xml = new DOMParser().parseFromString(image.text, 'image/svg+xml');
	const style = xml.createElementNS('http://www.w3.org/2000/svg', 'style');
	const fontData = await defaultFontData();
	style.textContent = '@font-face{font-family:"Pretendard Variable";font-weight:100 900;' +
		`font-style:normal;src:url("${fontData}") format("woff2");}`;
	xml.documentElement.prepend(style);
	return {blob: new Blob([new XMLSerializer().serializeToString(xml)], {type: 'image/svg+xml;charset=utf-8'}),
		width: image.width, height: image.height};
}

export async function pngImage(source: SVGSVGElement, options: ImageOptions = {}): Promise<Blob>
{
	const image = await svgImage(source, options);
	const url = URL.createObjectURL(image.blob);
	try
	{
		const picture = new Image();
		await new Promise<void>
		(
			(resolve, reject): void =>
			{
				picture.onload = (): void => { resolve(); };
				picture.onerror = (): void => { reject(new Error('이미지를 만들지 못했습니다.')); };
				picture.src = url;
			}
		);
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('이미지 출력을 지원하지 않는 브라우저입니다.');

		context.drawImage(picture, 0, 0);

		return await new Promise<Blob>
		(
			(resolve, reject): void =>
			{
				canvas.toBlob
				(
					(blob): void =>
					{
						if (blob) resolve(blob);
						else reject(new Error('PNG 출력을 완료하지 못했습니다.'));
					},
					'image/png'
				);
			}
		);
	}
	finally
	{
		URL.revokeObjectURL(url);
	}
}

export async function download(name: string, content: Blob, transport?: GraphTransport): Promise<void>
{
	if (transport)
	{
		if (!transport.downloadFile) throw new Error('이 대화창은 파일 다운로드를 지원하지 않습니다.');

		return transport.downloadFile(name, content);
	}

	const url = URL.createObjectURL(content);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout((): void => { URL.revokeObjectURL(url); }, 30_000);
}
