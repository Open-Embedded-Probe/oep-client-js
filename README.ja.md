# oep-client-js

[English](README.md)

npm: `oep-client-js`（リポジトリと同じ。PyPI の oep-client-python と対）。

[Open Embedded Probe（OEP）](https://github.com/Open-Embedded-Probe/oep-spec) の、JavaScript の host の実装です。ブラウザと Node から
OEP の probe と話し、設定し、firmware を更新します。これを使った Web ページ **OEP Probe Tool** を GitHub Pages に置きます:
<https://open-embedded-probe.github.io/oep-client-js/>。

## 状態

**v1 の凍結の前に、ひととおり移した版です。仕様が固まるにつれて作り直す前提です。**

**実装する仕様: oep-spec の commit `0304f37`**（`v0.x` のタグはまだ無い。oep-spec versioning §6 ― 凍結の前は revision 1
だけでは形が決まらないので、実装は実装する仕様を名乗る）。2026-10-06 の単純化（10 byte の要求の見出し 1 つ、TLV の len は u16、
閉じた固定の形、describe の `ops` tag、再開なし）、コンソールの送りの列と reset の後の待ち（f0c68bf）、長い probe.config の項目
（d34dafa）、既存の connection に加わる attach（59dd028）と、2026-10-06 の構造（2e5dc4c〜9c837a9、0304f37）: 本体は名前を
持たない（fn 0、list に載らない）、plan と再起動と線の試験はインターフェース `oep.probe.plan`、`oep.probe.restart`、
`oep.probe.link`、subscribe / unsubscribe は通知を送るインターフェース自身の op 0x30 / 0x32（heartbeat は無い）、fn 0 の `clock` が
probe の時刻を返す、ops の値の符号は 1 つ（core §7.4）。凍結までは日本語の文（`.ja.md`）が仕様の作業の文。

入っているもの:

- 核: registry（oep-spec から生成）、フレーム（COBS + CRC、length）、メッセージ、リンク（corr の照合、1 回の送り直し、
  パイプライン、push と出来事。応答はどれも core §4.4 の下限 ― 引数の時間 + 1000 ms + シリアルの口の転送時間、
  `Link.waitFloorMs` ― 以上待つ。length のフレームでの transports §5 の立て直しは、host の最後の書き込みから 250 ms 待ってから confirm し、
  TCP のフレームの途中の休みでは立て直さない。送り直しにも応答が無ければ経路の失敗 `TransportFailed` で、次の要求の前に
  confirm で立て直す（COBS でも）。header より短いフレームは壊れたフレーム）、
  host（confirm ― この host が来た経路の番号 `limits.transport`、2 回目からは使っている revision を求める。core §7.1 の範囲の外の
  confirm、1..600000 の外の max_op_ms、core §7.4 の符号に合わない fn 0 の ops は、その probe を `NotUsable` にし、合わない fn の ops は
  その fn を `FnNotUsable` にする ―、`clock()` ― fn 0 の clock をこの host の `performance.now()` と突き合わせる:
  `{ hostBeforeMs, hostAfterMs, roundTripMs, uptimeNs, bootId }`。probe の時刻は往復の半分の不確かさで中点に当たる ―、セッション ― open はいつも新しい乱数の id を
  要求の見出しに置いて新しいセッションを開く。end、lease の期限切れ、force はセッションが作ったものをすべて解放し、終わった
  セッションの要求は `NoSession`（再開なし）―、ロック、購読 ― `subscribe(fn, minBytes, maxDelayMs)` / `unsubscribe(fn)`: fn 自身の
  op 0x30 / 0x32（core §11.3）―、再起動 ― `requestRestart()` と `restartProbe({ reopen, waitMs })`: oep.probe.restart（名前で探す）の
  restart の後、restart_after_answer_ms 待ち、`reopen` があればそれで開き直し（無ければ link のまま）、confirm する。probe の
  restart_max_ms（`core.restartMaxMs`。そのインターフェースの describe。restart の前に読む。宣言が無ければ 10 s）まで繰り返し、
  過ぎれば probe は無くなったものとして最後のエラーを投げる。新しい boot_id を返す。同じなら `NotRestarted` ―）、list / describe
  （fn ごとの `ops`: `core.ops` / `offers`、`Interface.ops()` / `.offers(op)`。`core.require` は送らずに、probe が答えるのと同じ
  detail unknown_operation の `Rejected` を投げる）/ plan（`core.planApply` / `planRelease` / `planRoles` は oep.probe.plan を名前で探す）
- インターフェース: debug の線（rvswd、swio、swd）と riscv-dm、ARM の ADI / MEM-AP / Cortex-M、target のコンソール、
  fixture（gpio、uart、i2c-target、spi-target）、キャプチャ（ロジック、アナログ、capture-group、sigrok の .sr）、probe.config、
  `oep dump` の表示
- 経路: ブラウザは WebSerial、WebUSB（vendor bulk）、WebHID。Node は TCP、シリアルの口（`serialport`）、USB（`usb`）
  （ネイティブの package は任意）。シリアルの口は 8N1、フロー制御なし、DTR と RTS を立てて開く（transports §4）。USB の probe は
  プロジェクトの USB の VID:PID `1209:4F45` だけで見つける（transports §3: WebUSB / WebHID の選択の既定の filter、Node の
  `findUsbProbes` / `findSerialProbes` / `findProbes`、`openUsb()` ― この VID:PID のプローブがちょうど 1 つならそれを vendor bulk で、
  無ければその CDC の口で開く。2 つ以上なら `SeveralProbesError` が並べるので 1 つを指定する）。WebSerial の選択には既定の
  filter を付けないので、UART bridge や内蔵の USB serial も選べる
- firmware の更新: USB の DFU（ESP32-P4）と、Release の firmware-<version>.json
- ページ: つなぐ、probe の宣言を読む、設定の編集と保存、GPIO と UART、port_speed、DFU での更新
- port_speed（oep-if-link §3 は握手だけで、任意のインターフェース `oep.probe.link` の op。probe は ops が立てるときに持つ。手順は
  oep-spec の host 開発ガイド §17。使うときだけ）:
  `raiseSpeed(host, candidates = [500000], { flows, verify, baseline, frames, verifyMs, idleMs, port, record })`（または
  `connect` / `openWebSerial` / `openSerial` の `portSpeed: true | [候補]` と `flows` / `verify` / `record`）で、セッションの間
  UART bridge を速くする。**最小の形**（既定、約 50 ms、計測なし）: 候補ごとに順に `試す`（今の速さで応答してから probe が
  切り替える）→ host は要求した baud に切り替える（platform が断ったときだけ probe の応答の baud）→ 20 ms → `confirm`（100 ms、
  3 回まで）→ `決める`。**完全な形**（`verify: true` か `flows` を渡す）: 起動時の速さの基準を流し方ごとに取り（このセッションの
  フレーム、無ければ 60 フレーム）、候補ごとに使う流し方だけ流す。流し方 = `'in' | 'out' | 'duplex'` か `[流し方, n]`（in =
  oep.probe.link の source probe → host、out = oep.probe.link の sink host → probe、duplex = 両方を交互。`n` は同時数、0 = link が出す最大）で、
  max_frame − 26（oep-if-link §2）のフレームを 16 個流し、壊れと失われを数え KB/s を測る。壊れ + 失われが 3 以上で割合が max(基準 × 2, 5 %) を
  超えたら流し方は通らず、n = 1 で流し直し（通れば n = 1 が link の上限 `inflightCap`）、1 つでも通らなければ候補は通らない。
  通らない候補は戻して（step 2）起動時の速さに戻り confirm し直す。最初に通った候補を使う。probe の UART が作れない速さは飛ばす。
  結果（`host.link.speed`: `base`、`rate`、`chosen`、`baseline`、`flows` と `inKBs` / `outKBs` / `duplexKBs` を持つ `trials`、
  `stepDowns`、`skipped`。`speedText(report)`）はキャプチャや書き込みの予算を立てるのに使う。WebSerial は同じ口を閉じて開き直して
  速さを変え（すぐに DTR / RTS を一緒に立て直す）、Node の `serialport` は `update` で変える。`end`、戻す、restart の応答で link は
  すぐ起動時の速さに戻る。上げている間は `idleMs` の半分より短く（1 秒）黙れば keepalive を送り、長く黙る呼び出し側は
  `host.link.keepAlive()` で同じことをする。上げた速さで応答の来ない要求は起動時の速さに戻って port_speed_idle_max_ms + 1 秒の内に
  confirm し（通らなければ Error。上げた速さへは戻さない）、そこでもう一度送る（待つ 1 回は lease の 4 分の 1 まで）。使っている間、
  決めた速さの最初の 32 KiB と 1 秒（`probationBytes`、`probationMs`）は試用期間で、壊れ・失われが 3 以上かつ max(基準 × 2, 5 %) 超、
  または応答が来なければ、確かめの失敗としてすぐ降りる（16 フレームの確かめは素早い関門として残す）。その後は直近 3 秒のフレーム
  （50 未満なら判定しない）を見て、max(基準 × 2, 10 %) を超えて壊れ・失われたら降りる。降りるのは port_speed の戻す、起動時の速さ、
  confirm の後、その呼び出しの候補のうちこのセッションで通らなかったものより下の次の候補を新しく試す → confirm → 確かめ → 決める
  （残っていなければ起動時の速さ）。壊れた速さとそれより上はそのセッションの間は使わない（`speed.steppedDown`、`downWhy`、`to` と
  `probation` を持つ `stepDowns`）。`maxTries` は 1 回の呼び出しで試す候補の数の上限（キャプチャの host は 2）。`record: true`
  （既定は OFF。パスか `speedrecord.SpeedRecord` でもよい）は通った / 通らなかった速さを残す（通ったは 30 日、通らなかったは 1 日、
  別の速さの破綻から 2 秒（`settleMs`）以内に測った失敗は「不明」）― Node では（口のパス、unit_id）ごとに
  `~/.cache/oep-client/link-speed.json`（`$XDG_CACHE_HOME`。oep-client-python と同じファイル）、ブラウザでは localStorage に unit_id
  ごと ― 通った速さを先頭に、通らなかった速さを外す（`report.skipped`。全部の候補が通らなかったとあれば、いちばん遅い候補を 1 回
  試す: `report.retried`）。`x-` の unit_id（core §7.5）では何も残さない。上げるのはこの host が来た経路（confirm の
  transport TLV）で、それが UART bridge のとき。oep-client-python と同じ手順
- コンソール（oep-if-console）: write はストリームの送りの列（describe 0x41、`Console.sendQueue()`、64 byte 以上）に入り、
  入った分を答える。`ConsoleIO` は送りの列ずつ書き、`accepted` の続きから送る。ストリームは接続と mechanism ごとに probe の
  もの: 閉じたものは次の open まで読め、次の open は同じ番号を返す
- 落ち着くまで待つ reset（oep-if-debug §3、§4.3）: `Wire.attachMs(reset)` は reset TLV つきの attach で attach_budget_ms に
  hold_ms + reset_settle_ms（700）を足し、`RiscvDm.resetMs()` は reset_settle_ms ― host の待ちの引数の時間
- block の操作: riscv-dm / arm-adi の `readBlock` / `writeBlock` は probe が宣言した `max_length` で区切る（`RiscvDm` / `ArmAdi` の
  `.maxLength` byte、`.maxWords`。oep-if-debug §4.5 / §6）。`MemAp` もそれで分け、block op を持つのに宣言しない probe は
  `riscv.NoMaxLength`。max_frame からは何も計算しない
- gpio の出力の強さ（oep-if-fixture §1.1）: `Gpio.set([[ch, mode, Drive.maxMa(10)]])`（出力の要素ごとの drive。段は
  `Drive.level(n)` か数）は応答の ignored を返す。`driveLevels()` は `DriveLevels`（`defaultLevel`、`ma`、`pick(drive)`）、
  `readState(channels)` は `{ levels, drive }`（いま効いている段）。設定の `Idle({ ..., drive })`、`Slot({ ..., bootReset: true })`
  （at-boot のリセットでのやり直し）、`SlotState.resetAtNs`。`config.findLine(config, slotName, 'nrst')` は probe.config §1.3 の
  線の探し方で、手順 (c) に firmware の固定のラベルを使う（`lineFromLabels` は同じことを素のデータで）
- 2026-10-02 の規則の変更（oep-spec `docs/v1-rule-change-proposal-2026-10-02.ja.md`）の host の側: attach と scan は予算の分
  待つ（`attachMs`、`scanMs`）。`Unsupported.supported`（confirm の扱える範囲）。`x-` の unit_id では USB の機器を探さない。
  応答の文字列は制御文字を除いて見せ（`message.shown`）、open の owner は文字の境で切り（`ownerText`）、probe が断るラベルは
  送らない。`Tail.moreIgnored`（0x00 で終わる ignored）。`dump` は core §1.2 が求めるもので probe が出さなかったものを示す
  （`missing`）。キャプチャの mode / rate / trigger / pretrigger / frontend はいつも critical、start の blocking_ms の間は何も送らず
  待つ（その後 length のフレームなら立て直し）。`Wire.searchRetries`、`riscv.StepError`（`stepLeft`）、`I2cTarget.pullupOhms()`、
  describe のキャプチャの mode と background

wire は oep-spec の 2026-10-01 のゼロベース見直しを 2026-10-06 に単純化した形です（session_id を持つ要求の見出し 1 つ、
TLV の形 1 つ、要素に長さを置かない並び、閉じた固定の形、`ops` tag、再開なし。変更履歴を参照）に、2026-10-06 の構造（名前の
無い本体、oep.probe のインターフェース、インターフェースごとの通知）を加えたもの。
oep-client-python の fake の probe と台本のデバイスで試しています（297 件。oep-spec の試験ベクタを含み、sessions.json、
ops.json、ops_encoding.json も）。ブラウザの経路、DFU、ページは、まだ実機で確かめていません。

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
npm test            # python -m pip install oep-client-python（fake の probe）が要る。test/vectors は oep-spec のもの
npm run typecheck
npm run serve       # http://localhost:4173/ でページ
```

## 文書

- 仕様: [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)（英語の本文が正で、`.ja.md` はその訳。食い違えば英語が
  正しい）。まず [README](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/README.ja.md) と [レビューの手引き](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/review-guide.ja.md) から。
  [使い始める](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/getting-started.ja.md) が最小の probe と host を作り、
  [docs/oep-core.ja.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/oep-core.ja.md) がプロトコルの本体、
  [docs/conformance.ja.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/conformance.ja.md) が host の適合に要ること
- [設計](docs/design.ja.md): 層、経路、ページでできること、試験、registry、版
- [リリースの手順](docs/release.ja.md)
- [変更履歴](CHANGELOG.md)

## ライセンス

MIT
