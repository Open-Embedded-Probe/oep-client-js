# Changelog / 変更履歴

## Unreleased

- (EN) The scaffold: the layout (the core in `src/`, the browser and Node transports in `src/browser/` and `src/node/`, the web page in `web/`), the build, site, test and release scripts (as wireskein-web's), CI, Pages and the release workflow, the design and release documents. Nothing is implemented yet.
- (EN) A first full port of oep-client-python's client (ahead of the v1 freeze, to be redone as the spec settles): the core, the debug wires and riscv-dm, ARM ADI, the target console, the fixtures, the captures, probe.config and dump; the WebSerial / WebUSB / WebHID and Node TCP / serial / USB transports; the USB DFU updater and the firmware manifest; the page (connect, describe, settings, GPIO and UART, DFU). The registry comes from oep-spec's generator (new JS output). Talks to OpenEmbeddedProbe 0.0.19; tested with oep-client-python 0.0.19's fake probe.
- (JA) oep-client-python のクライアントを、ひととおり移した（v1 の凍結の前。仕様が固まるにつれて作り直す）: 核、debug の線と riscv-dm、ARM の ADI、target のコンソール、fixture、キャプチャ、probe.config と dump。WebSerial / WebUSB / WebHID と Node の TCP / シリアル / USB の経路。USB の DFU での更新と firmware の一覧。ページ（接続、describe、設定、GPIO と UART、DFU）。registry は oep-spec の生成器から（JS の出力を足した）。OpenEmbeddedProbe 0.0.19 と話せる。試験は oep-client-python 0.0.19 の fake の probe で。
- (JA) 骨組み: 構成（`src/` に核、`src/browser/` と `src/node/` にブラウザと Node の経路、`web/` に Web ページ）、ビルド、サイト、試験、リリースのスクリプト（wireskein-web と同じ）、CI、Pages、リリースのワークフロー、設計とリリースの文書。まだ何も実装していない。
