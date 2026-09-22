# URP ShaderLab Tools

VS Code向けの Unity URP ShaderLab / HLSL 開発支援拡張機能です。

Unity の ShaderLab シェーダーや HLSL ファイルに対して、コード補完・Hover・定義ジャンプなどの IntelliSense 機能を提供します。

## Features

### ShaderLab IntelliSense

Unity ShaderLab の構造を解析し、シェーダー内の各要素を認識します。

- `Shader`
- `Properties`
- `SubShader`
- `Pass`
- `HLSLPROGRAM`
- `HLSLEND`
- HLSL declarations

ShaderLab と HLSL が混在した `.shader` ファイルにも対応しています。

### HLSL IntelliSense

HLSL の宣言を解析し、コード補完などを提供します。

対応している主な要素：

- Functions
- Structs
- CBuffers
- Macros
- Includes
- Variables

### Go to Definition

F12 または「定義へ移動」から、HLSL の定義位置へ移動できます。

ローカルファイル内のシンボルだけでなく、`#include` されたファイルの定義も検索します。

Unity URP のパッケージ内にある HLSL ファイルも解析対象になります。

また、include 先のファイルがさらに別の HLSL ファイルを include している場合も、依存関係を辿って定義を検索します。

### Hover

HLSL のシンボル上にカーソルを置くことで、シンボル情報を表示します。

`#include` のパスについては通常の HLSL シンボルとして扱わないため、include パス上で不要な Hover が表示されることを防いでいます。

### Include Completion

`#include` のパス補完に対応しています。

引用符の入力後から include ファイルの候補を表示できます。

対応している拡張子：

- `.hlsl`
- `.hlsli`
- `.cginc`

相対パスにも対応しており、現在のファイルを基準にした include 候補を検索できます。

### Include の名前検索

パスを指定せずにファイル名から検索することもできます。

プロジェクト内の HLSL ファイルを検索し、使用可能な相対パスとして候補を表示します。

別のフォルダに存在する HLSL ファイルであっても、現在のファイルから利用できる相対パスを生成します。

### Relative Include

以下のような相対パスに対応しています。

- `../`
- `../../`
- `../Folder/`
- `../../Folder/`

プロジェクトルートより外側へ移動する候補は生成しません。

また、通常のプロジェクトファイル検索では以下のディレクトリを除外しています。

- `Library/`
- `Packages/`
- `ProjectSettings/`

### Unity Package / PackageCache

Unity Package の HLSL も解析対象になります。

URP の `Core.hlsl` など、`Packages` 以下に存在する HLSL ファイルを解決できます。

さらに、Package 内から別の HLSL ファイルを include している場合も、include の依存関係を辿って検索します。

Unity の `Library/PackageCache` に展開されているパッケージも解決対象です。

## Supported File Types

現在対応しているファイル：

| Extension | Language  |
| --------- | --------- |
| `.shader` | ShaderLab |
| `.hlsl`   | HLSL      |
| `.hlsli`  | HLSLI     |

Include の検索対象：

| Extension | Include |
| --------- | ------- |
| `.hlsl`   | ✓       |
| `.hlsli`  | ✓       |
| `.cginc`  | ✓       |

## Requirements

- Visual Studio Code 1.90.0 以上
- Unity project
- Unity URP

Unity プロジェクト内で使用することを想定しています。

## Installation

### Development Version

1. リポジトリを clone します。

   `git clone https://github.com/nekorozy111/Shaderlab-VSCodeExtension.git`

2. プロジェクトディレクトリへ移動します。

   `cd Shaderlab-VSCodeExtension`

3. 依存パッケージをインストールします。

   `npm install`

4. TypeScript をコンパイルします。

   `npm run compile`

5. VS Code でプロジェクトを開き、`F5` を押して Extension Development Host を起動します。

## Usage

Unity プロジェクトを VS Code で開き、`.shader`、`.hlsl`、`.hlsli` ファイルを編集します。

### Go to Definition

`F12` または「右クリック → Go to Definition」を使用します。

### Completion

通常の VS Code の補完操作で候補を表示できます。

`#include` のパスを入力している場合は、現在のファイルやプロジェクト内の HLSL ファイルを基準に候補を表示します。

### Hover

HLSL のシンボルにカーソルを合わせると、シンボル情報が表示されます。

## Architecture

この拡張機能は、VS Code Extension と Language Server の構成になっています。

VS Code → Language Client → Language Server

Language Server は主に以下のコンポーネントで構成されています。

- Document Manager
- Parser
- ShaderLab Parser
- HLSL Parser
- Symbol Extractor
- Workspace Index
- Definition Provider
- Hover Provider
- Completion Provider
- Include Resolver

### Parser

ShaderLab と HLSL を解析して AST を生成します。

### Symbol Index

解析した HLSL / ShaderLab のシンボルをワークスペース単位で管理します。

### Definition Provider

ローカルファイルおよび `#include` の依存関係を辿って定義を検索します。

### Include Resolver

現在のファイル、プロジェクトルート、`Packages`、`Library/PackageCache` などを対象に include ファイルを解決します。

### Completion Provider

通常の HLSL 補完に加えて、`#include` 専用のパス補完を提供します。

## Include Cache

プロジェクト内の HLSL ファイル検索にはキャッシュを使用します。

対象：

- `.hlsl`
- `.hlsli`
- `.cginc`

HLSL ファイルの作成・変更・削除を検知すると include キャッシュを無効化し、次回の検索時に再生成します。

監視対象は HLSL 関連ファイルです。

## Configuration

VS Code の設定から以下を変更できます。

### `urpShaderLab.enable`

拡張機能を有効 / 無効にします。

デフォルト：

`true`

### `urpShaderLab.trace.server`

Language Server の通信ログレベルを設定します。

指定可能な値：

- `off`
- `messages`
- `verbose`

デフォルト：

`off`

## Development

### Compile

`npm run compile`

### Watch Mode

`npm run watch`

TypeScript の変更を監視して自動コンパイルします。

### Package

VSIX を生成します。

`npm run package`

## Project Structure

主な構成：

- `src/extension.ts`
- `src/client/languageClient.ts`
- `src/server/server.ts`
- `src/server/language/`
- `src/server/parser/`
- `src/server/project/`
- `src/server/symbol/`

## Current Status

現在対応している主な機能：

- [x] ShaderLab parsing
- [x] HLSL parsing
- [x] HLSL symbol extraction
- [x] Workspace symbol index
- [x] Go to Definition
- [x] Hover
- [x] HLSL Completion
- [x] `#include` completion
- [x] Relative include completion
- [x] Project-wide include filename search
- [x] Unity Packages include resolution
- [x] Unity PackageCache include resolution
- [x] Recursive include resolution
- [x] Include cache
- [x] Include cache invalidation on file changes

開発中のため、Unity のバージョンや URP のバージョンによっては解析できない構文や特殊な include が存在する場合があります。

## License

MIT License
