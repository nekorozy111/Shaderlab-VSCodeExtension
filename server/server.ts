import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  DidChangeWatchedFilesNotification,
  WatchKind,
  Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentManager } from './language/documentManager';
import { DefinitionProvider } from './language/definitionProvider';
import { HoverProvider } from './language/hoverProvider';
import { CompletionProvider } from './language/completionProvider';
import { ReferenceProvider } from './language/referenceProvider';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const documentManager = new DocumentManager();
const definitionProvider = new DefinitionProvider(documentManager);
const hoverProvider = new HoverProvider(documentManager, definitionProvider);
const completionProvider = new CompletionProvider(documentManager, documentManager.getProjectService().includeResolver);
const referenceProvider = new ReferenceProvider(documentManager, definitionProvider);
// 連続入力中のParseをまとめる。
// LSP requestでは直前のASTを再利用し、ここでだけ最新DocumentをParse/Indexする。
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
  documentManager.getProjectService().includeResolver.warmUp();
  await connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [
      {
        globPattern: '**/*.{hlsl,hlsli,compute,cginc}',
        kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
      },
    ],
  });
});
connection.onDefinition(async (params) => {
  const uri = params.textDocument.uri;
  const document = documentManager.get(uri);
  const version = document?.version ?? -1;
  const key = `definition|${uri}|${params.position.line}|${params.position.character}`;
  await documentManager.prepareRelatedIncludeUris(uri);
  const cached = getCachedRequest<ReturnType<DefinitionProvider['provideDefinition']>>(key, version);
  if (cached !== undefined) {
    return cached;
  }

  const result = definitionProvider.provideDefinition(uri, params.position);
  setCachedRequest(key, version, result);
  return result;
});
connection.onReferences(async (params) => {
  const uri = params.textDocument.uri;
  const document = documentManager.get(uri);
  const version = document?.version ?? -1;
  const key = `references|${uri}|${params.position.line}|${params.position.character}|${params.context.includeDeclaration}`;
  await documentManager.prepareRelatedIncludeUris(uri);
  const cached = getCachedRequest<Location[]>(key, version);
  if (cached !== undefined) {
    return cached;
  }

  const result = await referenceProvider.provideReferences(
    uri,
    params.position,
    params.context.includeDeclaration,
  );
  setCachedRequest(key, version, result);
  return result;
});
connection.onHover(async (params) => {
  const uri = params.textDocument.uri;
  const document = documentManager.get(uri);
  const version = document?.version ?? -1;
  const key = `hover|${uri}|${params.position.line}|${params.position.character}`;
  await documentManager.prepareRelatedIncludeUris(uri);
  const cached = getCachedRequest<ReturnType<HoverProvider['provideHover']>>(key, version);
  if (cached !== undefined) {
    return cached;
  }

  const result = hoverProvider.provideHover(uri, params.position);
  setCachedRequest(key, version, result);
  return result;
});
connection.onCompletion(async (params) => {
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
  hoverProvider.invalidateDocument(event.document.uri);
  // ParseはWorkerへ委譲するため、open通知ではPromiseを待たずイベントループを継続する。
  void documentManager.open(event.document).catch((error) => {
    connection.console.error(`Failed to parse opened document: ${String(error)}`);
  });
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

    void documentManager.update(latest).catch((error) => {
      connection.console.error(`Failed to parse changed document: ${String(error)}`);
    });
  }, UPDATE_DEBOUNCE_MS);
  pendingDocumentUpdates.set(uri, timer);
});
connection.onDidChangeWatchedFiles((event) => {
  invalidateRequestCache();
  documentManager
    .getProjectService()
    .updateChangedIncludeFiles(event.changes.map((change) => ({ uri: change.uri, type: change.type })));
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

  hoverProvider.invalidateDocument(event.document.uri);
  documentManager.close(event.document);
});
connection.onRequest('urpShaderLab/memoryStats', () => documentManager.getMemoryStats());

connection.onShutdown(() => {
  for (const timer of pendingDocumentUpdates.values()) {
    clearTimeout(timer);
  }

  pendingDocumentUpdates.clear();
  // TTLを待たず、LSP終了時にリクエスト結果を即時解放する。
  requestResultCache.clear();
  // Document / AST / include graph / external documentを明示的に解放する。
  hoverProvider.clear();
  documentManager.dispose();
});
documents.listen(connection);
connection.listen();
