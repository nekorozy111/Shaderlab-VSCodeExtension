# Performance / Memory diagnostics

この拡張には `URP ShaderLab Tools: Show Memory Stats` コマンドを追加しています。
Language Serverが保持しているDocument/AST/include cache/Symbol数と、Node.jsの`process.memoryUsage()`をOutput Channelへ出力します。

## メモリリーク確認手順

1. VS Codeで大きめの`.shader`/`.hlsl`を開く。
2. `URP ShaderLab Tools: Show Memory Stats` を実行して基準値を記録する。
3. ファイルを編集、保存、閉じる操作を繰り返す。
4. 同じコマンドを実行し、`documents`、`parsedDocuments`、`externalDocuments`、`externalSources`、`includeDependencies`、`relatedIncludeCaches`、`externalReferenceCounts`、`includeDependents`、`workspaceSymbols` が不要に増え続けていないか確認する。
5. `heapUsed` はNode.js GCの影響を受けるため、単発の増加ではなく、GC後も長期的に増え続けるかを確認する。

## 遅延確認

- 編集直後のCompletion/Hover/F12では、最新ASTを同期Parseせず、debounce済みの直前ASTを再利用します。
- Completionのコメント/文字列/HLSLブロック判定はversion単位でキャッシュします。
- Include解決の`stat`/`readdir`は500msの短期キャッシュを使い、File Watcherの変更通知で即時無効化します。

そのため、編集直後の1回だけ古いIndexを参照する可能性があります。次のdebounce更新で最新AST/Indexへ反映されます。
