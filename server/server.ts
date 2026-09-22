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
  const parsed = documentManager.update(event.document);

  logParsedDocument(parsed);
});

connection.onDidChangeWatchedFiles(() => {
  documentManager.getProjectService().invalidateIncludeCache();
});

documents.onDidClose((event) => {
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
