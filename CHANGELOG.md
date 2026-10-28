# Changelog

## [2.2.1](https://github.com/fx/tx/compare/v2.2.0...v2.2.1) (2026-10-28)


### Bug Fixes

* **ci:** harden dependencies and validate all application code ([#94](https://github.com/fx/tx/issues/94)) ([fbe9ab9](https://github.com/fx/tx/commit/fbe9ab9707d1649c9eb7e81e9dad170dad58d85d))
* **runtime:** serialize config writes and animate nested input carets ([#95](https://github.com/fx/tx/issues/95)) ([9eb21c4](https://github.com/fx/tx/commit/9eb21c4f3ac4c021aa03e23ba7d141e99bd18961))

## [2.2.0](https://github.com/fx/tx/compare/v2.1.0...v2.2.0) (2026-10-18)


### Features

* **dialogs:** paint rows to their own width and let a host hide key hints ([#92](https://github.com/fx/tx/issues/92)) ([4fedcc0](https://github.com/fx/tx/commit/4fedcc0a886301e9c851012de72774150714bdde))

## [2.1.0](https://github.com/fx/tx/compare/v2.0.0...v2.1.0) (2026-10-18)


### Features

* **dialogs:** add embeddable select and input components ([#88](https://github.com/fx/tx/issues/88)) ([95e27cf](https://github.com/fx/tx/commit/95e27cfe33cea95994833ba5651afa9d93ae33e6))
* **dialogs:** add multi-select columns ([#90](https://github.com/fx/tx/issues/90)) ([f812737](https://github.com/fx/tx/commit/f812737d72fb1047076e9a69efb2d44ad8c6eb53))
* **grid:** add embeddable grid component ([#86](https://github.com/fx/tx/issues/86)) ([38e4299](https://github.com/fx/tx/commit/38e429911c2f7664d8e9f4050520ff755832efab))
* **grid:** add embeddable select grid component ([#89](https://github.com/fx/tx/issues/89)) ([5b3e3ad](https://github.com/fx/tx/commit/5b3e3ade3ca669c18cfaca121ef52cef25ba0963))


### Bug Fixes

* **dialogs:** take every tick, answer chunked Enter, and paint every row ([#91](https://github.com/fx/tx/issues/91)) ([c541514](https://github.com/fx/tx/commit/c541514bb6e6dd525a705454461edc70335dadce))

## [2.0.0](https://github.com/fx/tx/compare/v1.8.0...v2.0.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **deps:** plugins render with the host's Ink 8 and React 19.3. Ink 8 requires React 19.3 or newer; <Box> minWidth and maxWidth accept numbers only; stdin, stdout and stderr in render() options and in useStdin, useStdout and useStderr are typed as generic Node streams, so TTY-only members such as stdout.columns are gone from those types (use useWindowSize); and useInput no longer receives control sequences that map to no key, such as mouse reports, focus in/out and cursor-position reports, which are now discarded.

### Features

* **deps:** upgrade to Ink 8 and React 19.3 ([#79](https://github.com/fx/tx/issues/79)) ([4774d42](https://github.com/fx/tx/commit/4774d42c8b2d1e284c5a08200f41636ac2eb7b1f))
* **marketplace:** install the newest version compatible with the running tx ([#83](https://github.com/fx/tx/issues/83)) ([a46f01b](https://github.com/fx/tx/commit/a46f01bc73d213c984e958d7c106df8f27ceb2f0))
* **marketplace:** refuse marketplaces whose tx range excludes the running tx ([#82](https://github.com/fx/tx/issues/82)) ([e3a872a](https://github.com/fx/tx/commit/e3a872ada76519ab56699bc9bb8248d5b8b14bd5))


### Performance Improvements

* build React for production and cache text widths ([#84](https://github.com/fx/tx/issues/84)) ([df48d7f](https://github.com/fx/tx/commit/df48d7f84adc14bbd2226bfb336ccadcf697799a))

## [1.8.0](https://github.com/fx/tx/compare/v1.7.0...v1.8.0) (2026-10-01)


### Features

* **release:** publish a linux arm64 executable ([#77](https://github.com/fx/tx/issues/77)) ([cfb95e1](https://github.com/fx/tx/commit/cfb95e1de2f6d925f1942ad426a955ceaf1a97f5))

## [1.7.0](https://github.com/fx/tx/compare/v1.6.1...v1.7.0) (2026-09-06)


### Features

* **config:** publish the config contract at its registry key ([#75](https://github.com/fx/tx/issues/75)) ([dea5355](https://github.com/fx/tx/commit/dea535553ca34997d97cdad47a6e9ee7a312f53e))
* **demo:** ship extensionless demo showcasing all dialog features ([#63](https://github.com/fx/tx/issues/63)) ([d54145c](https://github.com/fx/tx/commit/d54145c8790d0274663e1491eec6170185ea7961))
* **dialogs:** add multi-cell select rows and column headers ([#70](https://github.com/fx/tx/issues/70)) ([e071364](https://github.com/fx/tx/commit/e071364215cd0c1b5ce06fed585a9d7cb0a8ecd4))
* **dialogs:** cascade sub-dialogs as stacked shadowed panels ([#61](https://github.com/fx/tx/issues/61)) ([21659a3](https://github.com/fx/tx/commit/21659a3bb4fb8893f33c89b0cab4e940b32d5ff0))
* **dialogs:** publish the dialogs contract at its registry key ([#76](https://github.com/fx/tx/issues/76)) ([47b10a4](https://github.com/fx/tx/commit/47b10a4a2b4bc89fb30e51e46d638896cc04bb25))
* **dialogs:** render sub-dialogs as columns of one panel ([#64](https://github.com/fx/tx/issues/64)) ([14d35ed](https://github.com/fx/tx/commit/14d35ed82a70ae078569e8ee4e22280cfdbdce02))
* **grid:** add the grid plugin for aligned printed output ([#69](https://github.com/fx/tx/issues/69)) ([c9c2912](https://github.com/fx/tx/commit/c9c29127b2837e24c6065c1488796c7366dce668))
* **grid:** drive grid rows as a select with per-row actions ([#71](https://github.com/fx/tx/issues/71)) ([e3111c4](https://github.com/fx/tx/commit/e3111c4d9e0258a792b910e7f0925a73e10cc704))
* **grid:** publish the grid contract at its registry key ([#74](https://github.com/fx/tx/issues/74)) ([1ee5e3b](https://github.com/fx/tx/commit/1ee5e3b40b416ad0bfa9becc9c21aa4008b4a7d3))
* **theme:** add theme variables and move dialogs behind them ([#68](https://github.com/fx/tx/issues/68)) ([ce8b428](https://github.com/fx/tx/commit/ce8b428d205598a8ffebbcc0c3737f9dd9ce94e4))
* **theme:** publish the theming contract at its registry key ([#73](https://github.com/fx/tx/issues/73)) ([4cdfc59](https://github.com/fx/tx/commit/4cdfc5992df6527bf593ed341e754b4d7ea76b9b))


### Bug Fixes

* **dialogs:** guarantee a cell's width by construction ([#66](https://github.com/fx/tx/issues/66)) ([139e185](https://github.com/fx/tx/commit/139e185499cfa1aee8a2200ae671f50d51639aa6))

## [1.6.1](https://github.com/fx/tx/compare/v1.6.0...v1.6.1) (2026-09-02)


### Bug Fixes

* **executable:** exempt and verify the delegated tx self-update ([#58](https://github.com/fx/tx/issues/58)) ([5149690](https://github.com/fx/tx/commit/51496907aa8bba4cc013ae4a9819c6595169ac3b))

## [1.6.0](https://github.com/fx/tx/compare/v1.5.0...v1.6.0) (2026-09-02)


### Features

* **dialogs:** add a type-to-filter to select ([#53](https://github.com/fx/tx/issues/53)) ([d0f7618](https://github.com/fx/tx/commit/d0f7618e445d80feb03cc99c66f3e28d0a9ddee7))
* **dialogs:** animate the caret, overflow indicator, and confirmation ([#57](https://github.com/fx/tx/issues/57)) ([420315d](https://github.com/fx/tx/commit/420315d69d72ea29beba53eb1e9230c9526ca23e))
* **dialogs:** frame dialogs in a Norton Commander panel ([#56](https://github.com/fx/tx/issues/56)) ([df775e3](https://github.com/fx/tx/commit/df775e3554a5a703122fd9538d50f9230005c7e0))
* **dialogs:** window the select option list and extend its navigation ([#55](https://github.com/fx/tx/issues/55)) ([5292519](https://github.com/fx/tx/commit/5292519f060a1aa57404e9c35eba0d645d9a1a2b))

## [1.5.0](https://github.com/fx/tx/compare/v1.4.0...v1.5.0) (2026-09-01)


### Features

* add bundled config capability ([#46](https://github.com/fx/tx/issues/46)) ([648f5f5](https://github.com/fx/tx/commit/648f5f5e1238ac46784c96768e92e399b7bee02b))
* **marketplace:** install configured marketplaces ([#49](https://github.com/fx/tx/issues/49)) ([995c7a9](https://github.com/fx/tx/commit/995c7a9fc7cebeee12ac8570e555bd329861a6d4))
* **marketplace:** pin marketplace versions ([#47](https://github.com/fx/tx/issues/47)) ([9e16710](https://github.com/fx/tx/commit/9e1671054b0488bf1b6d23d8d62f8b12d06d667a))
* **marketplace:** rederive sparse update footprint ([#51](https://github.com/fx/tx/issues/51)) ([369bf40](https://github.com/fx/tx/commit/369bf40ef0a7948eaaf822e64f14b082fed407e4))
* **marketplace:** reduce install retrieval ([#50](https://github.com/fx/tx/issues/50)) ([386d41b](https://github.com/fx/tx/commit/386d41b8600c32a43ec3150815dce85de26f5b72))

## [1.4.0](https://github.com/fx/tx/compare/v1.3.0...v1.4.0) (2026-08-29)


### Features

* **dialogs:** add a text input dialog ([#41](https://github.com/fx/tx/issues/41)) ([cd2110d](https://github.com/fx/tx/commit/cd2110dcd66af7de2b26d04f76413bb00f35fe30))
* **dialogs:** compose select with text input ([#43](https://github.com/fx/tx/issues/43)) ([5cb7be3](https://github.com/fx/tx/commit/5cb7be3cdc0fc5ae7ebca98b5565f032963b71c8))

## [1.3.0](https://github.com/fx/tx/compare/v1.2.0...v1.3.0) (2026-08-22)


### Features

* **dialogs:** add bundled select provider ([#39](https://github.com/fx/tx/issues/39)) ([0c56587](https://github.com/fx/tx/commit/0c565878f58d875d58031766a2aa4b16ee0c0258))
* **marketplace:** update installed marketplaces ([#35](https://github.com/fx/tx/issues/35)) ([c2e27ff](https://github.com/fx/tx/commit/c2e27ffda7117daa313908f3829fc29a466c13d1))
* **plugins:** add generic capability registry ([#38](https://github.com/fx/tx/issues/38)) ([551197e](https://github.com/fx/tx/commit/551197e4bf3209780e5d7e2b0db3b78ddd3ebcff))
* **site:** add the tx landing page and publish it to GitHub Pages ([#36](https://github.com/fx/tx/issues/36)) ([904da23](https://github.com/fx/tx/commit/904da23cb27b264611aaa0d3ba685025b5de0885))
* **update:** add a generic update lifecycle and the tx update command ([#32](https://github.com/fx/tx/issues/32)) ([158845a](https://github.com/fx/tx/commit/158845a72cd2e33c2b74be11953579211a1bcd91))
* **update:** update the tx executable ([#34](https://github.com/fx/tx/issues/34)) ([b869b94](https://github.com/fx/tx/commit/b869b944627dc7fde327aedd5987ffd7435b9da8))

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
