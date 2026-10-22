import type {Point, Rect} from './types.ts';

const ns = 'http://www.w3.org/2000/svg';
const canvas = document.createElement('canvas').getContext('2d');
const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const layouts = new WeakMap<SVGTextElement, string>();

// 원문과 글꼴 크기는 유지, 실제 글리프 폭으로 줄바꿈 후 표시 영역에 맞춰 말줄임
export function drawText(text: SVGTextElement, value: string, area: Rect, wrap: boolean = true): void
{
	const style = getComputedStyle(text);
	const key = JSON.stringify([value, area, wrap, style.fontSize, style.fontStyle, style.fontWeight, style.fontFamily]);
	if (layouts.get(text) === key) return;

	layouts.set(text, key);
	const fontSize = Number.parseFloat(style.fontSize) || 14;
	const lineHeight = fontSize * 1.25;
	if (canvas) canvas.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
	const measure = (line: string): number => canvas?.measureText(line).width ?? Array.from(line).length * fontSize;
	const lines: string[] = [];
	for (const paragraph of value.split(/\r\n?|\n/))
	{
		let line = '';
		for (const {segment} of graphemes.segment(paragraph))
		{
			if (wrap && line && area.width < measure(line + segment))
			{
				const space = line.lastIndexOf(' ');
				if (space > 0)
				{
					lines.push(line.slice(0, space).trimEnd());
					line = line.slice(space + 1);
				}
				else {lines.push(line.trimEnd()); line = '';}
			}

			line += segment;
		}

		lines.push(line);
	}

	const maximum = wrap ? Math.max(1, Math.floor(area.height / lineHeight)) : lines.length;
	const visible = lines.slice(0, maximum);
	if (wrap && visible.length)
	{
		const last = visible.length - 1;
		if (visible.length < lines.length || area.width < measure(visible[last]))
		{
			const parts = [...graphemes.segment(visible[last])].map((part): string => part.segment);
			while (parts.length && area.width < measure(parts.join('') + '…')) parts.pop();

			visible[last] = parts.join('') + '…';
		}
	}

	const x = area.x + area.width / 2;
	const y = area.y + area.height / 2 - (visible.length - 1) * lineHeight / 2;
	text.replaceChildren();
	text.setAttribute('x', String(x));
	text.setAttribute('y', String(y));
	for (const [index, line] of visible.entries())
	{
		const span = document.createElementNS(ns, 'tspan');
		span.setAttribute('x', String(x));
		span.setAttribute('y', String(y + index * lineHeight));
		span.textContent = line;
		text.append(span);
	}
}

// 표시 위치에서 원래 엣지의 가장 가까운 지점을 찾아 소유 관계 안내선에 사용
export function nearestPoint(path: Point[], point: Point): Point
{
	let closest = path[0] ?? point;
	let distance = Infinity;
	for (let index = 1; index < path.length; index += 1)
	{
		const a = path[index - 1];
		const b = path[index];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const weight = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
		const candidate = {x: a.x + dx * weight, y: a.y + dy * weight};
		const length = Math.hypot(candidate.x - point.x, candidate.y - point.y);
		if (length < distance) {closest = candidate; distance = length;}
	}

	return closest;
}
