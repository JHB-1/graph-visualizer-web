import type {JsonObject} from './renderer/types.ts';

const node = (id: string, label: string, x: number, y: number, extra: JsonObject = {}): JsonObject =>
	({id, label, shape: 1, center: {x, y}, size: {width: 140, height: 72}, ...extra});
const edge = (id: string, source: string, target: string, label: string, routing = 3): JsonObject =>
	({id, source, target, label, routing});

export const samples: Record<string, {name: string; description: string; changes: JsonObject; options: JsonObject}> =
{
	workflow:
	{
		name: '워크플로',
		description: '노드를 움직이고 그룹을 접어보세요. 연결은 실제 내부 끝점을 유지합니다.',
		changes:
		{
			added_nodes:
			[
				node('0', '사용자 요청', -360, 0),
				node('10', '처리 파이프라인', 0, 0, {subgraph: true, expanded: true, size: {width: 460, height: 240}}),
				node('9007199254740993', '입력 검증', -120, 0, {parent: '10'}),
				node('2', '코어 처리', 120, 0, {parent: '10'}),
				node('18446744073709551615', '결과', 390, 0)
			],
			added_edges:
			[
				edge('0', '0', '9007199254740993', '요청'),
				edge('1', '9007199254740993', '2', '처리'),
				edge('2', '2', '18446744073709551615', '변경분')
			]
		},
		options: {gridSnap: true, gridSpacing: 25, obstacleAvoidance: true, minimumNodeGap: 40}
	},
	routing:
	{
		name: '배선과 장애물',
		description: '가운데 장애물을 움직이거나 배선 방식을 바꿔 경로를 비교하세요.',
		changes:
		{
			added_nodes: [node('0', '시작', -300, 0), node('2', '도착', 300, 0),
				node('3', '장애물', 0, 0, {size: {width: 140, height: 180}})],
			added_edges: [edge('0', '0', '2', '경로 A'), edge('1', '2', '0', '경로 B')]
		},
		options: {gridSnap: true, gridSpacing: 25, obstacleAvoidance: true, minimumNodeGap: 40}
	},
	stream:
	{
		name: '증분 갱신',
		description: '데이터 갱신을 눌러보세요. 같은 노드와 엣지를 유지한 채 변경분만 반영합니다.',
		changes:
		{
			added_nodes: [node('0', '입력 데이터', -280, 0), node('2', '수신 0', 0, 0), node('3', '렌더러', 280, 0)],
			added_edges: [edge('0', '0', '2', '배치'), edge('1', '2', '3', 'Scene Δ')]
		},
		options: {gridSnap: true, gridSpacing: 25, obstacleAvoidance: true, minimumNodeGap: 40}
	}
};
