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
