import {
  createConnection,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  WatchKind,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { ParsedDocument } from './parser/ast';

import { DocumentManager } from './language/documentManager';

import { ShaderSymbol } from './symbol/symbol';

import { DefinitionProvider } from './language/definitionProvider';
import { HoverProvider } from './language/hoverProvider';

import { CompletionProvider } from './language/completionProvider';
import { IncludeResolver } from './project/includeResolver';

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments<TextDocument>(TextDocument);

const documentManager = new DocumentManager();

const definitionProvider = new DefinitionProvider(documentManager);

const hoverProvider = new HoverProvider(documentManager, definitionProvider);

const completionProvider = new CompletionProvider(documentManager, documentManager.getProjectService().includeResolver);

// 連続入力中のParseをまとめる。
// F12/hover等で最新ASTが必要になった場合はDocumentManager.getParsed()が
// version差分を検出して即時更新するため、定義ジャンプの正確性は維持される。
const UPDATE_DEBOUNCE_MS = 150;
const pendingDocumentUpdates = new Map<string, ReturnType<typeof setTimeout>>();
connection.onInitialize((params) => {
  documentManager.initializeProject(params);

  const rootPath = documentManager.getProjectService().getRootPath();

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: 2,
      },

      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['/', '\\', '"'],
      },

      hoverProvider: true,

      definitionProvider: true,

      referencesProvider: true,
    },
  };
});
connection.onInitialized(async () => {
  await connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [
      {
        globPattern: '**/*.{hlsl,hlsli,cginc}',
        kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
      },
    ],
  });
});

connection.onDefinition((params) => {
  return definitionProvider.provideDefinition(params.textDocument.uri, params.position);
});
connection.onHover((params) => {
  return hoverProvider.provideHover(params.textDocument.uri, params.position);
});

connection.onCompletion((params) => {
  return completionProvider.provideCompletion(params.textDocument.uri, params.position);
});

documents.onDidOpen((event) => {
  logIncludeResolution(
    documentManager,
    'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl',
    event.document.uri,
  );
});

documents.onDidChangeContent((event) => {
  const uri = event.document.uri;

  // 最新Documentはすぐ保持するが、重いParse/Index更新はdebounceする。
  documentManager.set(event.document);

  const pending = pendingDocumentUpdates.get(uri);
  if (pending) {
    clearTimeout(pending);
  }

  const timer = setTimeout(() => {
    pendingDocumentUpdates.delete(uri);

    const latest = documentManager.get(uri);
    if (!latest) {
      return;
    }

    const parsed = documentManager.update(latest);
    logParsedDocument(parsed);
  }, UPDATE_DEBOUNCE_MS);

  pendingDocumentUpdates.set(uri, timer);
});

connection.onDidChangeWatchedFiles((event) => {
  documentManager.getProjectService().invalidateIncludeCache();

  // 変更されたファイルを参照している root だけを include graph から無効化する。
  // PackageCache 全体を毎回捨てる必要はない。
  documentManager.invalidateChangedExternalIncludes(event.changes.map((change) => change.uri));
});

documents.onDidClose((event) => {
  const pending = pendingDocumentUpdates.get(event.document.uri);
  if (pending) {
    clearTimeout(pending);
    pendingDocumentUpdates.delete(event.document.uri);
  }

  documentManager.close(event.document);
});

function logParsedDocument(parsed: ParsedDocument): void {
  if (parsed.ast.kind === 'ShaderDocument') {
    const hlslBlockCount =
      parsed.ast.hlslBlocks.length +
      parsed.ast.subShaders.reduce((total, subShader) => {
        return (
          total +
          subShader.hlslBlocks.length +
          subShader.passes.reduce((passTotal, pass) => passTotal + pass.hlslBlocks.length, 0)
        );
      }, 0);
    return;
  }
}

function logIncludeResolution(documentManager: DocumentManager, includePath: string, fromUri: string): void {
  const result = documentManager.getProjectService().resolveInclude(includePath, fromUri);

  if (!result) {
    return;
  }
}

documents.listen(connection);

connection.listen();
