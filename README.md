# Graph Visualizer Web

브라우저에서 직접 조작하는 전체 화면 Graph Visualizer입니다. 별도 서버나 설치 없이 원본 C++ 코어를 WebAssembly로 실행합니다.

웹사이트: https://JHB-1.github.io/graph-visualizer-web/

## 기능

- 그래프가 화면 높이 전체를 사용하며 좌측 사이드바 접기/펼치기 지원
- 편집/스타일/배선/분석/파일 탭, 작은 화면에서는 접이식 오버레이 패널
- 드래그/크기/팬/줌, Shift 다중 선택/좌표 영역 선택, 복사/붙여넣기/복제/삭제, 그룹 만들기/해제
- 노드/엣지 속성, ID 참조/부모/실제 끝점, 가중치/방향/경유점/라벨 위치/잠금/스타일 개별 상속
- RGBA/폰트/패딩/기본 크기/캔버스/명명 프로파일, 코어 ThemeProfile 입출력과 텍스트 편집
- 렌더러 UI 밝기 전환은 문서 스타일/revision/Undo/출력 데이터와 분리
- 기본/개별/폰트/프로파일 스타일은 입력 즉시 증분 반영, 적용 버튼 없음, 연속 입력은 Undo 한 건
- 직선/직각/8방향/베지어, 노드/엣지 여유/평행 배선/곡률/격자 원점/중복 허용 옵션
- BFS/DFS/최단 경로/연결 성분/사이클, 코어 재생 단계와 강조
- ID별 증분 JSON 입력, Undo/Redo/이력 제한, PNG/JSON 다운로드

현재 브라우저 메모리만 사용하며 새로고침이나 샘플 전환 시 초기화됩니다. [UI/API 대응 범위](docs/web-controls.md)를 참고하세요.
TCP 수집, 프로세스 추적, MCP 서버와 공동 편집 서버를 제공하지 않습니다.

코어는 다크/라이트 모드를 정의하지 않습니다. `ThemeProfile`은 개별 설정값의 묶음입니다.
이 페이지는 기본값 → 명명 프로파일 → 개별 override를 노출하며 별도의 색상 프리셋을 만들지 않습니다.

## 구성

`src/renderer`는 기존 렌더러를 분리한 초기 소스입니다. 그래프 모델/라우팅을 JavaScript로 다시 구현하지 않습니다.
브라우저 전송 어댑터가 Web Worker의 원본 코어에 메모리 요청을 전달하고, 렌더러는 변경된 Scene 항목만 갱신합니다.

코어 저장소는 아직 비공개입니다. 이 공개 저장소에는 코어 C++ 소스/헤더, 토큰, 디버그 심볼, 소스맵을 넣지 않습니다.
빌드된 WASM은 배포되는 프로그램이므로 다운로드/분석할 수 있으며, 소스 공개를 대신하는 보안 경계는 아닙니다.
코어와 렌더러의 라이선스는 아직 정하지 않았으며 임의의 오픈소스 라이선스를 적용하지 않습니다.

## 웹 빌드

Node.js 24와 pnpm 11.25.0을 사용합니다. 버전 고정 WASM 배포 파일이 포함되어 있어 웹 빌드/배포에는 코어 권한이 필요 없습니다.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm verify
python -m http.server 8000 --directory dist
```

## 코어 WASM 재빌드

권한 있는 로컬 코어 체크아웃과 Boost/nlohmann JSON 헤더, Docker가 필요합니다.
`core.lock.json`에 코어 커밋과 Emscripten 이미지 digest를 고정합니다.

```sh
GV_CORE_DIR=/path/to/private-core \
GV_BOOST_INCLUDE_DIR=/path/to/boost/include \
GV_JSON_INCLUDE=/path/to/json/include \
pnpm build:wasm
```

코어는 읽기 전용으로 마운트하고, 기존 메모리 어댑터를 `.build`에서만 연결합니다.
코어 기본 CMake 설정과 공개 헤더를 수정하지 않습니다. `.build`는 공개 대상이 아닙니다.

## 서브모듈과 비공개 코어

비공개 저장소를 서브모듈로 연결해도 접근 권한이 공개되지는 않지만 URL/고정 커밋은 공개되고,
일반 방문자는 코어를 내려받지 못합니다. Pages 기본 빌드는 비공개 서브모듈에 접근하지 못합니다.
현재는 서브모듈 대신 권한 있는 외부 체크아웃을 명시적으로 입력합니다.

공개 Actions는 배포 파일만 검사/게시하며 비공개 코어 토큰을 사용하지 않습니다.
외부 PR 실행에 비공개 읽기 권한을 주거나 `pull_request_target`에서 외부 코드를 실행하지 않습니다.

## 테스트

```sh
python -m pip install -r requirements-test.txt
python -m playwright install chromium
python tests/browser_test.py
```

브라우저에서 WASM 실행, 네트워크 요청 범위, 편집, 증분 DOM 유지, 그룹, 배선, 출력과 모바일 레이아웃을 확인합니다.
최종 배포 검증은 GitHub Actions와 Pages URL을 별도로 확인합니다.
