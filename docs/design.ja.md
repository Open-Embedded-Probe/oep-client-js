# 設計

[English](design.md) | 日本語

oep-client-js の構成と、何をどこに置くか、何を作らないか。

## 1. 何のためのものか

- ブラウザと Node から OEP の probe と話す、JavaScript の host の実装です。[oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)
  の v1（`docs/oep-core.ja.md` と `interfaces/*.ja.md`）に従います。
- 同じライブラリを使った Web ページ（「OEP Probe Tool」）を GitHub Pages に置きます。probe の設定と firmware の更新を、ブラウザだけで
  できるようにします。
- Python の [oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python) と対になります。仕様を追う道具の 1 つで、
  仕様を壊すときは、ほかの道具と一緒に直します。

## 2. 構成

```text
src/            ライブラリ（環境に依らない核）         -> npm の "oep-client-js"（dist/oep-client.js にバンドル）
  index.js        入口。VERSION と、核の公開 API
  ほか            フレーム（cobs.js）、メッセージ、link、host、core、settings、各インターフェース（fixture.js、capture.js、riscv.js、arm.js、console.js など）、
                  registry.js（生成物）
src/browser/    ブラウザの経路                         -> npm の "./browser"
  index.js        WebSerial、WebUSB（vendor bulk、DFU）、WebHID
src/node/       Node の経路                            -> npm の "./node"
  index.js        シリアルの口（serialport）、USB（usb）、TCP（node:net。mDNS の DNS-SD で見つける: discovery.js、node:dgram）
web/            Web ページのソース                      -> site/（scripts/build-site.js）-> GitHub Pages
test/           試験（node:test）。Python の仮想ベンチに TCP でつなぐ
scripts/        build、サイト、試験、リリースの道具
docs/           この文書、リリースの手順
```

- 核は DOM も Node の API も使いません（`globalThis` の `crypto.getRandomValues` と `TextEncoder` だけ）。経路は「バイトを送る、
  受け取る」だけの小さな形で差し替えます。
- `site/` は npm の配布物に入れません（Web ページは Pages から配ります）。`src/node/` も `site/` に入れません。
- 型は JSDoc で書き、`// @ts-check` と `tsc --noEmit` で確かめます。TypeScript では書きません。型定義（`types/`）は `tsc` が
  JSDoc から作ります。
- OEPライブラリの実行時依存は増やしません。サイトだけにESP ROM書き込み用の固定版esptool-jsをbundleします。Node の `serialport` と `usb` はネイティブのモジュールなので、使う人が入れる任意の依存にします
  （ブラウザだけで使う人には入らない）。

## 3. 経路

| 経路 | ブラウザ（`./browser`） | Node（`./node`） | フレーム（transports §1） |
|---|---|---|---|
| USB CDC、USB-Serial/JTAG、USB-UART bridge | WebSerial | serialport | COBS + CRC |
| vendor bulk（class 0xFF） | WebUSB | usb（WebUSB と同じ形） | length(u16) message |
| vendor HID | WebHID | node-hid（任意） | report に詰めた length message |
| TCP（Wi-Fi の probe、ローカルのブローカー、試験の仮想ベンチ） | - | node:net | length(u16) message |

- TCP は Node だけです: ブラウザは TCP の接続を開けず mDNS も送れないので、ページに TCP はありません。TCP の probe は
  transports §3 のとおりに見つけます ― mDNS の DNS-SD `_oep._tcp`、port は SRV の record のもの（決まった port は無い）、TXT の
  `unit_id` ― `browse()` / `findUnit()` / `portOf()`（src/node/discovery.js、依存なし。問い合わせは IPv4 の口すべてから送る）で見つけるか、host と port を渡します
  （`openTcp({ host, port })`）。`openTcp({ unitId })` は開いた後に describe の unit_id を確かめます。`oep` は登録した service の
  名前ではないので、browse で見つけたものは使う前に確かめます（host ガイド §4.1）: `verify` / `browse({ verify: true })` と
  `findUnit()`（既定）は、confirm に答え、describe の unit_id が TXT のものと同じ instance だけを残します。

- WebUSB、WebSerial、WebHID は Chromium 系（Chrome、Edge）だけで、ページは HTTPS（か localhost）で配る必要があります。
- probe の見分け方は transports §3 のとおりです: 自動で見分けるのはプロジェクトの USB の VID:PID `1209:4F45` だけ（`PROJECT_VID_PIDS`。
  registry の `usb` から）。unit_id で名指した probe は USB の serial がそれと同じ device で、describe の unit_id も同じでなければならない
  （`connect({ unitId })`、違えば `UnitIdMismatch`）。開いた経路には、まず confirm だけを送り、正しい応答が無ければ閉じる（`NotOepProbe`）。
  WebUSB / WebHID の選択の既定の filter はこの VID:PID（`PROJECT_USB_FILTERS`。WebHID は OEP の collection、usage page 0xFF4F /
  usage 0x45 も）。WebSerial の選択には既定の filter を付けない（UART bridge や内蔵の USB serial はこの VID:PID にならない）。
  `PROJECT_SERIAL_FILTERS` で probe だけに絞れる。Node では `findUsbProbes` と `findSerialProbes` が、この VID:PID の device と CDC の口を
  並べ、`findProbes` は口の種類にかかわらず device ごとに 1 つを並べる。何も指定しない `openUsb()` はそこにプローブがちょうど 1 つならそれを（vendor bulk、無ければその CDC の口）開き、2 つ以上なら何も開かず `SeveralProbesError` が各プローブ（unit id、口）を並べるので 1 つを指定する。iProduct はどこも見ない。probe の中の口は interface の値で選ぶ（registry の `usb`）。

