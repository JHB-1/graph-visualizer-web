import type {EdgeVisual, Point} from './types.ts';

function fractions(points: Point[]): number[]
{
	const lengths = [0];
	for (let index = 1; index < points.length; index += 1)
		lengths.push(lengths[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));

	const total = lengths.at(-1) ?? 0;
	return lengths.map((length: number, index: number): number => total ? length / total : index / Math.max(1, points.length - 1));
}

/** Display-only deformation of the last core route; never a replacement route or document edit. */
export function previewEdge(visual: EdgeVisual, source: Point, target: Point): EdgeVisual
{
	if (visual.status >= 2 || visual.path.length < 2) return visual;
	const shift = (point: Point, weight: number): Point => ({
		x: point.x + source.x * (1 - weight) + target.x * weight,
		y: point.y + source.y * (1 - weight) + target.y * weight
	});
	const weights = fractions(visual.path);
	const path = visual.path.map((point: Point, index: number): Point => shift(point, weights[index]));
	const ends = [visual.path[0], ...visual.segments.map((segment): Point => segment.end)];
	const segmentWeights = fractions(ends);
	const segments = visual.segments.map((segment, index) => {
		const start = segmentWeights[index];
		const end = segmentWeights[index + 1];
		return {...segment, control1: shift(segment.control1, start + (end - start) / 3),
			control2: shift(segment.control2, start + 2 * (end - start) / 3), end: shift(segment.end, end)};
	});
	const nearestWeight = (point: Point): number => {
		let nearest = Infinity;
		let weight = 0;
		for (let index = 1; index < visual.path.length; index += 1)
		{
			const a = visual.path[index - 1];
			const b = visual.path[index];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
			const distance = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
			if (distance < nearest)
			{
				nearest = distance;
				weight = weights[index - 1] + t * (weights[index] - weights[index - 1]);
			}
		}
		return weight;
	};
	const tip = visual.path.at(-1)!;
	const last = visual.segments.at(-1);
	const before = last?.cubic ? last.control2 : (ends.length > 1 && last ? ends.at(-2)! : visual.path.at(-2)!);
	const after = last?.cubic ? segments.at(-1)!.control2 : (last ? shift(before, segmentWeights.at(-2)!) : path.at(-2)!);
	const end = shift(tip, 1);
	const angle = Math.atan2(end.y - after.y, end.x - after.x) - Math.atan2(tip.y - before.y, tip.x - before.x);
	const arrow = visual.arrow.map((point: Point): Point => ({
		x: end.x + (point.x - tip.x) * Math.cos(angle) - (point.y - tip.y) * Math.sin(angle),
		y: end.y + (point.x - tip.x) * Math.sin(angle) + (point.y - tip.y) * Math.cos(angle)
	}));
	const labelAnchor = visual.labelStatus === 2 ? visual.labelAnchor : shift(visual.labelAnchor, nearestWeight(visual.labelAnchor));
	return {...visual, path, segments, arrow, labelAnchor,
		labelBounds: {...visual.labelBounds, x: visual.labelBounds.x + labelAnchor.x - visual.labelAnchor.x,
			y: visual.labelBounds.y + labelAnchor.y - visual.labelAnchor.y},
		waypoints: visual.waypoints.map((point: Point): Point => shift(point, nearestWeight(point)))};
}
