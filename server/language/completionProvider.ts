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
    ) { }

    private readonly completionSource =
        "ShaderLab IntelliSense";


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

        if (
            this.isInsideComment(
                text,
                offset
            )
        ) {
            console.log(
                [CompletionProvider] +
                "Inside comment -> no completion"
            );

            return [];
        }

        const word =
            this.getWordBeforeCursor(
                text,
                offset
            );

        console.log(
            `[CompletionProvider] ` +
            `Request "${word}"`
        );

        /*
        
        * Member completion:
        *
        * object.
        * object.fi
        *
        * の形式なら、object の型を調べて
        * struct / cbuffer の field を候補にする。
          */
        const memberAccess =
            this.getMemberAccessAtPosition(
                text,
                offset
            );

        if (memberAccess) {
            console.log(
                `[CompletionProvider] ` +
                `Member request: ` +
                `${memberAccess.objectName}.` +
                `${memberAccess.prefix}`
            );

            return this.provideMemberCompletion(
                uri,
                memberAccess.objectName,
                memberAccess.prefix
            );
        }


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
                    `${this.completionSource} • ` +
                    `HLSL built-in type`

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
                    `${this.completionSource} • ` +
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

    private provideMemberCompletion(
        uri: string,
        objectName: string,
        prefix: string
    ): CompletionItem[] {

        const index =
            this.documentManager
                .getWorkspaceIndex();

        const document =
            this.documentManager.get(uri);

        if (!document) {
            return [];
        }

        let objectSymbol:
            ShaderSymbol | null = null;

        /*
        
        * 1. 現在のソースからローカル変数を探す。
        *
        * 例:
        *
        * A a;
        * B b;
        * Varyings output;
          */
        const localVariable =
            this.findLocalVariableDeclaration(
                document.getText(),
                objectName,
                document.offsetAt(
                    document.positionAt(
                        document.getText().length
                    )
                )
            );

        if (localVariable) {
            objectSymbol = {
                name: objectName,
                kind: "variable",
                location: {
                    uri,
                    range: localVariable.range,
                    selectionRange:
                        localVariable.range
                },
                typeName:
                    localVariable.typeName,
                children: []
            };


            console.log(
                `[CompletionProvider] ` +
                `Local variable found: ` +
                `${objectName} : ` +
                `${localVariable.typeName}`
            );


        }

        /*
        
        * 2. ローカル変数として見つからなければ
        * WorkspaceIndex を探す。
        *
        * input のような function parameter も
        * ここで取得できる。
          */
        if (!objectSymbol) {

            
            const objectMatches =
                index.findExact(
                    objectName
                );

            /*
          
            * 現在のファイルを優先。
              */
            for (
                const match
                of objectMatches
            ) {
                if (
                    match.uri === uri &&
                    (
                        match.symbol.kind ===
                        "variable" ||
                        match.symbol.kind ===
                        "parameter"
                    )
                ) {
                    objectSymbol =
                        match.symbol;
                    break;
                }
            }

            /*
          
            * 現在のファイルに無ければ
            * Workspace 全体から探す。
              */
            if (!objectSymbol) {
                for (
                    const match
                    of objectMatches
                ) {
                    if (
                        match.symbol.kind ===
                        "variable" ||
                        match.symbol.kind ===
                        "parameter"
                    ) {
                        objectSymbol =
                            match.symbol;
                        break;
                    }
                }
            }
        }

        if (!objectSymbol) {
            console.log(
                `[CompletionProvider] ` +
                `Object not found: ${objectName}`
            );


            return [];

        }

        const typeName =
            objectSymbol.typeName;

        if (!typeName) {
            console.log(
                `[CompletionProvider] ` +
                `Object has no type: ${objectName}`
            );

            return [];

        }


        console.log(
            `[CompletionProvider] ` +
            `Object "${objectName}" ` +
            `type="${typeName}"`
        );

        /*
         * 型名から struct / cbuffer を探す。
         */
        const typeMatches =
            index.findExact(
                typeName
            );

        const items:
            CompletionItem[] = [];

        const seen =
            new Set<string>();

        for (
            const match
            of typeMatches
        ) {
            const symbol =
                match.symbol;

            if (
                symbol.kind !== "struct" &&
                symbol.kind !== "cbuffer"
            ) {
                continue;
            }

            /*
             * struct / cbuffer の children が
             * field になっている。
             */
            for (
                const field
                of symbol.children
            ) {
                if (
                    field.kind !== "field"
                ) {
                    continue;
                }

                if (
                    prefix.length > 0 &&
                    !field.name
                        .toLowerCase()
                        .startsWith(
                            prefix.toLowerCase()
                        )
                ) {
                    continue;
                }

                if (
                    seen.has(field.name)
                ) {
                    continue;
                }

                seen.add(field.name);

                items.push({
                    label:
                        field.name,

                    kind:
                        CompletionItemKind.Field,

                    detail:
                        field.typeName
                            ? `${this.completionSource} • ` +
                            `field: ${field.typeName}`
                            : `${this.completionSource} • ` +
                            `HLSL field`

                });
            }
        }

        console.log(
            `[CompletionProvider] ` +
            `Member candidates: ${items.length}`
        );

        return items;

    }


    private findLocalVariableDeclaration(
        text: string,
        variableName: string,
        offset: number
    ): {
        typeName: string;
        range: {
            start: {
                offset: number;
                line: number;
                character: number;
            };
            end: {
                offset: number;
                line: number;
                character: number;
            };
        };
    } | null {


        const source =
            text.substring(
                0,
                offset
            );

        /*
         * コメントを除去して検索する。
         *
         * 改行は維持するので、
         * offset の対応関係を壊さない。
         */
        const cleanSource =
            source.replace(
                /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
                match =>
                    match.replace(
                        /[^\r\n]/g,
                        " "
                    )
            );

        /*
         * 例:
         *
         * A a;
         * B b;
         * Varyings output;
         *
         * を検出する。
         *
         * 型名は struct 名などの識別子を想定。
         */
        const escapedName =
            variableName.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );

        const pattern =
            new RegExp(
                `\\b([A-Za-z_][A-Za-z0-9_]*)\\s+` +
                `${escapedName}\\s*` +
                `(?=;|=|\\[|,)`,
                "g"
            );

        let lastMatch:
            RegExpExecArray | null = null;

        let match:
            RegExpExecArray | null;

        while (
            (match =
                pattern.exec(
                    cleanSource
                )) !== null
        ) {
            lastMatch = match;
        }

        if (!lastMatch) {
            return null;
        }

        const typeName =
            lastMatch[1];

        const startOffset =
            lastMatch.index;

        const endOffset =
            startOffset +
            lastMatch[0].length;

        return {
            typeName,
            range: {
                start:
                    this.positionFromOffset(
                        text,
                        startOffset
                    ),
                end:
                    this.positionFromOffset(
                        text,
                        endOffset
                    )
            }
        };

    }

    private positionFromOffset(
        text: string,
        offset: number
    ): {
        offset: number;
        line: number;
        character: number;
    } {

        let line = 0;
        let character = 0;

        for (
            let i = 0;
            i < offset;
            i++
        ) {
            if (
                text[i] === "\n"
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


    private isInsideComment(
        text: string,
        offset: number
    ): boolean {

        const safeOffset =
            Math.max(
                0,
                Math.min(
                    offset,
                    text.length
                )
            );

        let inBlockComment = false;

        for (
            let i = 0;
            i < safeOffset;
            i++
        ) {
            const current =
                text[i];

            const next =
                i + 1 < safeOffset
                    ? text[i + 1]
                    : "";

            /*
             * Block comment:
             *
             * /*
             *    ...
             * *\/
             */
            if (
                !inBlockComment &&
                current === "/" &&
                next === "*"
            ) {
                inBlockComment = true;
                i++;
                continue;
            }

            if (
                inBlockComment &&
                current === "*" &&
                next === "/"
            ) {
                inBlockComment = false;
                i++;
                continue;
            }

            /*
             * Line comment:
             *
             * // ...
             *
             * 改行までコメント。
             */
            if (
                !inBlockComment &&
                current === "/" &&
                next === "/"
            ) {
                const lineEnd =
                    text.indexOf(
                        "\n",
                        i + 2
                    );

                if (
                    lineEnd === -1 ||
                    safeOffset <= lineEnd
                ) {
                    return true;
                }

                i =
                    lineEnd - 1;
            }
        }

        return inBlockComment;

    }

    private getMemberAccessAtPosition(
        text: string,
        offset: number
    ): {
        objectName: string;
        prefix: string;
    } | null {


        let cursor = Math.max(
            0,
            Math.min(
                offset,
                text.length
            )
        );

        /*
         * カーソル直前の識別子を取得。
         *
         * 例:
         *
         * surface.po
         *
         *           ↑ cursor
         *
         * prefix = "po"
         */
        let prefixStart = cursor;

        while (
            prefixStart > 0 &&
            /[A-Za-z0-9_]/.test(
                text[prefixStart - 1]
            )
        ) {
            prefixStart--;
        }

        const prefix =
            text.substring(
                prefixStart,
                cursor
            );

        /*
         * prefix の直前が "." か確認。
         */
        let dotPosition =
            prefixStart - 1;

        while (
            dotPosition >= 0 &&
            /\s/.test(
                text[dotPosition]
            )
        ) {
            dotPosition--;
        }

        if (
            dotPosition < 0 ||
            text[dotPosition] !== "."
        ) {
            return null;
        }

        /*
         * "." の左側にある object 名を取得。
         */
        let objectEnd =
            dotPosition;

        while (
            objectEnd > 0 &&
            /\s/.test(
                text[objectEnd - 1]
            )
        ) {
            objectEnd--;
        }

        let objectStart =
            objectEnd;

        while (
            objectStart > 0 &&
            /[A-Za-z0-9_]/.test(
                text[objectStart - 1]
            )
        ) {
            objectStart--;
        }

        if (
            objectStart === objectEnd
        ) {
            return null;
        }

        const objectName =
            text.substring(
                objectStart,
                objectEnd
            );

        return {
            objectName,
            prefix
        };

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
