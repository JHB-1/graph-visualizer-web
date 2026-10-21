# 웹 작업 공간과 코어 API

코어 커밋은 변경하지 않고 공개 API를 호출하는 웹 전용 어댑터만 확장합니다.
그래프 문서/배선/Undo를 JavaScript 사본으로 관리하지 않습니다.
일반 편집과 테마/알고리즘 변경은 동일 세션의 Scene 변경분으로 반영하며 DOM ID를 유지합니다.

| 탭 | 노출 기능 | 코어 경로 |
|---|---|---|
| 편집 | 좌표/크기/모양/라벨/부모/프로파일/선택/영역 선택 | GraphSession, ID별 graph_changes |
| 편집 | 복사/붙여넣기/복제/삭제/그룹/해제/내부 범위 | GraphSession 공개 편집/탐색 API |
| 편집 | 연결 추가/재연결/방향/반전/가중치/경유점/잠금/라벨 좌표 | GraphSession, edge_update |
| 편집 | 전체 스타일/개별 속성 상속 복구 | optional 스타일 값, resetNodeStyle/resetEdgeStyle |
| 테마 | 노드/엣지 RGBA/폰트/굵기/크기/패딩/캔버스 전체 속성 | Defaults, CanvasStyle |
| 테마 | 명명 노드/엣지 프로파일 | 전체 프로파일 목록 JSON, 코어 테마 텍스트 |
| 테마 | UTF-8 .gvtheme 입출력 | parse/serialize/theme_profile_from_document, 브라우저 파일 어댑터 |
| 테마 | 폰트 포함/누락 정책/대체 글꼴 | FontSettings, OS 글꼴 설치/바이너리 등록 UI는 미제공 |
| 배선 | Options 전체 속성, 직선/직각/8방향/베지어 | setOptions, edge_update.routing |
| 배선 | Undo 제한, 격자 표시 | setUndoLimit, 표시 여부는 문서 밖 호스트 상태 |
| 분석 | 5종 알고리즘/단계별 강조 | runAlgorithm/setAlgorithmStep/clearAlgorithm |
| 파일 | ID별 JSON 변경분/PNG/원본 JSON | incremental_graph.update, 브라우저 출력 |

속성 폼의 상속 체크는 optional 해제이며 `0`, `false`, 알파 `0`과 구분합니다.
명명 프로파일은 기본값 위에 적용되고 개별 스타일이 그 위에 적용됩니다.
기본 크기 변경은 새 노드에 적용되며 기존 문서의 실제 크기를 일괄 덮어쓰지 않습니다.
테마 설정은 하나의 beginEdit/endEdit으로 묶어 Undo 한 번으로 복구합니다.
선택/탐색/카메라/분석 강조는 문서 이력과 분리합니다.

코어의 플랫폼 계약 전부가 브라우저 기능인 것은 아닙니다. TCP/파일 시스템 어댑터는 빌드 OFF이고,
소켓 수집/OS 프로세스/OS 폰트 설치/사용자 정의 C++ Router 교체는 이 정적 웹 UI에서 제공하지 않습니다.
Navigation의 북마크/방문 이력, 연결/경유점 전용 포인터 제스처는 별도 UI가 없으며
현재 화면에서는 그룹 범위 버튼, 연결 폼, 경유점/라벨 좌표 속성으로 조작합니다.
문서 JSON 전체 가져오기는 지원하지 않고, 증분 JSON 입력과 원본 문서 출력만 지원합니다.
터치 제스처 전체 지원을 의미하지 않습니다.
