<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>AI チームメイトと、ひとつのローカルプロジェクトで共同作業。</strong></p>
  <p>モデルを選び、会話、ツールの承認、成果を同じワークスペースにまとめます。</p>
  <p>
    <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
    日本語 · <a href="README.ko-KR.md">한국어</a> ·
    <a href="README.de-DE.md">Deutsch</a> · <a href="README.fr-FR.md">Français</a> ·
    <a href="README.es-ES.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <img alt="ソースコード版アルファ" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="ライセンス: MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
</div>

> [!NOTE]
> **ソースコードからの利用を基本とするアルファ版です。** まずは Web UI、ローカル daemon、CLI をソースから起動してください。
> Desktop の開発環境は別途利用できますが、安定版の署名済みインストーラーや、本番利用をサポートするリリースはまだ提供していません。

## ひとつの共同タスクから始める

複数のモデルを使うと、タスク、回答、ツールの実行要求、成果が別々のウィンドウに散らばりがちです。
Ling Stack はそれらをプロジェクトチャンネルにまとめます。チームメイトにモデルとツールを割り当て、
作業内容を確認し、結果を会話と一緒に残せます。

まずは 2 人のチームメイトで、小さな[プロジェクト文書レビュー](docs/community/first-project-review.md)を試してください。
[公開サンプル](examples/project-review/README.md)も用意しています。最初は議論だけで始め、必要になった時点でツールと権限を追加します。
モデルサービスの設定と、ご自身の API キーが必要です。サービスの利用料金は利用者の負担となります。

![Ling Stack の英語 UI: 新規ワークスペース](docs/assets/ling-workspace-home.jpg)

モデル設定前のローカルワークスペースを実際に撮影した英語 UI の画像です。レイアウトを示すもので、タスクの完了を示す画像ではありません。
上記のガイドで、最初の共同作業を試せます。

## どのような人向けか

複数の AI モデルやチームメイトを使い、作業をひとつの場所で管理したい開発者や利用者向けです。
共通の Model Workbench を通じて、OpenAI、Anthropic、Volcengine Ark、DeepSeek 互換エンドポイント、
MiniMax、GLM、OpenAI 互換の中継サービスに接続できます。

ワークスペースの状態、会話履歴、実行の記録はローカルに保存されます。
ただし、リクエストとそのコンテキストは選択したモデルやツールのサービスに送信されます。**ローカル保存はオフライン推論を意味しません。**
UI には 55 の言語・地域オプションがあり、UI の言語と AI の回答言語は個別に設定できます。
README は上部のリンクにある 8 言語に対応しています。その他の文書には英語や中国語のものもあります。

## 3 つの使い方

| 用途 | 行うこと | 一緒に保存されるもの |
| --- | --- | --- |
| モデルに質問する | チャットモデルを設定し、文書、アイデア、プロジェクトについて会話する | メッセージ、モデル選択、添付ファイル、結果 |
| AI チームメイトと作業する | モデルとツールを割り当て、プロジェクトチャンネルで協働する | 参加者、ツールの実行記録、承認、成果物、最終報告 |
| メディアを制作する | 画像・動画生成機能を設定し、Media Production を使う | プロジェクト、シーン、生成ジョブ、出力 |

まずは簡単な会話から始め、タスクに応じてチームメイトやツールを追加してください。
スキルは指示を提供するもので、ツールやファイルの権限を自動的に付与するものではありません。
コーディングエージェントは Pi ランタイムアダプターを使います。実際に使えるツールはプラットフォームの設定とワークスペースのポリシーに依存します。

## ソースから起動する

必要なもの: Git、**Node.js 22.22.1 以降**、**Corepack と pnpm 10**。
リポジトリは pnpm `10.0.0` を固定しています。CI の Node 基準バージョンは `22.22.1` です。

### 1. インストールとビルド

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

このビルドには CLI、daemon、Web アプリと、それらのワークスペース依存関係が含まれます。
Desktop と Mobile には別のセットアップが必要です。

### 2. daemon を起動する

リポジトリのルートで、最初のターミナルから実行し、起動したままにしてください。

```bash
corepack pnpm ling daemon start --foreground
```

標準アドレスは `http://127.0.0.1:17891` です。ループバックアドレスでの待ち受けを維持してください。

### 3. Web UI を開く

2 つ目のターミナルで、同じリポジトリのルートから実行します。

```bash
corepack pnpm ling ui --foreground --open
```

ブラウザーが自動で開かない場合は `http://127.0.0.1:5173` にアクセスしてください。
別のターミナルで `curl http://127.0.0.1:17891/health` を実行すると、`"ok": true` を含む JSON が返るはずです。
これはローカルサービスの起動確認であり、モデルの利用準備が整ったことを示すものではありません。

### 4. モデルを接続して会話する

**Settings → Model Workbench** を開き、チャット対応モデルとご自身の API キーを追加して、**Check** を実行します。
最初にチェックを通過したチャットモデルがワークスペースの既定モデルになります。新しい会話で小さな質問を送り、回答と詳細を確認してください。

