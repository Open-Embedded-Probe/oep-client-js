# oep-client-js

[English](README.md)

npm: `oep-client-js`（リポジトリと同じ。PyPI の oep-client-python と対）。

[Open Embedded Probe（OEP）](https://github.com/Open-Embedded-Probe/oep-spec) の、JavaScript の host の実装です。ブラウザと Node から
OEP の probe と話し、設定し、firmware を更新します。これを使った Web ページ **OEP Probe Tool** を GitHub Pages に置きます:
<https://open-embedded-probe.github.io/oep-client-js/>。

## 状態

**v1 の凍結の前に、ひととおり移した版です。仕様が固まるにつれて作り直す前提です。** 入っているもの:

- 核: registry（oep-spec から生成）、フレーム（COBS + CRC、length）、メッセージ、リンク（corr の照合、1 回の送り直し、
  パイプライン、push と出来事）、host（confirm、セッション、ロック、購読）、list / describe / plan
- インターフェース: debug の線（rvswd、swio、swd）と riscv-dm、ARM の ADI / MEM-AP / Cortex-M、target のコンソール、
  fixture（gpio、uart、i2c-target、spi-target）、キャプチャ（ロジック、アナログ、capture-group、sigrok の .sr）、probe.config、
  `oep dump` の表示
- 経路: ブラウザは WebSerial、WebUSB（vendor bulk）、WebHID。Node は TCP、シリアルの口（`serialport`）、USB（`usb`）
  （ネイティブの package は任意）
- firmware の更新: USB の DFU（ESP32-P4）と、Release の firmware-<version>.json
- ページ: つなぐ、probe の宣言を読む、設定の編集と保存、GPIO と UART、port_speed、DFU での更新
- port_speed（oep-core §3.5、使うときだけ）: `raiseSpeed(host, rates, opts)`（または `connect` / `openWebSerial` / `openSerial` の
  `portSpeed: [速さ]`）で、セッションの間 UART bridge を速くする。速さを順に試し、両方向に max_frame の大きさの link_source /
  link_sink で確かめ（壊れたフレームを数え、向きごとの KB/s を測る）、決めるか、戻して起動時の速さで confirm し直す。結果は
  `host.link.speed` に残る。WebSerial は同じ口を閉じて開き直して速さを変え（すぐに DTR / RTS を放す。esptool-js と同じ）、Node の
  `serialport` は `update` で変える。`end` で link も起動時の速さに戻り、上げた速さで応答の来ない要求は起動時の速さに戻って
  もう一度送る（oep-client-python と同じ手順）

wire は oep-spec の 2026-10-01 のゼロベース見直しの形です（応答はすべて長さを持つ、TLV の長い形、confirm の boot_id、`expired`、
probe.config の `state` / `unset` / `uart`、attach の reset TLV、キャプチャの世代。変更履歴を参照）。oep-client-python の fake の
probe（119 件の試験）と台本のデバイスで試しています。ブラウザの経路、DFU、ページは、まだ実機で確かめていません。

v1 の凍結までは仕様が壊れることがあり、この package は probe の firmware
（[OpenEmbeddedProbe](https://github.com/Open-Embedded-Probe/oep-probe-arduino)）と
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python) と一緒に、すぐに追います。

## 構成

| 場所 | npm の入口 | 中身 |
|---|---|---|
| `src/` | `oep-client-js` | 環境に依らない核（`dist/oep-client.js` にバンドル） |
| `src/browser/` | `oep-client-js/browser` | WebSerial、WebUSB、WebHID |
| `src/node/` | `oep-client-js/node` | シリアルの口、USB、TCP |
| `web/` | - | Web ページ（`site/` にビルドして GitHub Pages へ。npm の配布物には入れない） |
| `test/` | - | `node:test`。oep-client-python の fake に TCP でつなぐ |

JSDoc の型付きの JavaScript（`// @ts-check`、`tsc` で確かめる）、ES モジュール、実行時の依存なし。WebUSB、WebSerial、WebHID は
Chromium 系のブラウザ（Chrome、Edge）と HTTPS が要ります。

## 開発

```sh
npm install
npm test            # python -m pip install oep-client-python（fake の probe）が要る
npm run typecheck
npm run serve       # http://localhost:4173/ でページ
```

## 文書

- [設計](docs/design.ja.md): 層、経路、ページでできること、試験、registry、版
- [リリースの手順](docs/release.ja.md)
- [変更履歴](CHANGELOG.md)

## ライセンス

MIT
