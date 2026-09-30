# リリースの手順

[English](release.md) | 日本語

保守する人向けの文書です。兄弟のツール（wireskein-web など）と同じく、npm への公開は、ふつうは保守する人の手元のマシンから行います。

## リリースの前に見ること

1. `main` が最新で、意図しない変更がないことを確かめます。
2. [README](../README.ja.md)、[設計](design.ja.md)、変更履歴を読み直します。
3. oep-client-python の fake（`python -m oep_client.fake_serve`）に対して `npm test` が通ることを確かめます（CI と同じ）。
4. `npm run serve` でページを開き、Chromium 系のブラウザ（Chrome か Edge）で実機の probe につなぎます。できる範囲で確かめます:
   - 経路ごとに 1 つ（WebSerial、WebUSB、WebHID）でつながり、describe が出ること
   - 設定の表示、変更、保存、消去（書き換えた後に元に戻す）
   - firmware の更新（P4 の DFU、ESP32 の esptool-js）。同じ版を書き直すのが安全です
5. `main` を push したあと、<https://open-embedded-probe.github.io/oep-client-js/> を直接開き、4 を繰り返します（HTTPS で
   WebUSB などが使えること、古いキャッシュが残っていないこと）。

自動の確認:

```sh
npm run check
npm run build
npm run types
npm run smoke:dist
npm run build:site
npm pack --dry-run
git diff --check
git status --short
```

配布物の確認（dry run）には、`dist`、`src`、`types`、README、変更履歴、ライセンスが入り、`web`、`site`、試験は入らないはずです。
Web ページは npm の tarball ではなく、GitHub Pages から配ります。

## 変更履歴と版

`CHANGELOG.md` の `## Unreleased` の変更には、`(EN)` と `(JA)` を対で書きます。空でなく、リリースの変更をすべて書いてあることを
確かめます。v1 の凍結までは、話せる probe の firmware（OpenEmbeddedProbe）と、試験に使った oep-client-python の版も書きます。

`npm version` は、次のものを実行します。

- `preversion`: 試験、型のチェック、リリースできるかの確認
- `version`: package の版、ソースの `VERSION`（`src/index.js`）、変更履歴の見出しをそろえる
- 版のコミットと Git のタグを作る

```sh
npm version patch              # 必要なら minor か major
```

最初のリリースは、`package.json` がすでに `0.0.1` なので、次のようにします。

```sh
npm version 0.0.1 --allow-same-version
```

## 公開と push

npm にログインし、アカウントを確かめます（マシンごとに 1 回。ログインは `~/.npmrc` に残ります）。

```sh
npm login                      # ブラウザが開く（または、ユーザー名、パスワード、ワンタイムコードを聞かれる）
npm whoami                     # 公開に使うアカウント
npm owner ls oep-client   # 最初のリリースの後: 公開できるアカウントの一覧
```

そのあと、公開して push します。

```sh
npm publish --access public    # 二要素認証が有効なら、ワンタイムコードを聞かれる
git push --follow-tags
```

`prepack` が、バンドルと型定義を作り直します。npm のトークンや認証情報を、リポジトリに置いてはいけません。

## GitHub Actions

- `ci.yml`: `main` への push と pull request で、Python の fake を入れて、確認、ビルド、型定義、配布物の smoke test、サイトの
  ビルド、配布物の中身を確かめます。
- `pages.yml`: `main` への push か手動の実行で、Web ページを GitHub Pages に出します。
- `release.yml`: npm の Trusted Publishing を設定したあとの、任意の手動の公開です。

## リリースの後に見ること

- npm の package のページに、意図した版が出ていること。
- 空のディレクトリで `npm install oep-client@<版>` をし、
  `node -e "import('oep-client').then(m => console.log(m.VERSION))"` がその版を出すこと。
- Git のタグが、意図したコミットを指していること。
- [Web ページ](https://open-embedded-probe.github.io/oep-client-js/) に、新しい版が出ていること。

壊れた版を上書きしてはいけません。直して、新しい patch の版を出します。
