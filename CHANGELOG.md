# Changelog

## [1.2.0](https://github.com/fx/tx/compare/v1.1.0...v1.2.0) (2026-08-08)


### Features

* **marketplace:** retry a failed HTTPS clone over SSH ([#28](https://github.com/fx/tx/issues/28)) ([1b6b380](https://github.com/fx/tx/commit/1b6b3803ab0cfe74a7dce943cbbaafee38063a02))


### Bug Fixes

* **marketplace:** resolve plugin dependencies by Node's rules ([#31](https://github.com/fx/tx/issues/31)) ([aa7c7e6](https://github.com/fx/tx/commit/aa7c7e64d3c10f484c9c786823d2a6b3a5c75134))

## [1.1.0](https://github.com/fx/tx/compare/v1.0.0...v1.1.0) (2026-08-07)


### Features

* **marketplace:** add local directories as live marketplace sources ([#27](https://github.com/fx/tx/issues/27)) ([b4c5c22](https://github.com/fx/tx/commit/b4c5c228bf0e713de166ae23ceff149f7f44b9d2))
* **marketplace:** discover and list referenced marketplaces ([#25](https://github.com/fx/tx/issues/25)) ([f8ae7c2](https://github.com/fx/tx/commit/f8ae7c2949e8d5cadd0110b75ac5b3a1290febbe))

## 1.0.0 (2026-08-05)


### Features

* add core command dispatcher ([#3](https://github.com/fx/tx/issues/3)) ([d98def6](https://github.com/fx/tx/commit/d98def6f3bd32e127bd68a7c67daf467b72354d8))
* add marketplace management plugin ([#7](https://github.com/fx/tx/issues/7)) ([97b7fac](https://github.com/fx/tx/commit/97b7facd99d737eaa8353331c5433a2ac6d66ebf))
* add shared plugin API ([#6](https://github.com/fx/tx/issues/6)) ([b8c5d3e](https://github.com/fx/tx/commit/b8c5d3e83d7a59b6586be93dacc852ff9f692aa1))
* **cli:** delegate command dispatch to plugin namespaces ([#20](https://github.com/fx/tx/issues/20)) ([e0d9f03](https://github.com/fx/tx/commit/e0d9f037fc0e83dd6880f124561492918f7ee857))
* load external marketplace plugins ([#8](https://github.com/fx/tx/issues/8)) ([f719395](https://github.com/fx/tx/commit/f719395d367c40315a54f22707e555fc8bde46ce))
* **marketplace:** install dependencies per plugin ([#16](https://github.com/fx/tx/issues/16)) ([e1ea2a4](https://github.com/fx/tx/commit/e1ea2a4421a05b96b439dd7b729567461a0f50f1))
* **marketplace:** use repository plugin config ([#12](https://github.com/fx/tx/issues/12)) ([649b2ba](https://github.com/fx/tx/commit/649b2ba27e8835061fca495944c578bee1388ae2))
* **plugin:** inject the command parser as a core dependency ([#19](https://github.com/fx/tx/issues/19)) ([e329cd4](https://github.com/fx/tx/commit/e329cd47b89858c599c09eb76473fc4baa55226b))
* **release:** automate package publishing ([#14](https://github.com/fx/tx/issues/14)) ([85523c4](https://github.com/fx/tx/commit/85523c42eb2ea43337cbbdf003c67b38976052bb))


### Bug Fixes

* **cli:** keep plugin load failures out of the dispatch exit code ([#17](https://github.com/fx/tx/issues/17)) ([8212052](https://github.com/fx/tx/commit/82120524f9a2dcf9fb2254950ad7616a44177c89))
