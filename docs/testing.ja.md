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

直接URL、接続後の元画面への復帰、機能別フォーム、GPIO/PWM/UART/I2C/SPI/カウンタ/DAC、ターゲット操作、設定、言語、狭い画面、
セッション解放を確認します。ESP初回書き込みは疑似ROMでoffset 0・進行・reset・ポート解放・完了後の接続を確認し、実際のbundleもブラウザでimportします。
固定配線の登録ではSCAN非対応としても保存できること、読取専用でも編集・確認できること、登録・呼出中にSCAN/ATTACH/PLAN_APPLYを呼ばないことを検査します。
書き込み後の設定画面への自動遷移、同じシリアルポートの再利用、再接続失敗・USB許可待ちでも同じ画面で続行できることを検査します。
接続先の名前変更・ピン移動・編集時の衝突拒否、ブラウザ/プローブの型番・メモの更新、未知フィールドの保持と記録の移動も確認します。
単体試験ではチップ/ファームウェアイメージの不一致、P4のrevision不一致、接続/書き込み失敗時の解放を確認します。USB権限ダイアログ、電気的な信号、firmware書き込みは実機で確認します。
