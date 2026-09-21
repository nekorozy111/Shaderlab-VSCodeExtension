import {
    Hover,
    MarkupContent,
    Position
} from "vscode-languageserver/node";

import {
    DocumentManager
} from "./documentManager";

import {
    ShaderSymbol
} from "../symbol/symbol";

import {
    DefinitionProvider
} from "./definitionProvider";

import {
    HlslStructNode,
    ShaderHlslBlockNode
} from "../parser/ast";

export class HoverProvider {

    constructor(
        private readonly documentManager: DocumentManager,
        private readonly definitionProvider: DefinitionProvider
    ) { }

    public provideHover(
        uri: string,
        position: Position
    ): Hover | null {

        const document =
            this.documentManager.get(uri);

        if (!document) {
            return null;
        }

        const offset =
            document.offsetAt(position);

        const text =
            document.getText();

        const word =
            this.getWordAtPosition(
                text,
                offset
            );

        if (!word) {
            return null;
        }

        console.log(
            `[HoverProvider] Request "${word}" in ${uri}`
        );

        const semanticDescription =
            this.getSemanticDescription(word);

        if (semanticDescription) {
            const offset =
                document.offsetAt(
                    position
                );

            const field =
                this.findFieldBySemantic(
                    uri,
                    offset,
                    word
                );

            if (field) {
                return {
                    contents: {
                        kind: "markdown",
                        value:
                            `**${field.name}**\n\n` +
                            `\`${field.typeName}\` ` +
                            `\`${field.semantic}\`\n\n` +
                            semanticDescription
                    }
                };
            }

            return {
                contents: {
                    kind: "markdown",
                    value:
                        `**${word}**\n\n` +
                        semanticDescription
                }
            };
        }

        let symbol =
            this.definitionProvider
                .resolveSymbolAtPosition(
                    uri,
                    position
                );

        /*
         * DefinitionProvider で見つからない場合、
         * include scope 内の WorkspaceIndex から検索する。
         */
        if (!symbol) {
            symbol =
                this.findIncludedSymbol(
                    uri,
                    word
                );
        }

        /*
         * Function-local variables are not currently
         * represented in the HLSL AST, so fall back to
         * resolving a local variable declaration here.
         */
        if (!symbol) {
            symbol =
                this.findLocalVariableSymbol(
                    uri,
                    word,
                    offset
                );
        }
        if (!symbol) {
            console.log(
                `[HoverProvider] Symbol not found: "${word}"`
            );

            return null;
        }

        console.log(
            `[HoverProvider] Symbol found: ${symbol.name} (${symbol.kind})`
        );

        return {
            contents: this.createHoverContents(
                symbol
            )
        };
    }

    private findLocalVariableSymbol(
        uri: string,
        variableName: string,
        offset: number
    ): ShaderSymbol | null {

        const document =
            this.documentManager.get(uri);

        if (!document) {
            return null;
        }

        const text =
            document.getText();

        const sourceBeforeCursor =
            text.substring(
                0,
                Math.max(
                    0,
                    Math.min(
                        offset,
                        text.length
                    )
                )
            );

        const maskedSource =
            this.maskComments(
                sourceBeforeCursor
            );

        const escapedName =
            variableName.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );

        /*
         * Match declarations such as:
         *
         *     CGOutput output;
         *     float3 position;
         *     float4 color = ...;
         *     CGOutput output[2];
         */
const pattern =
    new RegExp(
        `\\b` +
        `(?:(?:const|static|uniform|volatile|inline)\\s+)*` +
        `([A-Za-z_][A-Za-z0-9_]*)\\s+` +
        `${escapedName}\\s*` +
        `(?:;|=|\\[|,)`,
        "g"
    );

        let lastMatch:
            RegExpExecArray | null = null;

        let match:
            RegExpExecArray | null;

        while (
            (match =
                pattern.exec(
                    maskedSource
                )) !== null
        ) {
            lastMatch = match;
        }

        if (!lastMatch) {
            return null;
        }

        const typeName =
            lastMatch[1];

        /*
         * Find the declaration position.
         */
        const declarationOffset =
            lastMatch.index;

        const nameOffset =
            maskedSource.indexOf(
                variableName,
                declarationOffset
            );

        if (nameOffset < 0) {
            return null;
        }

        const relatedUris =
            this.documentManager
                .getRelatedIncludeUris(uri);

