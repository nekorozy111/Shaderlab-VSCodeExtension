import {
    createConnection,
    InitializeParams,
    InitializeResult,
    ProposedFeatures,
    TextDocuments,
    TextDocumentSyncKind
} from "vscode-languageserver/node";

import {
    TextDocument
} from "vscode-languageserver-textdocument";

import {
    ParsedDocument
} from "./parser/ast";

import {
    DocumentManager
} from "./language/documentManager";

const connection =
    createConnection(
        ProposedFeatures.all
    );

const documents =
    new TextDocuments<TextDocument>(
        TextDocument
    );

const documentManager =
    new DocumentManager();

connection.onInitialize(
    (
        _params:
            InitializeParams
    ): InitializeResult => {

        return {
            capabilities: {

                textDocumentSync:
                    TextDocumentSyncKind
                        .Incremental,

                completionProvider: {
                    resolveProvider:
                        false
                },

                hoverProvider:
                    true,

                definitionProvider:
                    true,

                referencesProvider:
                    true
            }
        };
    }
);

documents.onDidOpen(
    event => {

        const parsed =
            documentManager.open(
                event.document
            );

        logParsedDocument(
            parsed
        );
    }
);

documents.onDidChangeContent(
    event => {

        const parsed =
            documentManager.update(
                event.document
            );

        logParsedDocument(
            parsed
        );
    }
);

documents.onDidClose(
    event => {

        documentManager.close(
            event.document
        );

        connection.console.log(
            `[URP ShaderLab] Closed: ${event.document.uri}`
        );
    }
);

function logParsedDocument(
    parsed:
        ParsedDocument
): void {

    if (
        parsed.ast.kind ===
        "ShaderDocument"
    ) {

        const hlslBlockCount =
            parsed.ast.hlslBlocks.length +
            parsed.ast.subShaders.reduce(
                (
                    total,
                    subShader
                ) => {

                    return (
                        total +
                        subShader
                            .hlslBlocks
                            .length +
                        subShader
                            .passes
                            .reduce(
                                (
                                    passTotal,
                                    pass
                                ) =>
                                    passTotal +
                                    pass
                                        .hlslBlocks
                                        .length,
                                0
                            )
                    );
                },
                0
            );

        connection.console.log(
            [
                "[URP ShaderLab] Parsed ShaderLab",
                `Shader="${parsed.ast.shaderName ?? "<unnamed>"}"`,
                `Properties=${parsed.ast.properties.length}`,
                `SubShaders=${parsed.ast.subShaders.length}`,
                `HLSLBlocks=${hlslBlockCount}`
            ].join(" | ")
        );

        return;
    }

    connection.console.log(
        [
            "[URP ShaderLab] Parsed HLSL",
            `Declarations=${parsed.ast.declarations.length}`
        ].join(" | ")
    );
}

documents.listen(
    connection
);

connection.listen();