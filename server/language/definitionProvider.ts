import {
    Location,
    Position
} from "vscode-languageserver/node";

import { DocumentManager } from "./documentManager";
import { ShaderSymbol } from "../symbol/symbol";
import { ParsedDocument } from "../parser/ast";

export class DefinitionProvider {

    constructor(
        private readonly documentManager: DocumentManager
    ) {}

    public provideDefinition(
        uri: string,
        position: Position
    ): Location | null {

        const document =
            this.documentManager.get(uri);

        if (!document) {
            return null;
        }

        const offset =
            document.offsetAt(position);

        const word =
            this.getWordAtPosition(
                document.getText(),
                offset
            );

        if (!word) {
            return null;
        }

        console.log(
            `[DefinitionProvider] Request "${word}" in ${uri}`
        );

        /*
         * ---------------------------------------------------------
         * 1. 現在のファイルを検索
         * ---------------------------------------------------------
         */

        const localMatches =
            this.documentManager
                .getWorkspaceIndex()
                .findExact(word)
                .filter(
                    match =>
                        match.uri === uri
                );

        if (localMatches.length > 0) {

            const localSymbols =
                localMatches.map(
                    match => match.symbol
                );

            const selected =
                this.selectBestDefinition(
                    uri,
                    localSymbols
                );

            if (selected) {

                console.log(
                    `[DefinitionProvider] Local -> ${selected.kind} ${selected.name}`
                );

                return this.toLocation(
                    selected
                );
            }
        }

        /*
         * ---------------------------------------------------------
         * 2. #include 先を読み込む
         * ---------------------------------------------------------
         */

        this.loadIncludedDocuments(uri);

        /*
         * ---------------------------------------------------------
         * 3. Workspace 全体から検索
         * ---------------------------------------------------------
         */

        const matches =
            this.documentManager
                .getWorkspaceIndex()
                .findExact(word);

        console.log(
            `[DefinitionProvider] Global search "${word}" -> ${matches.length}`
        );

        if (matches.length === 0) {
            return null;
        }

        const symbols =
            matches.map(
                match => match.symbol
            );

        const selected =
            this.selectBestDefinition(
                uri,
                symbols
            );

        if (!selected) {
            return null;
        }

        console.log(
            `[DefinitionProvider] Global -> ${selected.kind} ${selected.name} @ ${selected.location.uri}`
        );

        return this.toLocation(
            selected
        );
    }

    /*
     * -------------------------------------------------------------
     * Include の再帰読み込み
     * -------------------------------------------------------------
     */

    private loadIncludedDocuments(
        rootUri: string
    ): void {

        const visited =
            new Set<string>();

        this.loadIncludedDocumentsRecursive(
            rootUri,
            visited
        );
    }

    private loadIncludedDocumentsRecursive(
        uri: string,
        visited: Set<string>
    ): void {

        if (visited.has(uri)) {
            return;
        }

        visited.add(uri);

        const parsed =
            this.documentManager
                .getWorkspaceIndex()
                .getDocument(uri);

        if (!parsed) {
            return;
        }

        const includePaths =
            this.collectIncludes(
                parsed
            );

        for (
            const includePath
            of includePaths
        ) {

            const resolved =
                this.documentManager
                    .getProjectService()
                    .resolveInclude(
                        includePath,
                        uri
                    );

            if (!resolved) {

                console.log(
                    `[DefinitionProvider] Include not resolved: ${includePath}`
                );

                continue;
            }

            console.log(
                `[DefinitionProvider] Include: ${includePath} -> ${resolved.uri}`
            );

            /*
             * External HLSL を
             *
             * Parser
             *   ↓
             * SymbolExtractor
             *   ↓
             * WorkspaceIndex
             *
             * まで登録する。
             */
            this.documentManager
                .ensureExternalDocument(
                    resolved.uri
                );

            /*
             * include 先のさらに先も探索する。
             */
            this.loadIncludedDocumentsRecursive(
                resolved.uri,
                visited
            );
        }
    }

    /*
     * -------------------------------------------------------------
     * Include の収集
     * -------------------------------------------------------------
     */

    private collectIncludes(
        document: ParsedDocument
    ): string[] {

        const result: string[] = [];

        if (
            document.languageId === "hlsl"
        ) {

            this.collectHlslIncludes(
                document.ast,
                result
            );

            return result;
        }

        if (
            document.languageId === "shaderlab"
        ) {

            this.collectShaderLabIncludes(
                document.ast,
                result
            );
        }

        return result;
    }

