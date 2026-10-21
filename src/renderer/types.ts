export type JsonObject = Record<string, unknown>;
export type Layer = 'frames' | 'nodes' | 'edges';
export interface Point {x: number; y: number}
export interface Rect extends Point {width: number; height: number}
export interface Color {r: number; g: number; b: number; a: number}
export interface FontStyle
{
	fontFamily: string;
	fontSize: number;
	fontBold: boolean;
	fontItalic: boolean;
	fontUnderline: boolean;
	fontStrikeOut: boolean;
}
export interface NodeStyle extends FontStyle
{
	shape: number;
	fill: Color;
	borderColor: Color;
	textColor: Color;
	borderWidth: number;
	padding: {left: number; right: number; top: number; bottom: number};
}
export interface Node
{
	id: string;
	center: Point;
	size: {width: number; height: number};
	label: string;
	parent: string | null;
	profile: string | null;
	subgraph: boolean;
	expanded: boolean;
	style: Partial<{[Key in keyof NodeStyle]: NodeStyle[Key] | null}>;
}
export interface NodeVisual
{
	node: Node;
	style: NodeStyle;
	textBounds: Rect;
	engaged: boolean;
	selected: boolean;
	active: boolean;
	highlighted: boolean;
	hovered: boolean;
}
export interface EdgeVisual
{
	id: string;
	path: Point[];
	segments: {cubic: boolean; control1: Point; control2: Point; end: Point}[];
	arrow: Point[];
	waypoints: Point[];
	text: string;
	labelAnchor: Point;
	labelBounds: Rect;
	labelStatus: number;
	status: number;
	source: string;
	target: string;
	actualSource: string;
	actualTarget: string;
	style: FontStyle & {color: Color; textColor: Color | null; width: number};
	engaged: boolean;
	selected: boolean;
	active: boolean;
	highlighted: boolean;
}
export interface Context
{
	bounds: Rect;
	follow_host_theme?: boolean;
	fallbackFontFamily: string;
	canvas: {background: Color; grid: Color; selection: Color; connectionTarget: Color; handleFill: Color; highlight: Color};
}
export interface Scene extends Context {frames: NodeVisual[]; nodes: NodeVisual[]; edges: EdgeVisual[]}
export interface Delta
{
	previous_revision: string;
	revision: string;
	context: Context;
	removed_frames: string[];
	removed_nodes: string[];
	removed_edges: string[];
	upserted_frames: NodeVisual[];
	upserted_nodes: NodeVisual[];
	upserted_edges: EdgeVisual[];
	frame_order: string[] | null;
	node_order: string[] | null;
	edge_order: string[] | null;
}
export interface ViewState
{
	focus_event?: string;
	focus_ids?: string[];
	options?: GridOptions;
	document_revision: string;
	render_revision: string;
	events?: {delta: Delta; document_revision: string}[];
	pulse?: {event_id: string; active: boolean};
	routing_failures?: {id: string; status: number}[];
	label_overlaps?: string[];
	tcp?: {state: string};
}
export interface GridOptions {gridSnap: boolean; gridSpacing: number; gridOrigin: Point}
export interface Snapshot extends ViewState
{
	scene: Scene;
	options: GridOptions;
}
export interface NodeEntry {group: SVGGElement; visual: NodeVisual}
export interface EdgeEntry {group: SVGGElement; label: SVGGElement; visual: EdgeVisual}
export type GraphItem = {id: string; subgraph?: boolean; expanded?: boolean} & JsonObject;
export interface Query {items: GraphItem[]}
export interface GraphError extends Error {code?: string}
export interface GraphTransport
{
	readonly graphId: string;
	beforeExport?(): Promise<void>;
	request(op: string, fields?: JsonObject): Promise<JsonObject>;
	downloadFile?(name: string, content: Blob): Promise<void>;
}
