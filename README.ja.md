# OEP Probe Tool（oep-client-js）

[English](README.md)

ボードを [Open Embedded Probe（OEP）](https://github.com/Open-Embedded-Probe/oep-spec) のプローブにし、設定して保守し、作業をする
道具へ渡すための Web ページです。GitHub Pages で動きます: <https://open-embedded-probe.github.io/oep-client-js/>。
このリポジトリはそのページと、ページが使う JavaScript の OEP の host のコードです。npm には出しません。

## ページでできること

1. **プローブを作る・ファームを更新する**: ESP32 / P4 / P4X は USB シリアルから、Pico / Pico 2 は BOOTSEL で、P4 / P4X の更新は
   USB の DFU で。イメージは最新の oep-probe-arduino の Release のもの。
2. **つないで、何かを見る**: USB シリアル（Web Serial）、USB（OEP の機器、WebUSB）、USB HID（WebHID）。個体、ファーム、経路、
   宣言された機能。
3. **設定する**: 待機と使わせないピン、シリアルモニタへのログの素通し、Wi-Fi、USB の経路。保存は 1 か所。設定とメモ欄を 1 つの
   OEP の設定のファイルにエクスポート・インポートする。
4. **ターゲットへの配線を登録する**: プローブのピンの名前、相手の型番、デバッグ線の接続確認（そのピンで応答する ID）。
5. **ほかの道具で使う**: IDE（CH32、Python のブローカー越しの RP2040）、シリアルモニタ、WireSkein、Python に、このプローブの
   アドレスと使うコマンドを渡す。

作業そのもの ― デバッグ、ログを読む、波形を取る、バス・信号、自動試験 ― は
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python)、WireSkein、IDE が行い、このページはしません。
機器を扱うにはデスクトップの Chrome か Edge と、HTTPS（か localhost）が要ります。画面は英語と日本語です（既定はブラウザの言語、
ヘッダの選択で変えられる）。

画面は [docs/page.ja.md](docs/page.ja.md) に、[接続引継ぎ](docs/page-connection.ja.md)、[受入条件](docs/page-acceptance.ja.md)
とともに決めています。

## 状態

**OEP v1 の凍結の前です。仕様はまだ壊れることがあり、すぐに追います。** プローブのファーム
（[oep-probe-arduino](https://github.com/Open-Embedded-Probe/oep-probe-arduino)）と oep-client-python と一緒です。実装する仕様は、
`test/vectors` の写し元の oep-spec の commit です（`v0.x` のタグはまだ無い。oep-spec versioning §6）。隣に oep-spec の checkout が
あれば、試験がその写しと照らし合わせます。変更の履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

## コード

| 場所 | 中身 |
|---|---|
| `src/` | 環境に依らない OEP の host: registry（oep-spec から生成）、フレーム（COBS + CRC、length）、メッセージ、リンク（送り直し、transports §5 の立て直し、HID の丸ごとのフレーム）、host（confirm、セッション、ロック、restart）、describe、設定と設定のファイル、メモ欄、`dump`、デバッグ線の接続確認（`wire.js`）、ファーム（Release の一覧、PICOBOOT、DFU） |
| `src/browser/` | Web Serial、WebUSB（vendor bulk）、WebHID（count と first の report、transports §1） |
| `src/node/` | TCP だけ: 試験が oep-client-python の仮想ベンチにつなぐため |
| `web/` | ページ。GitHub Pages 向けに `site/` へビルドする |
| `test/` | `node:test`。oep-client-python の仮想ベンチと oep-spec の試験ベクタに対して |
| `scripts/` | 試験の起動、ブラウザの試験、サイトのビルド、ファームの取得、実機の HID の確認 |

JSDoc の型付きの JavaScript（`// @ts-check`、`tsc` で確かめる）、ES モジュール、実行時の依存なし。サイトだけが ESP の ROM への
書き込みに固定版の esptool-js を同梱します。

## 開発

```sh
npm install
uv sync --project test/virtual-bench --locked            # 固定した仮想ベンチ（docs/testing.ja.md）
OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
npm run test:browser   # Chromium と Python の仮想プローブでページを確かめる
npm run serve          # http://localhost:4173/ でページ
```

`npm run serve` は初回に配布イメージを `.cache/firmware` に取得します（`node scripts/fetch-firmware.js` で取り直す）。

## 文書

- [設計](docs/design.ja.md): 層、経路、ページのコード、試験、registry
- [試験](docs/testing.ja.md)
- [ページの公開](docs/publish.ja.md)
- OEP の仕様: [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)（凍結までは日本語の文書が正）―
  [README](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/README.ja.md)、
  [core](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/oep-core.ja.md)、
  [適合](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/conformance.ja.md)

## ライセンス

MIT
