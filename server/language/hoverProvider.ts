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

export class HoverProvider {

    constructor(
        private readonly documentManager: DocumentManager,
        private readonly definitionProvider: DefinitionProvider
    ) {}

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

        /*
         * First, try the normal symbol resolver.
         *
         * This handles:
         * - structs
         * - functions
         * - globals
         * - cbuffer fields
         * - properties
         * - symbols from includes
         */
        let symbol =
            this.definitionProvider
                .resolveSymbolAtPosition(
                    uri,
                    position
                );

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
                `\\b([A-Za-z_][A-Za-z0-9_]*)\\s+` +
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
}