# JavaScript client の独立したテスト環境

Node 22以降、npm、uv を使います。仮想 OEP は `test/virtual-bench/pyproject.toml` の commit と `uv.lock` で固定し、この repository 専用の `.venv` へ取得します。兄弟 checkout や設備台帳は参照しません。

```sh
npm ci
uv sync --project test/virtual-bench --locked
OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
```

`OEP_PYTHON` は明示した Python executable です。別の候補 client の仮想環境を比較する場合も、利用する executable を明示します。明示 executable で仮想 module が使えない場合、または `OEP_REQUIRE_VIRTUAL_BENCH=1` で依存がない場合は準備エラーです。両方を指定しない通常の `npm test` は `python3` だけを使い、仮想依存がなければ任意の仮想結合試験を skip します。その結果はリリース確認完了ではありません。

CI、Pages、Release は共通 action でこの環境を用意し、仮想依存を必須にします。依存更新時は commit と lock を一緒に更新し、仮想結合・型検査・配布物検査を行います。固定した backend は今回検証した版であり、通常利用する実機 probe の最低 firmware 版を定めるものではありません。

保証の責任と利用プロジェクトの手順は [OEP共通方針](https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/testing-policy.ja.md)と[汎用ガイド](https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/testing-consumers.ja.md)に従います。仮想結合試験の成功で実USBや実機転送の品質を保証しません。

## ブラウザの作業画面

`npm run test:browser` で専用のheadless Chromium、HTTPサーバー、Python仮想プローブを起動します。
Chromiumのコマンドは `OEP_CHROME`（既定 `google-chrome`）、Pythonは `OEP_PYTHON`（既定は上記の専用環境）で指定できます。
試験専用のHTTP byte経路でブラウザの実際のhostライブラリと仮想プローブを接続します。この経路を公開ページには含めません。

公開ページと旧URL、ESP32の作成（疑似ROMでoffset 0の書き込み、同じシリアルポートの再利用、書き直さない再試行）、PicoのBOOTSEL作成
（新しく現れた機器を選び直さずに開く）、PicoとP4（DFU）の更新、用途を保つ接続、相手の無いままの配線の登録（SCAN・ATTACH・PLAN_APPLYを
呼ばない、型番・メモはメモ領域へ）、編集、接続確認、デバッグの操作とデバッグ線のログ、UART・GPIO・I2C・SPI・PWM・カウンタ・DAC・
I2C/SPIの相手役、デバッグとUARTの併用、素通し・待機ピン・Wi-Fiの設定、設定とメモの控えと差分を見ての復元、キャプチャの準備、引継ぎ、
390px幅、ブラウザの言語とヘッダの選択による日英の切り替え（入力・画面・接続を保ち、再読み込み後も残る）、英語の全画面に日本語が残らないことを確かめます。DACとWi-Fiは2台目の仮想プローブ（classic ESP32の profile）で確かめます。CIは `npm run check` の後にこの試験を回します。
書き込み・DFU・boot ROM・USB権限のダイアログ・電気的な信号は試験では偽物か対象外で、実機で確かめます。
