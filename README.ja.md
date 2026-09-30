# oep-client-js

[English](README.md)

npm: `oep-client`（リポジトリの名前は oep-client-js）。

[Open Embedded Probe（OEP）](https://github.com/Open-Embedded-Probe/oep-spec) の、JavaScript の host の実装です。ブラウザと Node から
OEP の probe と話し、設定し、firmware を更新します。これを使った Web ページ **OEP Probe Tool** を GitHub Pages に置きます:
<https://open-embedded-probe.github.io/oep-client-js/>。

## 状態

**骨組みだけで、まだ何も実装していません。** 構成、リリースの道具、設計を置いたところです。コードは次の順に足します
（[設計](docs/design.ja.md) §4）:

1. oep-spec の registry から生成した番号
2. ページからの probe の firmware の更新（ESP32-P4 は WebUSB で DFU、ESP32 は esptool-js、RP2 は UF2 の手順）
3. 核（フレーム、セッションとロック、describe）と probe の設定（`oep.probe.config`）
4. 標準インターフェース（v1 の仕様が凍結されてから）

v1 の凍結までは仕様が壊れることがあり、この package は probe の firmware
（[OpenEmbeddedProbe](https://github.com/Open-Embedded-Probe/oep-probe-arduino)）と
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python) と一緒に、すぐに追います。

## 構成

| 場所 | npm の入口 | 中身 |
|---|---|---|
| `src/` | `oep-client` | 環境に依らない核（`dist/oep-client.js` にバンドル） |
| `src/browser/` | `oep-client/browser` | WebSerial、WebUSB、WebHID |
| `src/node/` | `oep-client/node` | シリアルの口、USB、TCP |
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
