import type {GraphTransport} from './types.ts';
import {defaultFontData} from './font.ts';

// 계산된 스타일 고정, 테마 CSS 변수 없이 독립 SVG로 변환
export function imageSVG(source: SVGSVGElement): {text: string; width: number; height: number}
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
	copy.querySelectorAll('#grid-area, defs, .outline, .resize, .disclosure, .waypoints, .label-bounds').forEach
	(
		(item): void => { item.remove(); }
	);
	const bounds = source.querySelector<SVGGElement>('#camera')!.getBBox();
	if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
		throw new Error('이미지로 출력할 수 없는 그래프 범위입니다.');

	const padding = 24;
	const worldWidth = Math.max(1, bounds.width + padding * 2);
	const worldHeight = Math.max(1, bounds.height + padding * 2);
	const scale = Math.min(1, 8192 / worldWidth, 8192 / worldHeight, Math.sqrt(32_000_000 / worldWidth / worldHeight));
	const width = Math.max(1, Math.floor(worldWidth * scale));
	const height = Math.max(1, Math.floor(worldHeight * scale));
	copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	copy.setAttribute('width', String(width));
	copy.setAttribute('height', String(height));
	copy.setAttribute('viewBox', `0 0 ${worldWidth} ${worldHeight}`);
	copy.removeAttribute('style');
	copy.querySelector('#camera')!.setAttribute('transform', `translate(${padding - bounds.x},${padding - bounds.y})`);
	const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
	background.setAttribute('width', '100%');
	background.setAttribute('height', '100%');
	background.setAttribute('fill', getComputedStyle(source).backgroundColor);
	copy.prepend(background);

	return {text: new XMLSerializer().serializeToString(copy), width, height};
}

export async function pngImage(source: SVGSVGElement): Promise<Blob>
{
	await document.fonts.ready;
	const image = imageSVG(source);
	const xml = new DOMParser().parseFromString(image.text, 'image/svg+xml');
	const style = xml.createElementNS('http://www.w3.org/2000/svg', 'style');
	const fontData = await defaultFontData();
	style.textContent = '@font-face{font-family:"Pretendard Variable";font-weight:100 900;' +
		`font-style:normal;src:url("${fontData}") format("woff2");}`;
	xml.documentElement.prepend(style);
	const svg = new Blob([new XMLSerializer().serializeToString(xml)], {type: 'image/svg+xml;charset=utf-8'});
	const url = URL.createObjectURL(svg);
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
