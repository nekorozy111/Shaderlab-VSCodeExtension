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

import {
    ShaderSymbol
} from "./symbol/symbol";

import { DefinitionProvider } from "./language/definitionProvider";
import {
    HoverProvider
} from "./language/hoverProvider";
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

    const definitionProvider =
    new DefinitionProvider(
        documentManager
    );

const hoverProvider =
    new HoverProvider(
        documentManager,
        definitionProvider
    );

connection.onInitialize((params) => {
    documentManager.initializeProject(params);

    const rootPath =
        documentManager
            .getProjectService()
            .getRootPath();

    connection.console.log(
        `[URP ShaderLab] Project Root: ${rootPath ?? "(none)"}`
    );

    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: 2
            },

            completionProvider: {
                resolveProvider: false
            },

            hoverProvider: true,

            definitionProvider: true,

            referencesProvider: true
        }
    };
});

connection.onDefinition(
    (params) => {
        return definitionProvider.provideDefinition(
            params.textDocument.uri,
            params.position
        );
    }
);
connection.onHover((params) => {

    return hoverProvider.provideHover(
        params.textDocument.uri,
        params.position
    );
});
documents.onDidOpen(
    event => {

const parsed = documentManager.open(event.document);

connection.console.log(
    `[URP ShaderLab] Opened: ${event.document.uri}`
);

connection.console.log(
    `[URP ShaderLab] Symbols: ` +
    `${documentManager
        .getWorkspaceIndex()
        .getSymbolCount()}`
);

logIncludeResolution(
    documentManager,
    "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl",
    event.document.uri
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

        logWorkspaceIndex();
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

        logWorkspaceIndex();
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

function logWorkspaceIndex(): void {

    const index =
        documentManager
            .getWorkspaceIndex();

    connection.console.log(
        [
            "[URP ShaderLab] Workspace Index",
            `Documents=${index.getDocumentCount()}`,
            `Symbols=${index.getSymbolCount()}`
        ].join(" | ")
    );

    const interestingNames = [
        "Attributes",
        "Varyings",
        "vert",
        "TestColor",
        "_BaseColor",
        "_Metallic"
    ];

for (const name of interestingNames) {
    const matches =
        index.findExact(name);

    connection.console.log(
        `[URP ShaderLab] ` +
        `Find "${name}": ` +
        `${matches.length}`
    );

    for (const match of matches) {
        connection.console.log(
            `[URP ShaderLab]   ` +
            `${match.symbol.name} ` +
            `[${match.symbol.kind}] ` +
            `${match.uri} ` +
            `@ ` +
            `${match.symbol.location.selectionRange.start.line}:` +
            `${match.symbol.location.selectionRange.start.character}`
        );
    }
}
}

function formatSymbol(
    symbol: ShaderSymbol,
    uri: string
): string {

    const location =
        symbol.location
            .range
            .start;

    return [
        "[URP ShaderLab] Symbol",
        `name="${symbol.name}"`,
        `kind=${symbol.kind}`,
        `uri="${uri}"`,
        `line=${location.line + 1}`,
        `character=${location.character + 1}`
    ].join(" | ");
}

function logIncludeResolution(
    documentManager: DocumentManager,
    includePath: string,
    fromUri: string
): void {
    const result = documentManager
        .getProjectService()
        .resolveInclude(
            includePath,
            fromUri
        );

    if (!result) {
        connection.console.log(
            `[URP ShaderLab] Include NOT FOUND: ${includePath}`
        );

        return;
    }

    connection.console.log(
        `[URP ShaderLab] Include: ` +
        `${includePath} -> ` +
        `${result.resolvedPath} ` +
        `[${result.source}]`
    );
}

documents.listen(
    connection
);

connection.listen();