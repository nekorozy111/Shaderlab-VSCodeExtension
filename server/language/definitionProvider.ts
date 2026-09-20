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
            console.log(
                `[DefinitionProvider] Document not found: ${uri}`
            );
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
            console.log(
                `[DefinitionProvider] No word at position`
            );
            return null;
        }

        console.log(
            `[DefinitionProvider] Request "${word}" in ${uri}`
        );

        /*
         * ---------------------------------------------------------
         * 1. 現在のファイル
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

        console.log(
            `[DefinitionProvider] Local matches: ${localMatches.length}`
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
         * 2. include を再帰的にロード
         * ---------------------------------------------------------
         */

        console.log(
            `[DefinitionProvider] Loading includes from ${uri}`
        );

        this.loadIncludedDocuments(uri);

        console.log(
            `[DefinitionProvider] Finished loading includes`
        );

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

        for (const match of matches) {

            console.log(
                `[DefinitionProvider] Match: ${match.symbol.kind} ${match.symbol.name} @ ${match.uri}`
            );
        }

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

        console.log(
            `[DefinitionProvider] loadIncludedDocuments(${rootUri})`
        );

        const visited =
            new Set<string>();

        const rootDocument =
            this.documentManager
                .getWorkspaceIndex()
                .getDocument(rootUri);

        if (!rootDocument) {

            console.log(
                `[DefinitionProvider] Root parsed document not found: ${rootUri}`
            );

            return;
        }

        this.loadIncludedDocumentsRecursive(
            rootUri,
            rootDocument,
            visited
        );

        console.log(
            `[DefinitionProvider] Include traversal finished. Visited=${visited.size}`
        );
    }

    private loadIncludedDocumentsRecursive(
        uri: string,
        parsed: ParsedDocument,
        visited: Set<string>
    ): void {

        console.log(
            `[DefinitionProvider] Traversing: ${uri}`
        );

        if (visited.has(uri)) {

            console.log(
                `[DefinitionProvider] Already visited: ${uri}`
            );

            return;
        }

        visited.add(uri);

        console.log(
            `[DefinitionProvider] Parsed document found: ${uri} (${parsed.languageId})`
        );

        /*
         * ---------------------------------------------------------
         * 現在のファイルから include を収集
         * ---------------------------------------------------------
         */

        const includePaths =
            this.collectIncludes(parsed);

        console.log(
            `[DefinitionProvider] Includes in ${uri}: ${includePaths.length}`
        );

        /*
         * ---------------------------------------------------------
         * include を1つずつ解決
         * ---------------------------------------------------------
         */

        for (const includePath of includePaths) {

            console.log(
                `[DefinitionProvider] Resolving include: ${includePath} from ${uri}`
            );

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
                `[DefinitionProvider] Include resolved: ${includePath} -> ${resolved.uri}`
            );

            /*
             * -----------------------------------------------------
             * 外部ファイルをParse
             * -----------------------------------------------------
             */

            const externalDocument =
                this.documentManager
                    .ensureExternalDocument(
                        resolved.uri
                    );

const resolvedText = this.documentManager
    .getProjectService()
    .readFile(resolved.resolvedPath);

console.log(
    `[DefinitionProvider] Resolved file text length: ${
        resolvedText?.length ?? 0
    }`
);

if (
    resolvedText &&
    resolvedText.includes("SpaceTransforms.hlsl")
) {
    console.log(
        "[DefinitionProvider] ★ RAW FILE contains SpaceTransforms.hlsl"
    );
}

            console.log(
                `[DefinitionProvider] External document: ${resolved.uri} -> ${
                    externalDocument
                        ? externalDocument.languageId
                        : "FAILED"
                }`
            );

            if (!externalDocument) {
                continue;
            }

            /*
             * -----------------------------------------------------
             * シンボル確認
             * -----------------------------------------------------
             */

            const externalSymbols =
                this.documentManager
                    .getWorkspaceIndex()
                    .getDocumentSymbols(
                        resolved.uri
                    );

            console.log(
                `[DefinitionProvider] External symbols: ${resolved.uri} -> ${externalSymbols.length}`
            );

            /*
             * -----------------------------------------------------
             * ★ 重要
             *
             * ensureExternalDocument() で取得した
             * ParsedDocument をそのまま次の再帰へ渡す。
             *
             * WorkspaceIndexから再取得しない。
             * -----------------------------------------------------
             */

            const externalIncludes =
                this.collectIncludes(
                    externalDocument
                );
console.log(
    `[DefinitionProvider] Parsed AST includes: ${
        externalIncludes.join(", ")
    }`
);
if (
    resolvedText &&
    resolvedText.includes("SpaceTransforms.hlsl")
) {
    console.log(
        "[DefinitionProvider] ===== Input.hlsl include inspection ====="
    );

    const lines = resolvedText.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        if (
            lines[i].includes("#include") ||
            lines[i].includes("SpaceTransforms.hlsl")
        ) {
            console.log(
                `[DefinitionProvider] RAW ${i + 1}: ${lines[i]}`
            );
        }
    }

    console.log(
        "[DefinitionProvider] ===== End Input.hlsl inspection ====="
    );
}
            console.log(
                `[DefinitionProvider] External includes: ${
                    externalIncludes.join(", ")
                }`
            );

            /*
             * -----------------------------------------------------
             * 再帰
             * -----------------------------------------------------
             */

            console.log(
                `[DefinitionProvider] Recursing into: ${resolved.uri}`
            );

            this.loadIncludedDocumentsRecursive(
                resolved.uri,
                externalDocument,
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
        parsed: ParsedDocument
    ): string[] {

        const result: string[] = [];

        console.log(
            `[DefinitionProvider] collectIncludes: uri=${parsed.uri}`
        );

        console.log(
            `[DefinitionProvider] collectIncludes: ast.kind=${parsed.ast.kind}`
        );

        if (parsed.ast.kind === "ShaderDocument") {

            console.log(
                `[DefinitionProvider] ShaderDocument subShaders=${
                    parsed.ast.subShaders?.length ?? 0
                }`
            );

            this.collectShaderLabIncludes(
                parsed.ast,
                result
            );

        } else {

            this.collectHlslIncludes(
                parsed.ast,
                result
            );
        }

        console.log(
            `[DefinitionProvider] collectIncludes result: ${
                result.length
            }`
        );

        console.log(
            `[DefinitionProvider] include paths: ${
                result.join(", ")
            }`
        );

        return result;
    }

    private collectHlslIncludes(
        ast: any,
        result: string[]
    ): void {

        if (!ast) {
            return;
        }

        console.log(
            `[DefinitionProvider] collectHlslIncludes: ast.kind=${
                ast.kind ?? "undefined"
            }`
        );

        console.log(
            `[DefinitionProvider] collectHlslIncludes: declarations=${
                Array.isArray(ast.declarations)
                    ? ast.declarations.length
                    : 0
            }`
        );

        if (!Array.isArray(ast.declarations)) {
            return;
        }

        for (const declaration of ast.declarations) {

            if (!declaration) {
                continue;
            }

            console.log(
                `[DefinitionProvider] HLSL declaration: ${
                    declaration.kind
                }`
            );

            if (
                declaration.kind ===
                "HlslFunction"
            ) {

                console.log(
                    `[DefinitionProvider] HLSL function: ${
                        declaration.name
                    }`
                );

                if (
                    declaration.name ===
                    "TransformObjectToHClip"
                ) {

                    console.log(
                        "[DefinitionProvider] ★ TransformObjectToHClip FOUND"
                    );
                }
            }

            if (
                declaration.kind ===
                "HlslInclude"
            ) {

                console.log(
                    `[DefinitionProvider] HLSL include found: ${
                        declaration.path
                    }`
                );

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
    }

    private collectShaderLabIncludes(
        ast: any,
        result: string[]
    ): void {

        if (!ast) {
            return;
        }

        console.log(
            `[DefinitionProvider] ShaderDocument.hlslBlocks=${
                ast.hlslBlocks?.length ?? 0
            }`
        );

        console.log(
            `[DefinitionProvider] ShaderDocument.subShaders=${
                ast.subShaders?.length ?? 0
            }`
        );

        if (Array.isArray(ast.hlslBlocks)) {

            for (const block of ast.hlslBlocks) {

                console.log(
                    `[DefinitionProvider] Root HLSL block: ${
                        block?.blockType
                    }`
                );

                this.collectHlslIncludes(
                    block?.hlsl,
                    result
                );
            }
        }

        if (!Array.isArray(ast.subShaders)) {
            return;
        }

        for (const subShader of ast.subShaders) {

            console.log(
                `[DefinitionProvider] SubShader found`
            );

            console.log(
                `[DefinitionProvider] SubShader hlslBlocks=${
                    subShader?.hlslBlocks?.length ?? 0
                }`
            );

            console.log(
                `[DefinitionProvider] SubShader passes=${
                    subShader?.passes?.length ?? 0
                }`
            );

            if (Array.isArray(subShader.hlslBlocks)) {

                for (
                    const block
                    of subShader.hlslBlocks
                ) {

                    console.log(
                        `[DefinitionProvider] SubShader HLSL block: ${
                            block?.blockType
                        }`
                    );

                    this.collectHlslIncludes(
                        block?.hlsl,
                        result
                    );
                }
            }

            if (!Array.isArray(subShader.passes)) {
                continue;
            }

            for (const pass of subShader.passes) {

                console.log(
                    `[DefinitionProvider] Pass found`
                );

                console.log(
                    `[DefinitionProvider] Pass hlslBlocks=${
                        pass?.hlslBlocks?.length ?? 0
                    }`
                );

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

                    console.log(
                        `[DefinitionProvider] Pass HLSL block: ${
                            block?.blockType
                        }`
                    );

                    this.collectHlslIncludes(
                        block?.hlsl,
                        result
                    );
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