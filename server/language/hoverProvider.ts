import {
    Hover,
    MarkupContent,
    Position
} from "vscode-languageserver/node";

import {
    DocumentManager
} from "./documentManager";

import {
    WorkspaceIndex
} from "../symbol/workspaceIndex";

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

const symbol =
    this.definitionProvider
        .resolveSymbolAtPosition(
            uri,
            position
        );

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

    private getLineAtOffset(
        text: string,
        offset: number
    ): number {

        let line = 0;

        for (
            let i = 0;
            i < offset;
            i++
        ) {
            if (text[i] === "\n") {
                line++;
            }
        }

        return line;
    }
}