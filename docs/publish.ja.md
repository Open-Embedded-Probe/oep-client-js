# ページの公開

[English](publish.md) | 日本語

保守する人向けの文書です。このリポジトリのものは npm に出しません（`package.json` は `private`）。利用者に届くのは、GitHub Pages の
OEP Probe Tool だけです。`main` に push すると `pages.yml` がサイトを作り直して公開し、毎日 1 回、最新の oep-probe-arduino の Release の
ファームを取り込むためにも作り直します。

## push の前に見ること

1. 意図しない変更がないこと（`git status --short`、`git diff --check`）。
2. 試験（[試験](testing.ja.md)の固定した仮想ベンチで）:

   ```sh
   OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
   npm run test:browser
   npm run build:site
   ```

3. 画面や経路を変えたときは、`npm run serve` で開き、Chromium 系のブラウザ（Chrome か Edge）で実機のプローブにつないで確かめます:
   - つなぎ方ごとに 1 つ（USBシリアル、USB（OEPの機器）、USB HID）でつながり、概要が出ること
   - 配線の登録と接続確認、本体設定の適用と保存（変えたら元に戻す）、設定のエクスポートとインポート
   - ファームの作成・更新（ESP32 のシリアル書き込み、P4/P4X の DFU、RP2040/RP2350 の PICOBOOT）。同じ版を書き直すのが安全です
   - HID は `node scripts/check-hid.mjs /dev/hidrawN` でも確かめられます（[試験](testing.ja.md)）
4. `CHANGELOG.md` の `## Unreleased` に、変更を `(EN)` と `(JA)` の対で書いたこと。

## 公開の後に見ること

- <https://open-embedded-probe.github.io/oep-client-js/> を直接開き、HTTPS で機器の API が使えること、古いキャッシュが残っていない
  ことを確かめます。3 の確認を、できる範囲で繰り返します。

## 区切り

区切りを残したいときは、`CHANGELOG.md` の `## Unreleased` の下の変更を版の見出し（例: `## 0.1.0 — 2026-11-20`）の下へ移し、
`src/index.js` の `VERSION` と `package.json` の `version` をそろえ、Git のタグを付けます。ページの下に `VERSION` が出ます。
npm の版ではありません。

## GitHub Actions

- `ci.yml`: `main` への push と pull request で、固定した仮想ベンチを入れて、試験と型のチェック、ブラウザの試験、サイトのビルドを
  行います。
- `pages.yml`: `main` への push、手動の実行、毎日の定時で、サイトを作り、最新の Release のファームを取り込み、GitHub Pages に出します。
