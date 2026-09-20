import {
    CompletionItem,
    CompletionItemKind,
    Position
} from "vscode-languageserver/node";

import {
    TextDocument
} from "vscode-languageserver-textdocument";

import {
    DocumentManager
} from "./documentManager";

import {
    ShaderSymbol
} from "../symbol/symbol";

export class CompletionProvider {
    public constructor(
        private readonly documentManager: DocumentManager
    ) {}

    public provideCompletion(
        uri: string,
        position: Position
    ): CompletionItem[] {
        const document =
            this.documentManager.get(uri);

        if (!document) {
            return [];
        }

        const text =
            document.getText();

        const offset =
            document.offsetAt(position);

        const word =
            this.getWordBeforeCursor(
                text,
                offset
            );

        console.log(
            `[CompletionProvider] ` +
            `Request "${word}"`
        );

        const items:
            CompletionItem[] = [];

        const seen =
            new Set<string>();

        /*
         * 1. HLSL built-in types
         */
        for (
            const typeName
            of this.getBuiltinTypes()
        ) {
            if (
                word.length > 0 &&
                !typeName
                    .toLowerCase()
                    .startsWith(
                        word.toLowerCase()
                    )
            ) {
                continue;
            }

            if (
                seen.has(typeName)
            ) {
                continue;
            }

            seen.add(typeName);

            items.push({
                label: typeName,
                kind:
                    CompletionItemKind.Keyword,
                detail:
                    "HLSL built-in type"
            });
        }

        /*
         * 2. Symbols from the workspace.
         *
         * Prefer symbols from the current file.
         */
        const matches =
            this.documentManager
                .getWorkspaceIndex()
                .findPrefix(word);

        const currentUri =
            uri;

        const currentFileMatches:
            typeof matches = [];

        const otherMatches:
            typeof matches = [];

        for (
            const match
            of matches
        ) {
            if (
                match.uri ===
                currentUri
            ) {
                currentFileMatches.push(
                    match
                );
            } else {
                otherMatches.push(
                    match
                );
            }
        }

        /*
         * Current file first.
         */
        this.addSymbolCompletions(
            currentFileMatches,
            items,
            seen
        );

        /*
         * Then other workspace symbols.
         */
        this.addSymbolCompletions(
            otherMatches,
            items,
            seen
        );

        return items;
    }

    private addSymbolCompletions(
        matches: Array<{
            symbol: ShaderSymbol;
            uri: string;
        }>,
        items: CompletionItem[],
        seen: Set<string>
    ): void {
        for (
            const match
            of matches
        ) {
            const symbol =
                match.symbol;

            if (
                seen.has(symbol.name)
            ) {
                continue;
            }

            seen.add(symbol.name);

            items.push({
                label:
                    symbol.name,

                kind:
                    this.getCompletionKind(
                        symbol
                    ),

                detail:
                    this.getSymbolDetail(
                        symbol
                    )
            });
        }
    }

    private getCompletionKind(
        symbol: ShaderSymbol
    ): CompletionItemKind {
        switch (symbol.kind) {
            case "shader":
                return CompletionItemKind.Class;

            case "property":
                return CompletionItemKind.Property;

            case "struct":
                return CompletionItemKind.Struct;

            case "field":
                return CompletionItemKind.Field;

            case "function":
                return CompletionItemKind.Function;

            case "parameter":
                return CompletionItemKind.Variable;

            case "variable":
                return CompletionItemKind.Variable;

            case "cbuffer":
                return CompletionItemKind.Struct;

            case "macro":
                return CompletionItemKind.Constant;

            case "include":
                return CompletionItemKind.File;

            case "subShader":
            case "pass":
                return CompletionItemKind.Module;

            default:
                return CompletionItemKind.Text;
        }
    }

    private getSymbolDetail(
        symbol: ShaderSymbol
    ): string {
        switch (symbol.kind) {
            case "property":
                return "ShaderLab Property";

            case "cbuffer":
                return "HLSL CBuffer";

            case "struct":
                return "HLSL struct";

            case "field":
                if (symbol.typeName) {
                    return `field: ${symbol.typeName}`;
                }
                return "HLSL field";

            case "function":
                if (symbol.returnType) {
                    return `function: ${symbol.returnType}`;
                }
                return "HLSL function";

            case "parameter":
                if (symbol.typeName) {
                    return `parameter: ${symbol.typeName}`;
                }
                return "HLSL parameter";

            case "variable":
                if (symbol.typeName) {
                    return `variable: ${symbol.typeName}`;
                }
                return "HLSL variable";

            default:
                return symbol.kind;
        }
    }

    private getWordBeforeCursor(
        text: string,
        offset: number
    ): string {
        let start =
            Math.max(
                0,
                Math.min(
                    offset,
                    text.length
                )
            );

        while (
            start > 0 &&
            /[A-Za-z0-9_]/.test(
                text[start - 1]
            )
        ) {
            start--;
        }

        return text.substring(
            start,
            offset
        );
    }

    private getBuiltinTypes():
        string[] {
        return [
            "bool",
            "bool1",
            "bool2",
            "bool3",
            "bool4",

            "int",
            "int1",
            "int2",
            "int3",
            "int4",

            "uint",
            "uint1",
            "uint2",
            "uint3",
            "uint4",

            "half",
            "half1",
            "half2",
            "half3",
            "half4",

            "float",
            "float1",
            "float2",
            "float3",
            "float4",

            "double",
            "double1",
            "double2",
            "double3",
            "double4",

            "min16float",
            "min16float2",
            "min16float3",
            "min16float4",

            "min10float",
            "min10float2",
            "min10float3",
            "min10float4",

            "float2x2",
            "float2x3",
            "float2x4",
            "float3x2",
            "float3x3",
            "float3x4",
            "float4x2",
            "float4x3",
            "float4x4"
        ];
    }
}
