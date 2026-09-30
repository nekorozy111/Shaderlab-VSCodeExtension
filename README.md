# URP ShaderLab Tools

Unity URP向けのShaderLab / HLSL用VS Code拡張です。

## Features

- ShaderLab / HLSLのパース
- コード補完
  - HLSL組み込み型
  - HLSLセマンティクス
  - ローカル変数
  - 構造体・関数・変数などのシンボル
  - `#include` パス
  - メンバーアクセス
- Hover
- Go to Definition（F12）
- References
- ShaderLabからHLSL、HLSLから関連includeへの定義検索
- Unity `Packages` / `Library/PackageCache` のinclude解決
- `.shader` / `.hlsl` / `.hlsli` / `.compute` / `.cginc` の解析
- 編集中の再解析を抑えるdebounceとリクエストキャッシュ

## Usage

UnityプロジェクトをVS Codeで開くだけで使用できます。

- `.shader`：ShaderLabとして解析
- `.hlsl` / `.hlsli` / `.compute` / `.cginc`：HLSLとして解析
- `F12`：定義へ移動
- Hover：シンボル情報を表示
- `Ctrl+Space`：補完を表示

## Settings

`settings.json` で変更できます。

```json
{
  "urpShaderLab.enable": true,
  "urpShaderLab.trace.server": "off"
}
```

`urpShaderLab.trace.server` は `off` / `messages` / `verbose` に対応します。

## License

MIT