設定とチェックが済んだら、次を実行します。

```bash
corepack pnpm ling doctor
```

Doctor はモデルの準備状況とローカルサービスの状態を確認します。
チャットモデル未設定のワークスペースでは、daemon と Web UI が起動していてもプロバイダーのエラーが報告されます。
[導入ガイド](docs/getting-started.md)で最初のモデル、会話、チャンネルを設定できます。エラーは[トラブルシューティング](docs/troubleshooting.md)を参照してください。

## サポート範囲と制限

| 機能・連携 | 現在の範囲 |
| --- | --- |
| Web、daemon、CLI | ソースコード版アルファの標準的な導入経路 |
| Electron Desktop | 開発用シェル。プラットフォームの準備とクリーン環境での検証は別途必要 |
| Chrome 拡張と Browser Host | ローカル開発向け連携。Chrome Web Store での公開は未完了 |
| MCP と Plugin Manager | ツールの明示的な割り当て、有効化、承認が必要 |
| Office と Computer Use のネイティブ機能 | プラットフォーム依存の開発段階。実装・リリースの検証条件を参照 |
| 画像・動画生成 | プロバイダーと機能に依存。一部の実サービスアダプターには未完了の検証がある |
| Mobile | 実験的な開発であり、現在の製品検証の対象外 |

一部のネイティブ機能では、実行、アクセシビリティ、署名、インストーラーの検証が未完了です。
[実装状況](docs/design/implementation-status.md)に実装済みの内容と残る検証を記載しています。
ソースのビルド成功や個別テストの成功だけでは、インストーラーの利用準備完了を保証できません。

質問や再現可能な不具合は、[サポート方針](SUPPORT.md)を読み、[GitHub Issue フォーム](https://github.com/ling-stack-org/ling-stack/issues/new/choose)で報告してください。
保守は可能な範囲で行います。脆弱性は[セキュリティ報告窓口](SECURITY.md)を利用し、公開 Issue に機密情報を載せないでください。

### Desktop の開発

macOS では Swift と `codesign` を含む Xcode Command Line Tools、Windows では Office ドライバー用の .NET 8 SDK が追加で必要です。
現在の配布対象は macOS arm64 と Windows x64 です。Electron のプラットフォーム用バイナリーも必要です。
[Desktop のトラブルシューティング](docs/troubleshooting.md#desktop-development)を参照してください。

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

ツール、ビルド、手動確認については[Mac・Windows 開発パッケージガイド](docs/release/development-packages.md)を参照してください。
配布用パッケージを作る前に[Desktop のリリースと検証](docs/release/desktop.md)を確認してください。
ソースコードの公開と署名済みバイナリーの配布は別の工程です。

## データと権限

標準のワークスペースデータは `.ling-stack/` に保存されます。`ling-stack.sqlite`、`sessions/`、`artifacts/`、`logs/` が含まれます。
Model Workbench に入力した API キーもローカルのワークスペースストレージに保存されます。
環境変数と対応するキーチェーン参照も利用できます。[設定とデータ](docs/getting-started.md#configuration-and-data)を参照してください。

キー、データベース、セッションログ、非公開の成果物を Git や公開レポートに含めないでください。
ファイルアクセス、シェルコマンド、外部サービスへの変更、有料生成はワークスペースの権限に従います。承認前に要求内容を確認してください。
保存先の移行には [CLI のストレージ操作](docs/design/workspace-state-storage.md)を使ってください。

## 詳しく知る・貢献する

役に立ったら Star で更新をフォローできます。試したタスク、つまずいた箇所、結果について [Issue フォーム](https://github.com/ling-stack-org/ling-stack/issues/new/choose)で教えてください。

Web (`apps/web`)、Desktop (`apps/desktop`)、CLI (`packages/cli`) は共通の daemon (`packages/daemon`) を利用します。
ドメインロジック、契約、プロバイダーアダプター、ランタイム連携は `packages/` にあります。

- [貢献ガイド](CONTRIBUTING.md)と [README 翻訳方針](CONTRIBUTING.md#readme-translations): 開発、検証、翻訳の修正。
- [最初のプロジェクトレビュー](docs/community/first-project-review.md)と[コミュニティ公開資料](docs/community/launch-kit.md): 初めての共同作業とフィードバック。
- [アーキテクチャ](docs/architecture.md)と [Daemon API](docs/daemon-api.md): システムの境界。
- [設計索引](docs/design/README.md)と[実装状況](docs/design/implementation-status.md): 現行の契約と検証条件。
- [プロバイダーアダプター](docs/provider-adapters.md)と [Pi 連携](docs/pi-coding-agent-integration.md): モデルとランタイム。
- [リリース方針](docs/release/README.md)、[変更履歴](CHANGELOG.md)、[サードパーティーに関する表記](THIRD_PARTY_NOTICES.md)。

Ling Stack は [MIT ライセンス](LICENSE)で公開されています。コミュニティへの参加には[行動規範](CODE_OF_CONDUCT.md)が適用されます。
