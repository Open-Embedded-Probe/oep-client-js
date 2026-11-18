# 設計

[English](design.md) | 日本語

OEP Probe Tool とそのコードの構成と、何をどこに置くか、何をしないか。

## 1. 何のためのものか

- ボードを OEP のプローブにし、設定して保守し、作業をする道具へ渡すための、GitHub Pages の Web ページ。画面は
  [画面仕様](page.ja.md)に決めています。
- ページが使う JavaScript の OEP の host。[oep-spec](https://github.com/Open-Embedded-Probe/oep-spec) の v1（`docs/oep-core.ja.md`、
  `docs/oep-transports.ja.md`、`docs/oep-settings-file.ja.md` と、使うインターフェース）に従います。
- ほかの人のためのライブラリではなく、npm には出しません。コードからプローブを使うこと ― デバッグ、取り込み、バスと信号、相手役、
  自動試験 ― は [oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python) と、WireSkein、IDE が受け持ちます。
  仕様を壊すときは、それらと一緒に直します。

## 2. 構成

```text
src/            環境に依らない OEP の host
  index.js        VERSION と、各モジュールの名前空間
  ほか            フレーム（cobs.js）、メッセージ、link、host、core（list、describe、plan、restart）、設定と設定のファイル、
                  memo、dump、デバッグ線の接続確認（wire.js）、ファーム（firmware.js、picoboot.js、dfu.js）、registry.js（生成物）
src/browser/    Web Serial、WebUSB（vendor bulk、DFU、PICOBOOT）、WebHID
src/node/       TCP（node:net）: 試験が Python の仮想ベンチにつなぐため
web/            ページ                                      -> site/（scripts/build-site.js）-> GitHub Pages
test/           node:test。Python の仮想ベンチと oep-spec の試験ベクタに対して
scripts/        試験の起動、ブラウザの試験、サイトのビルド、ファームの取得、実機の HID の確認
docs/           この文書、画面、試験、公開
```

- 核は DOM も Node の API も使いません（`globalThis` の `crypto.getRandomValues` と `TextEncoder` だけ）。経路は「バイトを送る、
  受け取る」だけの小さな形（`Link` の `Transport`）で差し替えます。
- `src/node/` は `site/` に入れません。
- 型は JSDoc で書き、`// @ts-check` と `tsc --noEmit`（ページは `tsconfig.web.json`）で確かめます。TypeScript では書きません。
- 実行時の依存はありません。サイトだけが ESP の ROM への書き込みに固定版の esptool-js を同梱します。

## 3. 経路

| 経路 | ページ（`src/browser/`） | 試験（`src/node/`） | フレーム（transports §1） |
|---|---|---|---|
| USB CDC、USB-Serial/JTAG、USB-UART bridge | Web Serial | - | COBS + CRC |
| vendor bulk（class 0xFF） | WebUSB | - | length(u16) message |
| vendor HID | WebHID | - | count(u16) と first(u16) を持つ report に入れた length の列 |
| TCP | - | node:net | length(u16) message |

- Web Serial、WebUSB、WebHID は Chromium 系（Chrome、Edge）だけで、HTTPS（か localhost）が要ります。ブラウザは TCP を開けないので、
  ページに TCP はありません。
- プローブの見分け方は transports §3 のとおりです: 自動で見分けるのはプロジェクトの USB の VID:PID `1209:4F45` だけ（`PROJECT_VID_PIDS`、
  registry の `usb` から）。開いた経路にはまず confirm だけを送り、正しい応答が無ければ閉じます（`NotOepProbe`）。unit_id で名指した
  プローブは describe の unit_id が同じでなければなりません（`UnitIdMismatch`）。WebUSB / WebHID の選択の既定の filter はこの VID:PID
  （WebHID は OEP の collection、usage page 0xFF4F / usage 0x45 も）。Web Serial の選択には付けません（UART bridge や内蔵の USB
  シリアルはこの VID:PID にならない）。iProduct はどこも見ません。
- HID: 読む側は丸ごとのフレームだけを渡し、report が欠けたら各 report の first でフレームを見つけ直します。そのため HID の立て直しは
  読み捨てず、静かになるのを待ちません（transports §5）。vendor bulk は静かになるのを lease の最長まで待ちます。
  `node scripts/check-hid.mjs` は、ページの WebHID のコードを実機の Linux hidraw 越しに動かします。

## 4. ページ

`web/` の分け方: `app.js`（スタート、プローブを作る、つなぐ、画面の振り分け）、`common.js`（プローブの帯、タブ、次へ）、`wiring.js`
（配線の一覧と、入力のその場の確認と接続確認つきの編集）、`probe.js`（概要、素通しを含む本体設定、ほかの道具で使う、保守）、`device.js`
（接続中のプローブへの操作のすべて）。画面は `device.js` だけを通してプローブに触れ、開く・保存・画面の移動では attach・ピンの割当・
出力をしません（接続確認は求められたときだけ attach し、すぐ detach する）。

- `web/data.js`: ボード、用途（このページで準備することと、作業をする道具）、資料。
- `web/boards.js`: ボードの機能。`web/model.js`: 接続名とファームの版。
- `web/esp-flash.js`: esptool-js での ESP の ROM への書き込みと、その後のファームへのリセット。
- `web/oep-client.js`: ページのためのコードの入口。サイトのビルドで `site/src/` を指すものに置き換えます。

## 5. 気を付けること

- **Release のファイルと CORS**: GitHub の Release のファイルはブラウザから取れません（CORS のヘッダが無い）。Pages のビルドが、
  最新の Release のイメージをページの横に写します（`scripts/fetch-firmware.js`）。
- **ロック**: ページは変更する操作の中でロックを取り（core §6）、lease は 10 秒で、つないでいる間 keepalive で延ばし、接続を終えると
  end します。end せずに再読み込みや閉じたページのセッションは lease まで残る（transports §3）ので、プローブは 10 秒以内に空きます。
  経路がひとりでに閉じる（ケーブルが抜けた）と、その場で気づき、つなぎ直すときに残ったセッションを先に終えます。
- **経路の失敗**（core §5.2、host ガイド §8）: 送り直しにも応答が無い要求は `TransportFailed` を投げます。その要求と、一緒に出ていた
  要求の結果は分かりません。link は次の要求の前に confirm で立て直し、boot_id が変わっていれば再起動として見えます（`host.epoch`）。
  ページは、状態を変える操作を繰り返さず、状態を読み直します。
- **使わないプローブ**: core §7.1 の範囲の外の confirm、1..600000 の外の max_op_ms は `NotUsable` を投げ、そのプローブにはもう何も
  送りません（C-20、C-47）。

## 6. 試験

- `node:test` で書き、`npm test` で走らせます。ページは `npm run test:browser` で Chromium で確かめます。[試験](testing.ja.md)を参照。
- プローブの代わりに、`test/virtual-bench/` に固定した oep-client-python の仮想ベンチ（`python -m oep_client.virtual_bench_serve` の
  TCP）を使います。Python の試験と同じ仮想ベンチです。
- 実機: ページを公開する前の確認は[ページの公開](publish.ja.md)にあります。

## 7. 番号（registry）

番号の唯一の定義は oep-spec の `registry/oep-v1.toml` です。oep-spec の生成器が JS の定数（`generated/oep-v1/oep_v1_registry.js`）を
作り、それを `src/registry.js` に写します（手で書かない）。oep-spec の試験ベクタ（`tests/vectors/*.json`）も同じく `test/vectors/` に
写し、`test/vectors.test.js` で確かめます（隣に oep-spec の checkout があれば写しが同じかも比べる）。

## 8. 版と仕様

- v1 の凍結までは、仕様を壊す変更をどの道具も一度に追います。変更履歴には、変わったときに oep-spec の commit、プローブのファーム、
  試験に使った oep-client-python を書きます。
- `VERSION`（ページの下に出る）は、区切りが欲しいときの印です（[ページの公開](publish.ja.md)）。npm の版はありません。
