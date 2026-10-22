# 중앙 풀 CI

신뢰 main의 커밋을 JHB-1/actions-runner-pool 조정기가 수집합니다.
pages.yml은 dispatch 전용 단일 job이며 pool_sha 원본 커밋을 검사하고 같은 job에서 Pages를 게시합니다.
일반 push 또는 PR에서 직접 GitHub-hosted 작업을 시작하지 않습니다.
외부 PR은 중앙 풀에서 자동 실행하지 않습니다.

Linux 자체 자원에 Node 24, Python 3.12, Playwright 실행 기능이 필요합니다.
적합한 자원이 바쁘면 기다리고, 적합한 실행 자원이 없을 때만 hosted를 사용합니다.
비공개 중앙 액션은 공개 저장소에서 읽을 수 없으므로 메타데이터는 첫 단계와 요약에 직접 기록합니다.
원본 SHA의 runner-pool/linux 상태와 실행 URL을 중앙 조정기가 갱신합니다.

사용자 권한의 pnpm 경로와 Python 가상환경을 사용하고 컨테이너 안에서 sudo/apt를 실행하지 않습니다.
WASM과 브라우저 테스트, 검증 캐시 갱신 검사를 통과한 파일만 Pages로 게시합니다.

2026-10-22 실제 Linux 풀 이미지의 비root/권한 제한 조건에서 타입 검사, 빌드, 공개 자산 감사와
브라우저 32개, service worker 버전 전환 1개를 통과했습니다.
실제 GitHub dispatch/Pages 배포 결과는 중앙 실행 기록과 별도로 확인합니다.