        const typeMatches =
            this.documentManager
                .getWorkspaceIndex()
                .findExact(typeName)
                .filter(
                    match =>
                        relatedUris.has(
                            match.uri
                        )
                );

        /*
         * Prefer a struct/cbuffer symbol as the
         * type information for the local variable.
         */
        const typeSymbol =
            typeMatches.find(
                match =>
                    match.symbol.kind ===
                    "struct" ||
                    match.symbol.kind ===
                    "cbuffer"
            );

        console.log(
            `[HoverProvider] Local variable: ` +
            `${variableName} -> ${typeName}`
        );

        return {
            name: variableName,
            kind: "variable",
            typeName,
            parentName:
                typeSymbol?.symbol.name,
            location: {
                uri,
                range: {
                    start:
                        this.positionFromOffset(
                            text,
                            declarationOffset
                        ),
                    end:
                        this.positionFromOffset(
                            text,
                            nameOffset +
                            variableName.length
                        )
                },
                selectionRange: {
                    start:
                        this.positionFromOffset(
                            text,
                            nameOffset
                        ),
                    end:
                        this.positionFromOffset(
                            text,
                            nameOffset +
                            variableName.length
                        )
                }
            },
            children: []
        };
    }

    private maskComments(
        text: string
    ): string {

        return text.replace(
            /\/\/.*|\/\*[\s\S]*?\*\//g,
            match =>
                match.replace(
                    /[^\r\n]/g,
                    " "
                )
        );
    }

    private positionFromOffset(
        text: string,
        offset: number
    ) {
        let line = 0;
        let character = 0;

        const limit =
            Math.min(
                Math.max(
                    0,
                    offset
                ),
                text.length
            );

        for (
            let index = 0;
            index < limit;
            index++
        ) {
            if (
                text[index] === "\n"
            ) {
                line++;
                character = 0;
            } else {
                character++;
            }
        }

        return {
            offset,
            line,
            character
        };
    }

    private createHoverContents(
        symbol: ShaderSymbol
    ): MarkupContent {

        const lines: string[] = [];

        lines.push(
            `**${symbol.kind}**`
        );

        lines.push(
            `\`${symbol.name}\``
        );

        if (symbol.typeName) {
            lines.push(
                `Type: \`${symbol.typeName}\``
            );
        }

        if (symbol.returnType) {
            lines.push(
                `Return type: \`${symbol.returnType}\``
            );
        }

        if (symbol.semantic) {
            lines.push(
                `Semantic: \`${symbol.semantic}\``
            );
        }

        if (symbol.parentName) {
            lines.push(
                `Parent: \`${symbol.parentName}\``
            );
        }

        return {
            kind: "markdown",
            value: lines.join("\n\n")
        };
    }

    private getWordAtPosition(
        text: string,
        offset: number
    ): string | null {

        if (
            offset < 0 ||
            offset > text.length
        ) {
            return null;
        }

        const isIdentifierCharacter =
            (char: string): boolean => {
                return /[A-Za-z0-9_]/.test(char);
            };

        let start = offset;

        while (
            start > 0 &&
            isIdentifierCharacter(
                text[start - 1]
            )
        ) {
            start--;
        }

        let end = offset;

        while (
            end < text.length &&
            isIdentifierCharacter(
                text[end]
            )
        ) {
            end++;
        }

        if (start === end) {
            return null;
        }

        return text.substring(
            start,
            end
        );
    }
    private getSemanticDescription(
        semantic: string
    ): string | undefined {
        const descriptions: Record<string, string> = {
            POSITION:
                "Vertex position input/output.",

            NORMAL:
                "Vertex normal input/output.",

            TANGENT:
                "Vertex tangent input/output.",

            COLOR:
                "Vertex color input/output.",

            TEXCOORD0:
                "Texture coordinate 0.",

            TEXCOORD1:
                "Texture coordinate 1.",

            TEXCOORD2:
                "Texture coordinate 2.",

            TEXCOORD3:
                "Texture coordinate 3.",

            TEXCOORD4:
                "Texture coordinate 4.",

            TEXCOORD5:
                "Texture coordinate 5.",

            TEXCOORD6:
                "Texture coordinate 6.",

            TEXCOORD7:
                "Texture coordinate 7.",

            SV_POSITION:
                "System-value semantic for vertex position.",

            SV_TARGET:
                "System-value semantic for render-target output.",

            SV_TARGET0:
                "System-value semantic for render-target 0.",

            SV_TARGET1:
                "System-value semantic for render-target 1.",

            SV_TARGET2:
                "System-value semantic for render-target 2.",

            SV_TARGET3:
                "System-value semantic for render-target 3.",

            SV_TARGET4:
                "System-value semantic for render-target 4.",

            SV_TARGET5:
                "System-value semantic for render-target 5.",

            SV_TARGET6:
                "System-value semantic for render-target 6.",

            SV_TARGET7:
                "System-value semantic for render-target 7.",

            SV_DEPTH:
                "System-value semantic for depth output.",

            SV_VERTEXID:
                "System-value semantic containing the vertex ID.",

            SV_INSTANCEID:
                "System-value semantic containing the instance ID.",

            SV_PRIMITIVEID:
                "System-value semantic containing the primitive ID.",

            SV_ISFRONTFACE:
                "System-value semantic indicating whether the primitive is front-facing.",

            SV_SAMPLEINDEX:
                "System-value semantic containing the sample index."
        };

        return descriptions[
            semantic.toUpperCase()
        ];
    }

    private findFieldBySemantic(
        uri: string,
        offset: number,
        semantic: string
    ): {
        name: string;
        typeName: string;
        semantic: string;
    } | undefined {
        const parsed =
            this.documentManager.getParsed(uri);

        if (!parsed) {
            return undefined;
        }

        const ast = parsed.ast;

        if (ast.kind !== "ShaderDocument") {
            return undefined;
        }

        const target =
            semantic.toUpperCase();

        const isInsideRange = (
            range: {
                start: {
                    offset: number;
                };
                end: {
                    offset: number;
                };
            }
        ): boolean => {
            return (
                offset >= range.start.offset &&
                offset <= range.end.offset
            );
        };

        const searchStruct = (
            structNode: HlslStructNode
        ) => {
            for (const field of structNode.fields) {
                if (!field.semantic) {
                    continue;
                }

                if (
                    field.semantic.toUpperCase() !==
                    target
                ) {
                    continue;
                }

                if (
                    !isInsideRange(
                        field.range
                    )
                ) {
                    continue;
                }

                return {
                    name: field.name,
                    typeName: field.typeName,
                    semantic: field.semantic
                };
            }

            return undefined;
        };

        const searchHlslBlock = (
            hlslBlock: ShaderHlslBlockNode
        ) => {
            for (
                const declaration of
                hlslBlock.hlsl.declarations
            ) {
                if (
                    declaration.kind !==
                    "HlslStruct"
                ) {
                    continue;
                }

                if (
                    !isInsideRange(
                        declaration.range
                    )
                ) {
                    continue;
                }

                const field =
                    searchStruct(
                        declaration
                    );

                if (field) {
                    return field;
                }
            }

            return undefined;
        };

        // ShaderDocument直下のHLSL
        for (
            const hlslBlock of ast.hlslBlocks
        ) {
            const field =
                searchHlslBlock(
                    hlslBlock
                );

            if (field) {
                return field;
            }
        }

        // SubShader / Pass 内のHLSL
        for (
            const subShader of
            ast.subShaders
        ) {
            for (
                const hlslBlock of
                subShader.hlslBlocks
            ) {
                const field =
                    searchHlslBlock(
                        hlslBlock
                    );

                if (field) {
                    return field;
                }
            }

            for (
                const pass of
                subShader.passes
            ) {
                for (
                    const hlslBlock of
                    pass.hlslBlocks
                ) {
                    const field =
                        searchHlslBlock(
                            hlslBlock
                        );

                    if (field) {
                        return field;
                    }
                }
            }
        }

        return undefined;
    }

    private findIncludedSymbol(
        uri: string,
        name: string
    ): ShaderSymbol | null {
        const relatedUris =
            this.documentManager
                .getRelatedIncludeUris(uri);

        const matches =
            this.documentManager
                .getWorkspaceIndex()
                .findExact(name)
                .filter(
                    match =>
                        relatedUris.has(
                            match.uri
                        )
                );

        if (matches.length === 0) {
            return null;
        }

        /*
         * Prefer the most specific symbol kinds
         * that normally represent HLSL declarations.
         */
        const preferred =
            matches.find(
                match =>
                    match.symbol.kind ===
                    "function" ||
                    match.symbol.kind ===
                    "struct" ||
                    match.symbol.kind ===
                    "cbuffer" ||
                    match.symbol.kind ===
                    "macro"
            );

        return (
            preferred?.symbol ??
            matches[0].symbol
        );
    }
}