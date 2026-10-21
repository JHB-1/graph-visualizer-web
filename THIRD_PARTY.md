# Third-party notices

The Graph Visualizer project license has not been selected. Making this repository public does not apply an open-source license.

The WASM runtime includes code from the following dependencies. Full notices are shipped in `public/licenses/` and with the website.

| Component | Version | License |
|---|---|---|
| Pretendard Variable (self-hosted UI/default graph font) | 1.3.9 | SIL Open Font License 1.1, `public/licenses/Pretendard-LICENSE.txt` |
| Boost headers | 1.87.0 | Boost Software License 1.0 |
| nlohmann JSON | 3.12.0 | MIT |
| Emscripten generated runtime | 4.0.23 | MIT / University of Illinois NCSA, see complete notice |
| LLVM libc++, libc++abi, libunwind, compiler-rt | Emscripten 4.0.23 toolchain | Apache 2.0 with LLVM exception, see complete notices |

Emscripten's full license includes notices for its C library and bundled third-party runtime code.
Build-only dependencies esbuild, TypeScript, Node types and pnpm are pinned by package metadata/lockfiles and are not hosted client libraries.
Browser tests use Playwright 1.58.0, test-only and not part of the site runtime.
