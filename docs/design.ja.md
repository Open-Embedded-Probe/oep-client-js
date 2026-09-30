# 設計

[English](design.md) | 日本語

oep-client-js の構成と、何をどこに置くか、何を作らないか。実装はまだ無く、この文書が骨組みの目印です。

## 1. 何のためのものか

- ブラウザと Node から OEP の probe と話す、JavaScript の host の実装です。[oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)
  の v1（`docs/oep-core.ja.md` と `docs/oep-if-*.ja.md`）に従います。
- 同じライブラリを使った Web ページ（「OEP Probe Tool」）を GitHub Pages に置きます。probe の設定と firmware の更新を、ブラウザだけで
  できるようにします。
- Python の [oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python) と対になります。仕様を追う道具の 1 つで、
  仕様を壊すときは、ほかの道具と一緒に直します。

## 2. 構成

```text
src/            ライブラリ（環境に依らない核）         -> npm の "@open-embedded-probe/oep-client"（dist/oep-client.js にバンドル）
  index.js        入口。VERSION と、核の公開 API
  (これから)      frame、message、session、core、describe、config、各インターフェース、registry（生成物）
src/browser/    ブラウザの経路                         -> npm の "./browser"
  index.js        WebSerial、WebUSB（vendor bulk、DFU）、WebHID
src/node/       Node の経路                            -> npm の "./node"
  index.js        シリアルの口（serialport）、USB（usb）、TCP（node:net）
web/            Web ページのソース                      -> site/（scripts/build-site.js）-> GitHub Pages
test/           試験（node:test）。Python の fake に TCP でつなぐ
scripts/        build、サイト、試験、リリースの道具
docs/           この文書、リリースの手順
```

- 核は DOM も Node の API も使いません（`globalThis` の `crypto.getRandomValues` と `TextEncoder` だけ）。経路は「バイトを送る、
  受け取る」だけの小さな形で差し替えます。
- `site/` は npm の配布物に入れません（Web ページは Pages から配ります）。`src/node/` も `site/` に入れません。
- 型は JSDoc で書き、`// @ts-check` と `tsc --noEmit` で確かめます。TypeScript では書きません。型定義（`types/`）は `tsc` が
  JSDoc から作ります。
- 依存は増やしません。Node の `serialport` と `usb` はネイティブのモジュールなので、使う人が入れる任意の依存にします
  （ブラウザだけで使う人には入らない）。

## 3. 経路

| 経路 | ブラウザ（`./browser`） | Node（`./node`） | フレーム（core §3.1） |
|---|---|---|---|
| USB CDC、USB-Serial/JTAG、USB-UART bridge | WebSerial | serialport | COBS + CRC |
| vendor bulk（class 0xFF） | WebUSB | usb（WebUSB と同じ形） | length(u16) message |
| vendor HID | WebHID | node-hid（任意） | report に詰めた length message |
| TCP（ローカルのブローカー、試験の fake） | - | node:net | length(u16) message |

- WebUSB、WebSerial、WebHID は Chromium 系（Chrome、Edge）だけで、ページは HTTPS（か localhost）で配る必要があります。
- probe の見分け方は core §3.3 のとおりです（OEP の VID:PID か、取るまでは iProduct が `OEP` で始まる。USB の serial が unit_id）。

## 4. Web ページでできること（順番）

1. **probe の firmware の更新**（OEP の外。仕様の変更に巻き込まれない）
   - ESP32-P4: WebUSB で DFU（`OepProbe-esp32p4-<version>.bin`）。
   - ESP32（USB-Serial/JTAG、UART bridge）: esptool-js で merged.bin を 0x0 に。
   - RP2040 / RP2350: BOOTSEL のドライブにコピーする手順の案内（ブラウザからドライブには書けない）。
   - どの firmware も `firmware-<version>.json` の sha256 で照合します。
2. **つなぐ、見る**: 経路を選んでつなぎ、describe を全部見せる（`oep dump` と同じ）。
3. **設定**（`oep.probe.config`）: スロット、bind、plan、ラベル、空きのときの状態の表示と編集、保存と消去。画面は describe から
   組み立てます（スロットの数、bind の方式、扱う項目）。
4. **簡単な操作**: GPIO の読み書き、UART の端末、target の attach / halt / resume / reset、target のコンソール。

作らないもの: キャプチャの表示（[WireSkein](https://github.com/Open-Embedded-Probe/wireskein) の担当）、target への書き込み
（ch32rv などの担当）。

## 5. 気を付けること

- **Release のファイルと CORS**: GitHub の Release のファイルはブラウザから直接取れません（CORS のヘッダが無い）。firmware は
  Pages にも置くか、利用者にファイルを選んでもらいます。
- **ロック**: ページもほかの host と同じくロックを取ってから操作し（core §6）、誰が持っているかを見せ、閉じるときに end します。
- **VS Code**: 拡張機能（Node）からは `./node` を使えますが、ネイティブのモジュールは VS Code（Electron）の版に合わせたビルドが
  要ります。Webview からは WebSerial / WebUSB を使えません。

## 6. 試験

- `node:test` で書き、`npm test` で走らせます。
- probe の代わりに、oep-client-python の fake を使います（`python -m oep_client.fake_serve` の TCP）。Python の試験と同じ fake が
  相手なので、同じ振る舞いを確かめられます。CI は PyPI から oep-client-python を入れます。
- ブラウザの経路は、実機で確かめます（手順は [リリースの手順](release.ja.md)）。

## 7. 番号（registry）

番号の唯一の定義は oep-spec の `registry/oep-v1.toml` です。Python と C++ と同じく、oep-spec の生成器が JS の定数
（`generated/oep-v1/oep_v1_registry.js`）を作り、それを `src/registry.js` に写します（手で書かない）。生成器の JS の出力は
これから oep-spec に足します。

## 8. 版と仕様

- v1 の凍結までは、仕様を壊す変更をどの道具も一度に追います。版は独自に数えますが、各リリースの変更履歴に、話せる probe の
  firmware（OpenEmbeddedProbe）と、試験に使った oep-client-python の版を書きます。
- 凍結の前に npm へ出すかどうかは、使う人がいるかで決めます。凍結前の API は予告なく変わります。
