# oep-client-js

[English](README.md)

npm: `oep-client-js`（リポジトリと同じ。PyPI の oep-client-python と対）。

[Open Embedded Probe（OEP）](https://github.com/Open-Embedded-Probe/oep-spec) の、JavaScript の host の実装です。ブラウザと Node から
OEP の probe と話し、設定し、firmware を更新します。これを使った Web ページ **OEP Probe Tool** を GitHub Pages に置きます:
<https://open-embedded-probe.github.io/oep-client-js/>。

## 状態

**v1 の凍結の前に、ひととおり移した版です。仕様が固まるにつれて作り直す前提です。**

**実装する仕様: oep-spec の commit `c6ab5d9`**（66c49e7〜dd5a886: 2026-10-07 のロジックキャプチャの変更 ― layout の w は 1〜128 の任意の整数、連続に保てない区画は出さずにトラックをエラーで止める、multirate（`multirate.Multirate`、`LogicCapture.decodeMultirate`）。0098b56〜2c6d18d: 0991759 のインターフェースの再確認 ― marks とキャプチャの segments の通し番号のページング、console の streams の first(u16)、キャプチャの configure の契約、一周してどの出来事にも付く世代、capture-group の start の応答の固定部、step / run / transfer の細部、spi-target のビットの詰め方を含む）（`v0.x` のタグはまだ無い。oep-spec versioning §6 ― 凍結の前は revision 1
だけでは形が決まらないので、実装は実装する仕様を名乗る）。2026-10-06 の単純化（10 byte の要求の見出し 1 つ、TLV の len は u16、
閉じた固定の形、describe の `ops` tag、再開なし）、コンソールの送りの列と reset の後の待ち（f0c68bf）、長い probe.config の項目
（d34dafa）、既存の connection に加わる attach（59dd028）と、2026-10-06 の構造（2e5dc4c〜9c837a9、0304f37）: 本体は名前を
持たない（fn 0、list に載らない）、plan と再起動と線の試験はインターフェース `oep.probe.plan`、`oep.probe.restart`、
`oep.probe.link`、subscribe / unsubscribe は通知を送るインターフェース自身の op 0x30 / 0x32（heartbeat は無い）、fn 0 の `clock` が
probe の時刻を返す（要求を処理する間に読む。e0d9dc6、498ae95）― に、2026-10-07 の規則の見直し（7688c49〜0f455a0、
`docs/v1-rule-review-2026-10-07.ja.md` §2 / §7）と外部レビューの再確認とその後の直し（283e5b5〜f8bb2de）を加えたもの: ignored の
TLV は無い（知らない非 critical の TLV は跡を残さず無視し、実装する TLV は bit 7 によらず同じに確かめる）、送り直しの表は
(corr、応答)、list は `first` だけ、probe の内部の時間は文から消えた（attach、scan、riscv-dm の reset は max_op_ms のうちに答える）、
port_speed は握手だけ（baud、step、verify_ms）、probe.config は slot の錠も boot_reset も無く bind はストリーム 1 本、gpio の drive は
u8 の段、インターフェースの名前は 1〜48 byte、走り直す host は前の実行が残したセッションを終える（host ガイド §5）― に、その後
（c2b8007〜30b2b36）の probe.config の wifi の項目（passphrase は書くだけ）、unset の len は key だけを数えること、TCP の probe の
見つけ方（mDNS の DNS-SD `_oep._tcp`、transports §3）、（29902a6〜9118dc0）wifi の項目を持つ probe はどの経路でも max_frame 112
以上を答えること（`wifi_min_max_frame`）、TCP の probe が自分を知らせるかは probe が選ぶことを加えたもの。
凍結までは日本語の文（`.ja.md`）が仕様の作業の文。

入っているもの:

- 核: registry（oep-spec から生成）、フレーム（COBS + CRC、length）、メッセージ、リンク（corr の照合、待ちの後に 1 回の送り直し、持っているシリアルの口で
  壊れたフレームが来たらすぐ 3 回までの送り直し（host ガイド §8）、パイプライン、push と出来事。応答はどれも core §4.4 の下限 ― 引数の時間 + 1000 ms + シリアルの口の転送時間、
  `Link.waitFloorMs` ― 以上待つ。length のフレームでの transports §5 の立て直しは、host の最後の書き込みから 250 ms 待ってから confirm し、
  TCP のフレームの途中の休みでは立て直さない。送り直しにも応答が無ければ経路の失敗 `TransportFailed` で、次の要求の前に
  confirm で立て直す（COBS でも）。header より短いフレームは壊れたフレーム）、
  host（confirm ― この host が来た経路の番号 `limits.transport`、2 回目からは使っている revision を求める。core §7.1 の範囲の外の
  confirm、1..600000 の外の max_op_ms、core §7.4 の形に合わない fn 0 の ops は、その probe を `NotUsable` にし、合わない fn の ops は
  その fn を `FnNotUsable` にする ―、`clock()` ― fn 0 の clock をこの host の `performance.now()` と突き合わせる:
  `{ hostBeforeMs, hostAfterMs, roundTripMs, uptimeNs, bootId }`。probe の時刻は往復の半分の不確かさで中点に当たる ―、セッション ― open はいつも新しい乱数の id を
  要求の見出しに置いて新しいセッションを開く。end、lease の期限切れ、force はセッションが作ったものをすべて解放し、終わった
  セッションの要求は `NoSession`（再開なし）。経路が閉じてもセッションは終わらないので、`connect`（`keepSession`、既定で ON）は
  開いたセッションの id を probe ごとに残し ― Node は `$OEP_SESSION_DIR`、`$XDG_RUNTIME_DIR/oep-client`、または利用者の cache の
  場所の `<unit_id>.session`（oep-client-python と同じファイル）、ブラウザは localStorage と Web Lock ―、次の実行の最初の open は
  その id で open してすぐ end する（`Host.endPrevious`、`keptsession.KeptSession`、host ガイド §5）―、ロック、購読 ― `subscribe(fn, minBytes, maxDelayMs)` / `unsubscribe(fn)`: fn 自身の
  op 0x30 / 0x32（core §11.3）―、再起動 ― `requestRestart()` と `restartProbe({ reopen, waitMs })`: oep.probe.restart（名前で探す）の
  restart の後、少し（約 100 ms、host ガイド §5.2）待ち、`reopen` があればそれで開き直し（無ければ link のまま）、confirm する。
  probe の restart_max_ms（`core.restartMaxMs`。そのインターフェースの describe。restart の前に読む。それより長い `waitMs` は
  そこで切る。宣言が無ければ 10 s）まで繰り返し、
  過ぎれば probe は無くなったものとして最後のエラーを投げる。新しい boot_id を返す。同じなら `NotRestarted` ―）、list / describe
  （list は `first` だけで頁を送り、接頭辞の絞り込みはラベルの境で host が行う。fn ごとの `ops`: `core.ops` / `offers`、`Interface.ops()` / `.offers(op)`。`core.require` は送らずに、probe が答えるのと同じ
  detail unknown_operation の `Rejected` を投げる）/ plan（`core.planApply` / `planRelease` / `planRoles` は oep.probe.plan を名前で探す）
- インターフェース: debug の線（rvswd、swio、swd）と riscv-dm、ARM の ADI / MEM-AP / Cortex-M、target のコンソール、
  fixture（gpio、uart、i2c-target、spi-target）、キャプチャ（ロジック、アナログ、capture-group、sigrok の .sr）、probe.config、
  `oep dump` の表示
- 経路: ブラウザは WebSerial、WebUSB（vendor bulk）、WebHID。Node は TCP、シリアルの口（`serialport`）、USB（`usb`）
  （ネイティブの package は任意）。シリアルの口は 8N1、フロー制御なし、DTR と RTS を立てて開く（transports §4）。USB の probe は
  プロジェクトの USB の VID:PID `1209:4F45` だけで見つける（transports §3: WebUSB / WebHID の選択の既定の filter、Node の
  `findUsbProbes` / `findSerialProbes` / `findProbes`、`openUsb()` ― この VID:PID のプローブがちょうど 1 つならそれを vendor bulk で、
  無ければその CDC の口で開く。2 つ以上なら `SeveralProbesError` が並べるので 1 つを指定する）。WebSerial の選択には既定の
  filter を付けないので、UART bridge や内蔵の USB serial も選べる。TCP の probe（Node だけ。ブラウザは TCP を開けず mDNS も
  送れないので、ページに TCP は無い）は `openTcp({ host, port })` で開く。決まった port は無い（transports §3）:
  `openTcp({ host })` はその DNS-SD `_oep._tcp` の record が広告する port を使い、`openTcp({ unitId })` は TXT の `unit_id` が
  それの probe を開く（ほかの名指した probe と同じく、開いた後に describe の unit_id を確かめる）。`browse()` / `findUnit()` /
  `portOf()`（`oep-client-js/node`、src/node/discovery.js）はその裏の、依存の無い mDNS の問い合わせ（IPv4 の口すべてから送り（`interfaceAddresses()`）、答えをまとめる。IPv4、届くのは同じリンク
  だけ: NAT の後ろや別のサブネットでは見つからないので host と port を渡す。アドレスはほかの経路での wifi の state の `ipv4` でも分かる）。
  service の名前 `oep` は登録した名前ではないので、別のサービスが `_oep._tcp` を広告しうる（host ガイド §4.1）: `verifyFound(found)`
  はどの instance もすべて同時に確かめる ― TCP でつなぎ、confirm（`OEP!` の答え）と fn 0 の describe を送り、describe の unit_id が
  TXT の unit_id と同じかを見る（答え 1 つあたり 1 秒、session は開かない）。`browse({ verify: true, onDropped })` はそれで残った
  ものだけを返す。`findUnit()`（つまり `openTcp({ unitId })`）は既定で確かめ、確かめられない instance は飛ばす（`verify: false` なら
  広告された最初のもの）
- firmware の更新: USB の DFU（ESP32-P4）と、Release の firmware-<version>.json
- ページ: つなぐ、probe の宣言を読む、設定の編集と保存、GPIO と UART、port_speed、DFU での更新
- port_speed（oep-if-link §3 は握手だけで、任意のインターフェース `oep.probe.link` の op。probe は ops が立てるときに持つ。手順は
  oep-spec の host 開発ガイド §17。使うときだけ）:
  `raiseSpeed(host, candidates = [500000], { flows, verify, baseline, frames, verifyMs, record })`（または
  `connect` / `openWebSerial` / `openSerial` の `portSpeed: true | [候補]` と `flows` / `verify` / `record`）で、セッションの間
  UART bridge を速くする。要求は baud、step、verify_ms で、要求が来た口に効く（`speed.speedRequest`）。**既定の上限は 500000**
  （host ガイド §17）: 既定の候補は 500000 だけで、`speed.DEFAULT_CEILING`
  より速い速さは利用者が名指したとき（ページの rates の欄、設定）だけ候補に入れる。その速さは、最小の形でも完全な形でも、
  **1 秒の確かめ**（host 開発ガイド §17.3.3）を通ってから決める: 試しの状態で、満杯のフレーム（source は max_frame − 7、sink は max_frame − 12）を oep.probe.link の
  source（in）と sink（out）で、完全な形が duplex を確かめるなら duplex でも、それぞれ 1 秒以上（`speed.FAST_VERIFY_MS`）その
  同時数で流し、流し方と同じ基準で判定する（n = 1 での流し直しはしない）。その試すは verify_ms 4000（duplex を含めて 6000）を
  頼むので、lease は 5000（7000）ms 以上が要る（`speed.leaseFor(candidates, { flows, verify })`。`connect` は少なくともそれで取り、
  短い lease ではその候補を飛ばす）。決めた後は、ほかの速さと同じ試用期間と使用中の判定（理由: ある変換では 921600 が両方向
  16 フレームずつの確かめを通っても 9 KiB の書き込みのたびに応答が壊れた。500000 は測ったどの変換でも壊れなかった）。**最小の形**（既定、約 50 ms、計測なし）: 候補ごとに順に `試す`（今の速さで応答してから probe が
  切り替える）→ host は要求した baud に切り替える（platform が断ったときだけ probe の応答の baud）→ 20 ms → `confirm`（100 ms、
  3 回まで）→ `決める`。**完全な形**（`verify: true` か `flows` を渡す）: 起動時の速さの基準を流し方ごとに取り（このセッションの
  フレーム、無ければ 60 フレーム）、候補ごとに使う流し方だけ流す。流し方 = `'in' | 'out' | 'duplex'` か `[流し方, n]`（in =
  oep.probe.link の source probe → host、out = oep.probe.link の sink host → probe、duplex = 両方を交互。`n` は同時数、0 = link が出す最大）で、
  満杯のフレーム（oep-if-link §2）を 16 個流し、壊れと失われを数え KB/s を測る。壊れ + 失われが 3 以上で割合が max(基準 × 2, 5 %) を
  超えたら流し方は通らず、n = 1 で流し直し（通れば n = 1 が link の上限 `inflightCap`）、1 つでも通らなければ候補は通らない。
  通らない候補は戻して（step 2）起動時の速さに戻り confirm し直す。最初に通った候補を使う。probe の UART が作れない速さは飛ばす。
  結果（`host.link.speed`: `base`、`rate`、`chosen`、`baseline`、`flows` と `inKBs` / `outKBs` / `duplexKBs` を持つ `trials`、
  `stepDowns`、`skipped`。`speedText(report)`）はキャプチャや書き込みの予算を立てるのに使う。WebSerial は同じ口を閉じて開き直して
  速さを変え（すぐに DTR / RTS を一緒に立て直す）、Node の `serialport` は `update` で変える。`end`、戻す、restart の応答で link は
  すぐ起動時の速さに戻る。上げている間は 1 秒（port_speed_idle_ms 3 秒の半分より短い）黙れば keepalive を送り、長く黙る
  呼び出し側は `host.link.keepAlive()` で同じことをする。上げた速さで応答の来ない要求は、まずその速さのまま送り直す ― 最初の待ちは
  `RAISED_FIRST_WAIT_MS`（port_speed_idle_ms の 3 分の 1）と lease の 4 分の 1 まで、core §4.4 の下限は下回らない（host ガイド
  §17.3.2 の 4）― それにも応答が無いときだけ起動時の速さに戻って port_speed_idle_ms + host_wait_add_ms の内に confirm し（通らなければ
  Error。上げた速さへは戻さない）、そこでもう一度送る。使っている間、
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
- コンソール（oep-if-console）: write はストリームの送りの列（大きさは probe が決め、宣言しない）に入り、入った分を答える。
  `ConsoleIO` は多くても 1 フレームずつ書き、`accepted` の続きから送る。ストリームは接続と mechanism ごとに probe の
  もの: 閉じたものは次の open まで読め、次の open は同じ番号を返す
- debug の待ち（oep-if-debug §1、§4.3）: attach、scan、riscv-dm の reset は max_op_ms のうちに答え、それが host の待ちの引数の時間
  （`Wire.attachMs()`、`scanMs()`、`RiscvDm.resetMs()`。宣言の無い probe には `core.FALLBACK_MAX_OP_MS`）。riscv-dm の reset の応答は
  status flags pc（`reset({ confirm })` は `{ flags, pc }`、method は無い）。準備が失敗した run は stopped 3（`RunResult.notRun`）。
  `readRegister` は DATA0 を取っておき（`dataSaved`）、`resume` / `step` / `run` は先に書き戻す（`restoreData`、debug §4）。target_id の
  scheme は `dmi_7f`（`Wire.SCHEME_DMI_7F`）
- block の操作: riscv-dm / arm-adi の `readBlock` / `writeBlock` は probe が宣言した `max_length` で区切る（`RiscvDm` / `ArmAdi` の
  `.maxLength` byte、`.maxWords`。oep-if-debug §4.5 / §6）。`MemAp` もそれで分け、block op を持つのに宣言しない probe は
  `riscv.NoMaxLength`。max_frame からは何も計算しない
- gpio の出力の強さ（oep-if-fixture §1.1）: `Gpio.set([[ch, mode, Drive.level(1)]])`（出力の要素ごとの drive。u8 の段、0xFF は
  `Drive.default()`。critical で送る。drive_levels を越える段や drive_levels の無い probe への drive は `Unsupported`）。
  `driveLevels()` は `DriveLevels`（`defaultLevel`、`ma`、`pick(drive)`、`atMost(ma)`: probe をまたいで強さを運ぶ）。read は段だけを
  返す。設定の `Idle({ ..., drive })`（4 byte）。`config.findLine(config, slotName, 'nrst')` は probe.config §1.3 の
  線の探し方で、手順 (c) に firmware の固定のラベルを使う（`lineFromLabels` は同じことを素のデータで）
- fixture: i2c-target は 1 つの形（`configure(address)`、データのある書き込み 1 回が 1 フレーム、読み出しは `preloadTx` の置き場か
  0xFF、`status()` は `{ state, queued, rxFrames, txSlots, errors }`、`internalPullups()`。stretch は任意の op）。spi-target に reset は
  無い。uart の `status()` は `{ baud, format }`
- probe.config: slot に錠も boot_reset も無い（target の確かめは host が connections の tid で）。`SlotState` は `{ slot, state:
  connected | absent, connection, lastTryAtNs }`。bind はストリーム 1 本（`Bind({ port, stream: ['slot', n] | ['uart', fn] })`、
  `BindState` は `{ port, flow }`）。idle の項目は 4 byte。hash は probe が作る ― host は項目を比べる（`config.sameItems`）。
  `ProbeConfig.needsSave()` と `apply(wanted, { save })`（host ガイド §15）。unset の要素の len は key の byte 数だけを数える
  （`config.remove(kind, key)`）
- Wi-Fi（probe.config §1.4、§3.3、host ガイド §15.1）: `config.Wifi({ index, ssid, passphrase })` ― passphrase は null（開いた
  ネットワーク）、`config.KEEP`（その entry のものを保つ。get の形、pass_len 0xFF）、8〜63 文字の印字できる ASCII か 16 進 64 桁。
  passphrase は書くだけ: get は返さず（`KEEP` と読む）、private field に持つ（`console.log`、`util.inspect`、`JSON.stringify` に
  出ない。`toString()` / `shown()` は set / none と言う）。断ったときの error にも載せない。`sameItems` と `apply` は wifi の項目を
  passphrase 抜きで比べ、変わる entry にだけ送る。`describe()` は `wifiMax`、`state()` は `wifi`（`WifiState`: state、entry、
  reason、rssi、ipv4。`text()`）。ページの Wi-Fi の欄は passphrase を password の欄で受け、読んだら消し、probe から埋め戻さない
  （空: 保つ。「開いたネットワーク」: なし）
- キャプチャ: configure の TLV は core §2.3 だけに従う（扱わない値は受け取ったままの tag で `Unsupported`）。応答に timing と
  rate_accuracy は無い。describe の mode は mode max_samples max_segments
- 2026-10-02 の規則の変更（oep-spec `docs/v1-rule-change-proposal-2026-10-02.ja.md`）の host の側: attach と scan は予算の分
  待つ（`attachMs`、`scanMs`）。`Unsupported.supported`（confirm の扱える範囲）。`x-` の unit_id では USB の機器を探さない。
  応答の文字列は制御文字を除いて見せ（`message.shown`）、open の owner は文字の境で切り（`ownerText`）、probe が断るラベルは
  送らない。`dump` は core §1.2 が求めるもので probe が出さなかったものを示す
  （`missing`）。キャプチャの mode / rate / trigger / pretrigger / frontend は critical で送る（この host の選択）、start の blocking_ms の間は何も送らず
  待つ（その後 length のフレームなら立て直し）。`Wire.searchRetries`、`riscv.StepError`（`stepLeft`）

wire は oep-spec の 2026-10-01 のゼロベース見直しを 2026-10-06 に単純化した形です（session_id を持つ要求の見出し 1 つ、
TLV の形 1 つ、要素に長さを置かない並び、閉じた固定の形、`ops` tag、再開なし。変更履歴を参照）に、2026-10-06 の構造（名前の
無い本体、oep.probe のインターフェース、インターフェースごとの通知）を加えたもの。
oep-client-python の仮想ベンチ（probe とその先の target、治具の配線を実際の治具に合わせて作ったもの:
`python -m oep_client.virtual_bench_serve`）と台本のデバイスで試しています（331 件。oep-spec の試験ベクタを含み、sessions.json、
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
| `test/` | - | `node:test`。oep-client-python の仮想ベンチに TCP でつなぐ |

JSDoc の型付きの JavaScript（`// @ts-check`、`tsc` で確かめる）、ES モジュール、実行時の依存なし。WebUSB、WebSerial、WebHID は
Chromium 系のブラウザ（Chrome、Edge）と HTTPS が要ります。

## 開発

```sh
npm install
npm test            # python -m pip install oep-client-python（仮想ベンチ）が要る。test/vectors は oep-spec のもの
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
