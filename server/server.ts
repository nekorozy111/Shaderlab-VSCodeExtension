import {
  createConnection,
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
const REQUEST_CACHE_TTL_MS = 100;
const REQUEST_CACHE_MAX_ENTRIES = 32;
const pendingDocumentUpdates = new Map<string, ReturnType<typeof setTimeout>>();

type CachedRequestResult = {
  version: number;
  expiresAt: number;
  value: any;
};

// 同じ位置へのF12/Hover/Completion要求が短時間に重複するケースを抑える。
// versionをキーに含めるため、編集後の古い結果を再利用しない。
const requestResultCache = new Map<string, CachedRequestResult>();

function getCachedRequest<T>(key: string, version: number): T | undefined {
  const cached = requestResultCache.get(key);
  if (!cached) {
    return undefined;
  }

  if (cached.version !== version || cached.expiresAt <= Date.now()) {
    requestResultCache.delete(key);
    return undefined;
  }

  // LRU: 最近使ったエントリを末尾へ移動する。
  requestResultCache.delete(key);
  requestResultCache.set(key, cached);
  return cached.value as T;
}

function setCachedRequest(key: string, version: number, value: any): void {
  requestResultCache.delete(key);
  requestResultCache.set(key, {
    version,
    expiresAt: Date.now() + REQUEST_CACHE_TTL_MS,
    value,
  });

  while (requestResultCache.size > REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = requestResultCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    requestResultCache.delete(oldestKey);
  }
}

function invalidateRequestCache(uri?: string): void {
  if (!uri) {
    requestResultCache.clear();
    return;
  }

  for (const key of requestResultCache.keys()) {
    if (key.startsWith(`${uri}|`)) {
      requestResultCache.delete(key);
    }
  }
}
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
  const uri = params.textDocument.uri;
  const document = documentManager.get(uri);
  const version = document?.version ?? -1;
  const key = `definition|${uri}|${params.position.line}|${params.position.character}`;
  const cached = getCachedRequest<ReturnType<DefinitionProvider['provideDefinition']>>(key, version);
  if (cached !== undefined) {
    return cached;
  }

  const result = definitionProvider.provideDefinition(uri, params.position);
  setCachedRequest(key, version, result);
  return result;
});

connection.onHover((params) => {
  const uri = params.textDocument.uri;
  const document = documentManager.get(uri);
  const version = document?.version ?? -1;
  const key = `hover|${uri}|${params.position.line}|${params.position.character}`;
  const cached = getCachedRequest<ReturnType<HoverProvider['provideHover']>>(key, version);
  if (cached !== undefined) {
    return cached;
  }

  const result = hoverProvider.provideHover(uri, params.position);
  setCachedRequest(key, version, result);
  return result;
});

connection.onCompletion((params) => {
  const uri = params.textDocument.uri;
  const document = documentManager.get(uri);
  const version = document?.version ?? -1;
  const key = `completion|${uri}|${params.position.line}|${params.position.character}`;
  const cached = getCachedRequest<ReturnType<CompletionProvider['provideCompletion']>>(key, version);
  if (cached !== undefined) {
    return cached;
  }

  const result = completionProvider.provideCompletion(uri, params.position);
  setCachedRequest(key, version, result);
  return result;
});

documents.onDidOpen((event) => {
  // Open時点でDocumentManagerにも登録しておく。
  // 変更通知を待たずにF12/Hover/Completionを要求されても最新Documentを取得できる。
  const parsed = documentManager.open(event.document);
  // 初回Parse結果はDocumentManager/WorkspaceIndexへ登録済み。
  void parsed;
});

documents.onDidChangeContent((event) => {
  const uri = event.document.uri;
  invalidateRequestCache(uri);

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

    documentManager.update(latest);
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
  invalidateRequestCache(event.document.uri);

  const pending = pendingDocumentUpdates.get(event.document.uri);
  if (pending) {
    clearTimeout(pending);
    pendingDocumentUpdates.delete(event.document.uri);
  }

  documentManager.close(event.document);
});

connection.onShutdown(() => {
  for (const timer of pendingDocumentUpdates.values()) {
    clearTimeout(timer);
  }
  pendingDocumentUpdates.clear();

  // TTLを待たず、LSP終了時にリクエスト結果を即時解放する。
  requestResultCache.clear();

  // Document / AST / include graph / external documentを明示的に解放する。
  documentManager.dispose();
});

documents.listen(connection);

connection.listen();