    private collectHlslIncludes(
        ast: any,
        result: string[]
    ): void {

        if (!ast) {
            return;
        }

        if (
            !Array.isArray(
                ast.declarations
            )
        ) {
            return;
        }

        for (
            const declaration
            of ast.declarations
        ) {

            if (
                declaration.kind !== "include"
            ) {
                continue;
            }

            if (
                typeof declaration.path ===
                "string"
            ) {

                result.push(
                    declaration.path
                );
            }
        }
    }

    private collectShaderLabIncludes(
        ast: any,
        result: string[]
    ): void {

        if (!ast) {
            return;
        }

        /*
         * ShaderLab トップレベルの HLSL
         */
        if (
            Array.isArray(
                ast.hlslBlocks
            )
        ) {

            for (
                const block
                of ast.hlslBlocks
            ) {

                this.collectHlslIncludes(
                    block.hlsl,
                    result
                );
            }
        }

        /*
         * SubShader
         */
        if (
            Array.isArray(
                ast.subShaders
            )
        ) {

            for (
                const subShader
                of ast.subShaders
            ) {

                /*
                 * SubShader直下のHLSL
                 */
                if (
                    Array.isArray(
                        subShader.hlslBlocks
                    )
                ) {

                    for (
                        const block
                        of subShader.hlslBlocks
                    ) {

                        this.collectHlslIncludes(
                            block.hlsl,
                            result
                        );
                    }
                }

                /*
                 * Pass
                 */
                if (
                    !Array.isArray(
                        subShader.passes
                    )
                ) {
                    continue;
                }

                for (
                    const pass
                    of subShader.passes
                ) {

                    if (
                        !Array.isArray(
                            pass.hlslBlocks
                        )
                    ) {
                        continue;
                    }

                    for (
                        const block
                        of pass.hlslBlocks
                    ) {

                        this.collectHlslIncludes(
                            block.hlsl,
                            result
                        );
                    }
                }
            }
        }
    }

    /*
     * -------------------------------------------------------------
     * Definition 選択
     * -------------------------------------------------------------
     */

    private selectBestDefinition(
        currentUri: string,
        symbols: ShaderSymbol[]
    ): ShaderSymbol | null {

        if (symbols.length === 0) {
            return null;
        }

        /*
         * 現在のファイル
         */
        const localSymbols =
            symbols.filter(
                symbol =>
                    symbol.location.uri ===
                    currentUri
            );

        if (localSymbols.length > 0) {

            const localPriority:
                ShaderSymbol["kind"][] = [

                "parameter",
                "variable",
                "field",

                "function",
                "struct",
                "cbuffer",

                "property",

                "pass",
                "subShader",
                "shader",

                "macro",
                "include"
            ];

            const selected =
                this.selectByPriority(
                    localSymbols,
                    localPriority
                );

            if (selected) {
                return selected;
            }
        }

        /*
         * 別ファイル
         */
        const externalPriority:
            ShaderSymbol["kind"][] = [

            "function",
            "struct",
            "field",
            "variable",
            "cbuffer",
            "macro",

            "property",
            "parameter",

            "include"
        ];

        return this.selectByPriority(
            symbols,
            externalPriority
        );
    }

    private selectByPriority(
        symbols: ShaderSymbol[],
        priority: ShaderSymbol["kind"][]
    ): ShaderSymbol | null {

        for (
            const kind
            of priority
        ) {

            const found =
                symbols.find(
                    symbol =>
                        symbol.kind === kind
                );

            if (found) {
                return found;
            }
        }

        return symbols[0] ?? null;
    }

    /*
     * -------------------------------------------------------------
     * ShaderSymbol → LSP Location
     * -------------------------------------------------------------
     */

    private toLocation(
        symbol: ShaderSymbol
    ): Location {

        return {
            uri:
                symbol.location.uri,

            range: {
                start: {
                    line:
                        symbol.location
                            .selectionRange
                            .start.line,

                    character:
                        symbol.location
                            .selectionRange
                            .start.character
                },

                end: {
                    line:
                        symbol.location
                            .selectionRange
                            .end.line,

                    character:
                        symbol.location
                            .selectionRange
                            .end.character
                }
            }
        };
    }

    /*
     * -------------------------------------------------------------
     * カーソル位置の identifier を取得
     * -------------------------------------------------------------
     */

    private getWordAtPosition(
        text: string,
        offset: number
    ): string | null {

        if (text.length === 0) {
            return null;
        }

        offset =
            Math.max(
                0,
                Math.min(
                    offset,
                    text.length
                )
            );

        let start = offset;
        let end = offset;

        const isIdentifierCharacter =
            (char: string): boolean => {

                return /[A-Za-z0-9_]/.test(
                    char
                );
            };

        while (
            start > 0 &&
            isIdentifierCharacter(
                text[start - 1]
            )
        ) {
            start--;
        }

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