## 4. Web ページ

次期画面の目的、機能の範囲、遷移は [要件定義・画面仕様](page.ja.md)、接続の継続条件は [引継ぎ仕様](page-connection.ja.md)、実装との差分と検証は [受入条件](page-acceptance.ja.md) を参照します。これらは再設計の仕様案です。

現行のページは接続後の作業を中心に構成しています。接続先の登録、GPIO/UART/I2C/SPI/PWM/カウンタ/DAC、ターゲットの調査・操作、
設定とメモ領域の管理、プローブ自身の firmware 更新を扱います。キャプチャは WireSkein へ、ターゲット固有の flash 書き込みは
対応する外部ツールへ進む導線を用意します。

- `web/app.js`: 接続・セッションと各作業画面。`web/signals.js`: 宣言された入出力機能の操作フォーム。
- `web/model.js`: 入力検証、ルーティング、表示用の値の変換。`web/boards.js`: ボードの案内。
- `web/oep-client.js`: ソース上の公開 API 入口。サイトビルド時に `site/src/` を参照する入口へ置き換えます。
- `tsconfig.web.json` で画面のコードも検査し、`npm run test:browser` で Chromium と Python 仮想プローブによる操作を確認します。

## 5. 気を付けること

- **Release のファイルと CORS**: GitHub の Release のファイルはブラウザから直接取れません（CORS のヘッダが無い）。firmware は
  Pages にも置くか、利用者にファイルを選んでもらいます。
- **ロック**: ページもほかの host と同じくロックを取ってから操作し（core §6）、誰が持っているかを見せ、閉じるときに end します。end せずに再読み込みや閉じたページの
  セッションは lease まで残る（transports §3）ので、`connect` はセッションの id を unit_id ごとに localStorage に残し、次のページの
  最初の open が先にそれを終えます（host ガイド §5）。
- **経路の失敗**（core §5.2、host ガイド §8）: 送り直しにも応答が無い要求は `TransportFailed` を投げます。その要求と、一緒に出ていた要求の
  結果は分かりません。link は次の要求を出す前に confirm で立て直し、boot_id が変わっていれば再起動として見えます（`host.epoch`）。
  ページは、状態を変える操作を繰り返す前に、状態を読み直します。
- **使わない probe**: core §7.1 の範囲の外の confirm、1..600000 の外の max_op_ms は `NotUsable` を投げ、host はその probe に
  もう何も送りません（C-20、C-47）。ページは値を添えて理由を見せます。
- **VS Code**: 拡張機能（Node）からは `./node` を使えますが、ネイティブのモジュールは VS Code（Electron）の版に合わせたビルドが
  要ります。Webview からは WebSerial / WebUSB を使えません。

## 6. 試験

- `node:test` で書き、`npm test` で走らせます。
- probe の代わりに、oep-client-python の仮想ベンチを使います（`python -m oep_client.virtual_bench_serve` の TCP。probe とその先の
  target、治具の配線を実際の治具に合わせて作ったもの）。Python の試験と同じ仮想ベンチが相手なので、同じ振る舞いを確かめられます。CI は oep-client-python を main の branch（git）から入れます。
- ブラウザの経路は、実機で確かめます（手順は [リリースの手順](release.ja.md)）。

## 7. 番号（registry）

番号の唯一の定義は oep-spec の `registry/oep-v1.toml` です。Python と C++ と同じく、oep-spec の生成器が JS の定数
（`generated/oep-v1/oep_v1_registry.js`）を作り、それを `src/registry.js` に写します（手で書かない）。
oep-spec の試験ベクタ（`tests/vectors/*.json`）も同じく `test/vectors/` に写し、`test/vectors.test.js` で確かめます（隣に
oep-spec の checkout があれば写しが同じかも比べる）。

## 8. 版と仕様

- v1 の凍結までは、仕様を壊す変更をどの道具も一度に追います。版は独自に数えますが、各リリースの変更履歴に、話せる probe の
  firmware（OpenEmbeddedProbe）と、試験に使った oep-client-python の版を書きます。
- 凍結の前に npm へ出すかどうかは、使う人がいるかで決めます。凍結前の API は予告なく変わります。
