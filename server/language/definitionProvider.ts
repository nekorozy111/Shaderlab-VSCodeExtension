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
    ) { }

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
        if (this.isBuiltinHlslType(word) || this.isHlslSemantic(word)) {
            return null;
        }
        if (
            /*
            this.isAfterDot(
                document,
                position
            ) &&
            */
            this.isHlslSwizzle(word)
        ) {
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

        const visited =
            new Set<string>();

        const parsed =
            this.documentManager
                .getParsed(rootUri);

        if (!parsed) {
            return;
        }

        this.loadIncludedDocumentsRecursive(
            rootUri,
            parsed,
            visited
        );
    }

    private loadIncludedDocumentsRecursive(
        uri: string,
        parsed: ParsedDocument,
        visited: Set<string>,
        source?: string
    ): void {

        if (visited.has(uri)) {
            return;
        }

        visited.add(uri);

        console.log(
            `[DefinitionProvider] Traversing: ${uri}`
        );

        let includePaths: string[];

        if (
            parsed.languageId === "hlsl" &&
            source !== undefined
        ) {
            includePaths =
                this.collectRawHlslIncludes(
                    source
                );

            console.log(
                `[DefinitionProvider] Raw HLSL includes: ` +
                `${includePaths.length}`
            );
        } else {
            includePaths =
                this.collectIncludes(parsed);
        }

        console.log(
            `[DefinitionProvider] Includes in ${uri}: ` +
            `${includePaths.length}`
        );

        for (const includePath of includePaths) {

            console.log(
                `[DefinitionProvider] Resolving include: ` +
                `${includePath}`
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
                    `[DefinitionProvider] Include not resolved: ` +
                    `${includePath}`
                );

                continue;
            }

            console.log(
                `[DefinitionProvider] Include resolved: ` +
                `${includePath} -> ${resolved.uri}`
            );

            const externalDocument =
                this.documentManager
                    .ensureExternalDocument(
                        resolved.uri
                    );

            if (!externalDocument) {
                console.log(
                    `[DefinitionProvider] Failed to load external document: ` +
                    `${resolved.uri}`
                );

                continue;
            }

            console.log(
                `[DefinitionProvider] External document: ` +
                `${resolved.uri} -> ` +
                `${externalDocument.languageId}`
            );

            const externalSource =
                this.documentManager
                    .getProjectService()
                    .readFile(
                        resolved.resolvedPath
                    );

            this.loadIncludedDocumentsRecursive(
                resolved.uri,
                externalDocument,
                visited,
                externalSource
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
                `[DefinitionProvider] ShaderDocument subShaders=${parsed.ast.subShaders?.length ?? 0
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
            `[DefinitionProvider] collectIncludes result: ${result.length
            }`
        );

        console.log(
            `[DefinitionProvider] include paths: ${result.join(", ")
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
            `[DefinitionProvider] collectHlslIncludes: ast.kind=${ast.kind ?? "undefined"
            }`
        );

        console.log(
            `[DefinitionProvider] collectHlslIncludes: declarations=${Array.isArray(ast.declarations)
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
                `[DefinitionProvider] HLSL declaration: ${declaration.kind
                }`
            );

            if (
                declaration.kind ===
                "HlslFunction"
            ) {

                console.log(
                    `[DefinitionProvider] HLSL function: ${declaration.name
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
                    `[DefinitionProvider] HLSL include found: ${declaration.path
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
            `[DefinitionProvider] ShaderDocument.hlslBlocks=${ast.hlslBlocks?.length ?? 0
            }`
        );

        console.log(
            `[DefinitionProvider] ShaderDocument.subShaders=${ast.subShaders?.length ?? 0
            }`
        );

        if (Array.isArray(ast.hlslBlocks)) {

            for (const block of ast.hlslBlocks) {

                console.log(
                    `[DefinitionProvider] Root HLSL block: ${block?.blockType
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
                `[DefinitionProvider] SubShader hlslBlocks=${subShader?.hlslBlocks?.length ?? 0
                }`
            );

            console.log(
                `[DefinitionProvider] SubShader passes=${subShader?.passes?.length ?? 0
                }`
            );

            if (Array.isArray(subShader.hlslBlocks)) {

                for (
                    const block
                    of subShader.hlslBlocks
                ) {

                    console.log(
                        `[DefinitionProvider] SubShader HLSL block: ${block?.blockType
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
                    `[DefinitionProvider] Pass hlslBlocks=${pass?.hlslBlocks?.length ?? 0
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
                        `[DefinitionProvider] Pass HLSL block: ${block?.blockType
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

    private collectRawHlslIncludes(
        source: string
    ): string[] {

        const includes: string[] = [];

        const lines =
            source.split(/\r?\n/);

        for (const line of lines) {

            const match =
                line.match(
                    /^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/
                );

            if (!match) {
                continue;
            }

            const includePath =
                match[1] ?? match[2];

            if (!includePath) {
                continue;
            }

            includes.push(includePath);
        }

        return includes;
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

    private isBuiltinHlslType(
        word: string
    ): boolean {

        const builtinTypes = new Set([
            "void",

            "bool",
            "bool2",
            "bool3",
            "bool4",

            "int",
            "int2",
            "int3",
            "int4",

            "uint",
            "uint2",
            "uint3",
            "uint4",

            "half",
            "half2",
            "half3",
            "half4",

            "float",
            "float2",
            "float3",
            "float4",

            "double",
            "double2",
            "double3",
            "double4",

            "min16float",
            "min16float2",
            "min16float3",
            "min16float4",

            "min16int",
            "min16int2",
            "min16int3",
            "min16int4",

            "min16uint",
            "min16uint2",
            "min16uint3",
            "min16uint4"
        ]);

        return builtinTypes.has(word);
    }

    private isHlslSemantic(
        word: string
    ): boolean {

        const semantic =
            word.toUpperCase();

        if (
            /^TEXCOORD\d+$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^COLOR\d+$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^SV_[A-Z0-9_]+$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^POSITION\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^NORMAL\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^TANGENT\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^BINORMAL\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^BLENDINDICES\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^BLENDWEIGHT\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^PSIZE\d*$/.test(semantic)
        ) {
            return true;
        }

        if (
            /^FOG\d*$/.test(semantic)
        ) {
            return true;
        }

        return false;
    }

    private isHlslSwizzle(
        word: string
    ): boolean {

        if (
            word.length < 1 ||
            word.length > 4
        ) {
            return false;
        }

        const lower =
            word.toLowerCase();

        /*
         * HLSL vector swizzle
         *
         * xyzw
         * rgba
         * stpq
         */
        const swizzleCharacters =
            new Set([
                "x",
                "y",
                "z",
                "w",

                "r",
                "g",
                "b",
                "a",

                "s",
                "t",
                "p",
                "q"
            ]);

        for (
            const character of lower
        ) {
            if (
                !swizzleCharacters.has(
                    character
                )
            ) {
                return false;
            }
        }

        return true;
    }

    private isAfterDot(
        document: any,
        position: Position
    ): boolean {

        const line =
            document.getText({
                start: {
                    line: position.line,
                    character: 0
                },
                end: {
                    line: position.line,
                    character: position.character
                }
            });

        return /\.\s*$/.test(line);
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