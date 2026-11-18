# oep-client-js

[English](README.md)

npm: `oep-client-js`（リポジトリと同じ。PyPI の oep-client-python と対）。

[Open Embedded Probe（OEP）](https://github.com/Open-Embedded-Probe/oep-spec) の、JavaScript の host の実装です。ブラウザと Node から
OEP の probe と話し、設定し、firmware を更新します。これを使った Web ページ **OEP Probe Tool** を GitHub Pages に置きます:
<https://open-embedded-probe.github.io/oep-client-js/>。

## 状態

**v1 の凍結の前に、ひととおり移した版です。仕様が固まるにつれて作り直す前提です。**

**実装する仕様: `test/vectors` の写し元の oep-spec の commit**（`v0.x` のタグはまだ無い。oep-spec versioning §6 ― 凍結の前は revision 1
だけでは形が決まらないので、実装は実装する仕様を名乗る）。隣に oep-spec の checkout があれば、試験がその写しと照らし合わせます。
変更の履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

凍結までは日本語の文（`.ja.md`）が仕様の作業の文。

対象はプローブの設定と保守です。対応する場面:

1. **プローブを作る・ファームを更新する**: ESP32 / P4 / P4X は USB シリアルから（ページの esptool-js）、Pico / Pico 2 は BOOTSEL と
   WebUSB での PICOBOOT（`rp2ResetToBoot`、`rp2Write`）、P4 / P4X の更新は USB の DFU。イメージは Release の firmware-<version>.json
   から選ぶ（`fetchFirmwareManifest`、`pickFirmware`、`verifyFirmware`）。
2. **つながるかと、何を宣言しているかを確かめる**: 経路、confirm、list と describe、`dump`（インターフェースごとの宣言を文か JSON で。
   core §1.2 が求めるもので probe が出さなかったものも）。
3. **設定し、控えて戻す**: 設定（core §13: ラベル、待機と使わせないピン、ログの素通し、Wi-Fi、保存と再起動つきの `usb.transports`）、
   設定ファイル、メモ領域（`oep.probe.memo`、口の記録 `oep.probe.memo/port/<口>`）。
4. **ターゲットへの配線を登録して確かめる**: ラベルと口の記録。デバッグ線の接続確認（`wire.Wire.check`: ピンで attach し、応答した
   ID ― rvswd / swio は DMSTATUS、swd は DPIDR。SWD で応答が無ければ RP2040 の multidrop の core 0 も試す ― を読んで detach）。
5. **作業をする道具へ引き継ぐ**: デバッグ（IDE、oep-client-python）、ログ（素通しを通したシリアルモニタ、oep-client-python）、
   取り込み（WireSkein）、バス・信号・相手役（oep-client-python）。この package はそれらの作業をしない。

部品:

- 核: registry（oep-spec から生成）、フレーム（COBS + CRC、length）、メッセージ、リンク（corr の照合、待ちの後に 1 回の送り直し、
  持っているシリアルの口で壊れたフレームが来たらすぐ 3 回までの送り直し（host ガイド §8）、パイプライン、push と出来事。応答はどれも
  core §4.4 の下限 ― 引数の時間 + 1000 ms + シリアルの口の転送時間、`Link.waitFloorMs` ― 以上待つ。length のフレームでの
  transports §5 の立て直しは、host の最後の書き込みから 250 ms 待ってから confirm し、vendor bulk では静かになるのを lease の最長まで
  待ち、HID では待たない（report の first でフレームを見つけ直す、transports §1）。フレームの途中の休みでは立て直さない。送り直しにも
  応答が無ければ経路の失敗 `TransportFailed` で、次の要求の前に confirm で立て直す（COBS でも）。header より短いフレームは壊れた
  フレーム。シリアルの口の最初の confirm は port_speed_idle_ms + host_wait_add_ms のあいだ繰り返す（別の host が上げた速さはそれまでに
  戻る）、host（confirm ― `limits.transport`。2 回目からは使っている revision を求める。core §7.1 の範囲の外、1..600000 の外の
  max_op_ms、core §7.4 の形の外の fn 0 の ops は probe を `NotUsable` に、fn の ops がその形の外ならその fn を `FnNotUsable` に ―、
  `clock()`、セッション ― open のたびに新しい乱数の id。経路が閉じても終わらないので、`connect`（`keepSession`、既定で有効）は開いた
  セッションの id を probe ごとに残す ― Node は `$OEP_SESSION_DIR`、`$XDG_RUNTIME_DIR/oep-client` か利用者の cache の
  `<unit_id>.session`（oep-client-python と同じファイル）、ブラウザは localStorage と Web Lock ― 次の実行の最初の open がそれをすぐ
  終える（`Host.endPrevious`、`keptsession.KeptSession`、host ガイド §5）―、ロック、restart ― `requestRestart()` と
  `restartProbe({ reopen, waitMs })`、probe の restart_max_ms まで繰り返す ―、list / describe、plan）
- 設定（settings.js）: `new Settings(host)`: `catalog()` はこの起動の名前、`show()` はすべての値を `{ category, name, value }` で、
  `setNamed(category, { flat: value })` / `unsetNamed` / `unsetAll`、生の `set` / `unset`、`save()`、`state()`、`needsSave()`、
  `network()`。`export()` / `planImport(doc)` / `applyImport(plan)` は設定ファイル（oep-client-python docs/oep-settings-file.ja.md）。
  `findLine(source, name, { port })` は host ガイド §5.3 の線の探し方（口 S の線 N はラベル `S.N`）。秘密の値（Wi-Fi のパスフレーズ）は
  読まない: get はデータを返さず、`show()` とファイルは `{ secret: true }`。set で 0 byte を送ると保つ
- 経路: ブラウザは WebSerial、WebUSB（vendor bulk）、WebHID（`oep-client-js/browser`）。シリアルの口は 8N1、フロー制御なし、DTR と
  RTS を立てて開く（transports §4）。USB の probe はプロジェクトの VID:PID `1209:4F45` だけで見つける（transports §3: WebUSB / WebHID の
  選択の既定の filter）。WebSerial の選択には既定の filter が無く、UART の変換チップや内蔵の USB シリアルも選べる。Node
  （`oep-client-js/node`）は TCP だけで、`openTcp({ host, port })`: 試験の仮想ベンチ、ローカルのブローカー、host と port で指定する
  ネットワーク上の probe
- そのほか: `Unsupported.supported`（confirm の範囲）。`x-` の unit_id は USB の機器を名指さない。答えの文は制御文字を除いて示す
  （`message.shown`）。open の owner は文字の切れ目で切る（`ownerText`）。probe が断るラベルは送らない

oep-client-python の仮想ベンチ（probe とその先の target、治具の配線を実際の治具に合わせて作ったもの:
`python -m oep_client.virtual_bench_serve`）と台本のデバイスで試しています（oep-spec の試験ベクタを含み、sessions.json、
ops.json、ops_encoding.json、hid_reports.json も）。ブラウザの経路、DFU、ページは、まだ実機で確かめていません。

v1 の凍結までは仕様が壊れることがあり、この package は probe の firmware
（[OpenEmbeddedProbe](https://github.com/Open-Embedded-Probe/oep-probe-arduino)）と
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python) と一緒に、すぐに追います。

## 構成

| 場所 | npm の入口 | 中身 |
|---|---|---|
| `src/` | `oep-client-js` | 環境に依らない核（`dist/oep-client.js` にバンドル） |
| `src/browser/` | `oep-client-js/browser` | WebSerial、WebUSB、WebHID |
| `src/node/` | `oep-client-js/node` | TCP |
| `web/` | - | Web ページ（`site/` にビルドして GitHub Pages へ。npm の配布物には入れない） |
| `test/` | - | `node:test`。oep-client-python の仮想ベンチに TCP でつなぐ |

JSDoc の型付きの JavaScript（`// @ts-check`、`tsc` で確かめる）、ES モジュール、実行時の依存なし。WebUSB、WebSerial、WebHID は
Chromium 系のブラウザ（Chrome、Edge）と HTTPS が要ります。

## 開発

```sh
npm install
npm test            # explicit virtual backend setup: docs/testing.ja.md
npm run typecheck
npm run serve       # http://localhost:4173/ でページ
npm run test:browser # ChromiumとPython仮想プローブで画面操作を確認
```

ブラウザのページは[要件定義・画面仕様](docs/page.ja.md)、[接続引継ぎ](docs/page-connection.ja.md)、[受入条件](docs/page-acceptance.ja.md)に沿って作っています。
OEPの紹介と用途・ボードの説明（機器なしで読める）、プローブの作成（ESP32・P4・P4XはUSBシリアル、Pico・Pico 2はBOOTSEL）から初期設定、配線と相手の記録（相手固定とコネクタ、複数の口）とデバッグ線の接続確認、用途ごとにこのページで準備することと作業をする道具、本体設定（素通し、待機状態、Wi-Fi、USBの接続経路）、更新・控え・復元・診断、IDE・WireSkein・Pythonへの引継ぎを扱います。
画面は英語と日本語です。既定はブラウザの言語で選び（どちらでもなければ英語）、ヘッダの選択でこのブラウザの言語を変えられます。S3/C3/C6は対応するmergedファームウェアイメージの持ち込みで導入します。CH32の初回書き込みは対象外です。実機での確認は、受入条件の §3.2 に残っています。
ESP書き込み用の固定版 `esptool-js` はサイトに同梱し、npmライブラリの実行時依存には加えません。
`npm run serve` は初回に配布ファームウェアイメージを取得し、`.cache/firmware` に保存します。再取得は `node scripts/fetch-firmware.js` で行えます。

## 文書

- 仕様: [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)（凍結までは日本語の文書が正。英語は凍結のときに作る）。まず [README](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/README.ja.md) と [レビューの手引き](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/review-guide.ja.md) から。
  [使い始める](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/getting-started.ja.md) が最小の probe と host を作り、
  [docs/oep-core.ja.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/oep-core.ja.md) がプロトコルの本体、
  [docs/conformance.ja.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/conformance.ja.md) が host の適合に要ること
- [設計](docs/design.ja.md): 層、経路、ページでできること、試験、registry、版
- [リリースの手順](docs/release.ja.md)
- [変更履歴](CHANGELOG.md)

## ライセンス

MIT
