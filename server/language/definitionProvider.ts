import {
    Location,
    Position
} from "vscode-languageserver/node";

import { DocumentManager } from "./documentManager";
import { ShaderSymbol } from "../symbol/symbol";
import { ParsedDocument } from "../parser/ast";
import { TextDocument } from "vscode-languageserver-textdocument";

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

        const text =
            document.getText();

        const offset =
            document.offsetAt(position);

        const word =
            this.getWordAtPosition(
                text,
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
         * 1. Built-in type / semantic
         * ---------------------------------------------------------
         */
console.log(
    `[DefinitionProvider] builtin=${this.isBuiltinHlslType(word)} semantic=${this.isHlslSemantic(word)} word="${word}"`
);
        if (
            this.isBuiltinHlslType(word) ||
            this.isHlslSemantic(word)
        ) {
            return null;
        }

        /*
         * ---------------------------------------------------------
         * 2. Member access / swizzle
         *
         * color.rgb
         * data.position
         * a.position
         * ---------------------------------------------------------
         */

        const memberAccess =
            this.getMemberAccessAtPosition(
                text,
                offset
            );

        if (memberAccess) {

            console.log(
                `[DefinitionProvider] Member access: ` +
                `${memberAccess.objectName}.${memberAccess.memberName}`
            );

            /*
             * SwizzleならDefinition検索しない。
             */

            if (
                this.isHlslSwizzle(
                    memberAccess.memberName
                )
            ) {

                console.log(
                    `[DefinitionProvider] Swizzle ignored: ` +
                    `${memberAccess.memberName}`
                );

                return null;
            }

            /*
             * -----------------------------------------------------
             * まず現在のファイルのローカル変数を
             * ソースから探す。
             * -----------------------------------------------------
             */

            const localObject =
                this.findVariableDeclarationInSource(
                    document,
                    memberAccess.objectName,
                    offset
                );

            if (localObject) {

                console.log(
                    `[DefinitionProvider] Local source variable: ` +
                    `${localObject.name} : ${localObject.typeName}`
                );

                const member =
                    this.findStructField(
                        localObject.typeName,
                        memberAccess.memberName
                    );

                if (member) {

                    console.log(
                        `[DefinitionProvider] Local member -> ` +
                        `${member.location.uri} ` +
                        `${member.name}`
                    );

                    return this.toLocation(
                        member
                    );
                }
            }

            /*
             * -----------------------------------------------------
             * WorkspaceIndex に登録されている variable / parameter
             * も調べる。
             * -----------------------------------------------------
             */

            const objectMatches =
                this.documentManager
                    .getWorkspaceIndex()
                    .findExact(
                        memberAccess.objectName
                    )
                    .filter(
                        match =>
                            match.symbol.kind === "variable" ||
                            match.symbol.kind === "parameter"
                    );

            if (objectMatches.length > 0) {

                const objectSymbol =
                    this.selectBestObjectSymbol(
                        uri,
                        offset,
                        objectMatches.map(
                            match => match.symbol
                        )
                    );

                if (objectSymbol) {

                    console.log(
                        `[DefinitionProvider] Indexed object: ` +
                        `${objectSymbol.name} : ` +
                        `${objectSymbol.typeName ?? "<unknown>"}`
                    );

                    if (
                        objectSymbol.typeName
                    ) {

                        const member =
                            this.findStructField(
                                objectSymbol.typeName,
                                memberAccess.memberName
                            );

                        if (member) {

                            console.log(
                                `[DefinitionProvider] Indexed member -> ` +
                                `${member.location.uri} ` +
                                `${member.name}`
                            );

                            return this.toLocation(
                                member
                            );
                        }
                    }
                }
            }

            /*
             * -----------------------------------------------------
             * includeを読み込んでからもう一度検索。
             * -----------------------------------------------------
             */

            this.loadIncludedDocuments(uri);

            /*
             * include先のstruct / fieldを検索
             */

            if (localObject) {

                const member =
                    this.findStructField(
                        localObject.typeName,
                        memberAccess.memberName
                    );

                if (member) {
                    return this.toLocation(
                        member
                    );
                }
            }

            /*
             * WorkspaceIndexのobjectを再検索
             */

            const externalObjectMatches =
                this.documentManager
                    .getWorkspaceIndex()
                    .findExact(
                        memberAccess.objectName
                    )
                    .filter(
                        match =>
                            match.symbol.kind === "variable" ||
                            match.symbol.kind === "parameter"
                    );

            if (
                externalObjectMatches.length > 0
            ) {

                const objectSymbol =
                    this.selectBestObjectSymbol(
                        uri,
                        offset,
                        externalObjectMatches.map(
                            match => match.symbol
                        )
                    );

                if (
                    objectSymbol &&
                    objectSymbol.typeName
                ) {

                    const member =
                        this.findStructField(
                            objectSymbol.typeName,
                            memberAccess.memberName
                        );

                    if (member) {

                        return this.toLocation(
                            member
                        );
                    }
                }
            }

            /*
             * Memberとして解決できなかった場合、
             * 通常の名前検索には落とさない。
             *
             * 例えば
             *
             * data.unknown
             *
             * の unknown を別ファイルの同名functionへ
             * 飛ばしてしまうのを防ぐ。
             */

            return null;
        }

        /*
         * ---------------------------------------------------------
         * 3. 通常のローカル変数
         *
         * float4 color = ...;
         *
         * color;
         * ---------------------------------------------------------
         */

        const localVariable =
            this.findVariableDeclarationInSource(
                document,
                word,
                offset
            );

        if (localVariable) {

            console.log(
                `[DefinitionProvider] Source variable -> ` +
                `${localVariable.name} : ` +
                `${localVariable.typeName}`
            );

            return {
                uri:
                    localVariable.uri,

                range:
                    localVariable.range
            };
        }

        /*
         * ---------------------------------------------------------
         * 4. 現在のファイル
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
            `[DefinitionProvider] Local matches: ` +
            `${localMatches.length}`
        );

        if (
            localMatches.length > 0
        ) {

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
                    `[DefinitionProvider] Local -> ` +
                    `${selected.kind} ${selected.name}`
                );

                return this.toLocation(
                    selected
                );
            }
        }

        /*
         * ---------------------------------------------------------
         * 5. includeを再帰的にロード
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
         * 6. Workspace全体
         * ---------------------------------------------------------
         */

        const matches =
            this.documentManager
                .getWorkspaceIndex()
                .findExact(word);

        console.log(
            `[DefinitionProvider] Global search "${word}" -> ` +
            `${matches.length}`
        );

        for (
            const match
            of matches
        ) {

            console.log(
                `[DefinitionProvider] Match: ` +
                `${match.symbol.kind} ` +
                `${match.symbol.name} @ ` +
                `${match.uri}`
            );
        }

        if (
            matches.length === 0
        ) {
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
            `[DefinitionProvider] Global -> ` +
            `${selected.kind} ` +
            `${selected.name} @ ` +
            `${selected.location.uri}`
        );

        return this.toLocation(
            selected
        );
    }

    /*
     * -------------------------------------------------------------
     * Member access取得
     *
     * cursorが
     *
     * data.position
     *      ^^^^^^^^
     *
     * のどこにあっても、
     *
     * data
     *
     * と
     *
     * position
     *
     * を取得する。
     * -------------------------------------------------------------
     */

private getMemberAccessAtPosition(
    text: string,
    offset: number
): {
    objectName: string;
    memberName: string;
} | null {

    if (text.length === 0) {
        return null;
    }

    offset = Math.max(
        0,
        Math.min(offset, text.length)
    );

    const isIdentifierCharacter = (char: string): boolean => {
        return /[A-Za-z0-9_]/.test(char);
    };

    // カーソル位置から member 名の範囲を探す
    let memberStart = offset;

    while (
        memberStart > 0 &&
        isIdentifierCharacter(text[memberStart - 1])
    ) {
        memberStart--;
    }

    let memberEnd = offset;

    while (
        memberEnd < text.length &&
        isIdentifierCharacter(text[memberEnd])
    ) {
        memberEnd++;
    }

    if (memberStart === memberEnd) {
        return null;
    }

    const memberName = text.substring(
        memberStart,
        memberEnd
    );

    // member の左側にある空白を飛ばす
    let dotOffset = memberStart;

    while (
        dotOffset > 0 &&
        /\s/.test(text[dotOffset - 1])
    ) {
        dotOffset--;
    }

    // "." がなければメンバーアクセスではない
    if (
        dotOffset <= 0 ||
        text[dotOffset - 1] !== "."
    ) {
        return null;
    }

    dotOffset--;

    // "." の左側の空白を飛ばす
    let objectEnd = dotOffset;

    while (
        objectEnd > 0 &&
        /\s/.test(text[objectEnd - 1])
    ) {
        objectEnd--;
    }

    // object 名を探す
    let objectStart = objectEnd;

    while (
        objectStart > 0 &&
        isIdentifierCharacter(text[objectStart - 1])
    ) {
        objectStart--;
    }

    if (objectStart === objectEnd) {
        return null;
    }

    const objectName = text.substring(
        objectStart,
        objectEnd
    );

    console.log(
        `[DefinitionProvider] getMemberAccessAtPosition -> ${objectName}.${memberName}`
    );

    return {
        objectName,
        memberName
    };
}

    /*
     * -------------------------------------------------------------
     * ソースから変数宣言を探す
     *
     * float4 color = ...
     * float3 position;
     * MyStruct data;
     *
     * -------------------------------------------------------------
     */

private findVariableDeclarationInSource(
    document: TextDocument,
    variableName: string,
    usageOffset: number
): {
    name: string;
    typeName: string;
    uri: string;
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
} | null {

    const text =
        document.getText();

    const escapedName =
        variableName.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );

    /*
     * ---------------------------------------------------------
     * 1. 通常の変数宣言
     *
     * float4 color;
     * float3 position;
     * MyStruct data;
     * const MyStruct data;
     * static MyStruct data;
     * ---------------------------------------------------------
     */

    const variablePattern =
        new RegExp(
            "\\b" +
            "(?:(?:const|static|uniform|volatile|in|out|inout)\\s+)*" +
            "([A-Za-z_][A-Za-z0-9_]*)" +
            "\\s+" +
            escapedName +
            "\\s*(?==|;|,|\\[|:)",
            "g"
        );

    let best:
        {
            name: string;
            typeName: string;
            startOffset: number;
            endOffset: number;
        } | null = null;

    let match:
        RegExpExecArray | null;

    while (
        (match = variablePattern.exec(text)) !== null
    ) {

        const startOffset =
            match.index;

        if (
            startOffset >= usageOffset
        ) {
            continue;
        }

        const typeName =
            match[1];

        if (
            this.isVariableDeclarationKeyword(
                typeName
            )
        ) {
            continue;
        }

        const nameStart =
            text.indexOf(
                variableName,
                startOffset
            );

        if (
            nameStart < 0
        ) {
            continue;
        }

        if (
            !best ||
            startOffset >
            best.startOffset
        ) {
            best = {
                name:
                    variableName,

                typeName,

                startOffset:
                    nameStart,

                endOffset:
                    nameStart +
                    variableName.length
            };
        }
    }

    if (best) {
        return {
            name:
                best.name,

            typeName:
                best.typeName,

            uri:
                document.uri,

            range:
                this.rangeFromOffsets(
                    document,
                    best.startOffset,
                    best.endOffset
                )
        };
    }

    /*
     * ---------------------------------------------------------
     * 2. 関数パラメータ
     *
     * float4 Test(MyStruct a, MyStruct b)
     *
     * a.position
     * b.position
     *
     * ここを現在の実装では拾えていなかった。
     * ---------------------------------------------------------
     */

    const parameterPattern =
        new RegExp(
            "\\b" +
            "([A-Za-z_][A-Za-z0-9_]*)" +
            "\\s+" +
            escapedName +
            "\\s*(?=[,)])",
            "g"
        );

    while (
        (match =
            parameterPattern.exec(text)) !== null
    ) {

        const startOffset =
            match.index;

        if (
            startOffset >= usageOffset
        ) {
            continue;
        }

        const typeName =
            match[1];

        if (
            this.isVariableDeclarationKeyword(
                typeName
            )
        ) {
            continue;
        }

        /*
         * structのフィールドなどを
         * parameterと誤認しないため、
         * 直前が "(" または "," のケースを優先する。
         */

        let before =
            startOffset - 1;

        while (
            before >= 0 &&
            /\s/.test(text[before])
        ) {
            before--;
        }

        if (
            before < 0
        ) {
            continue;
        }

        const beforeChar =
            text[before];

        if (
            beforeChar !== "(" &&
            beforeChar !== ","
        ) {
            continue;
        }

        const nameStart =
            text.indexOf(
                variableName,
                startOffset
            );

        if (
            nameStart < 0
        ) {
            continue;
        }

        if (
            !best ||
            startOffset >
            best.startOffset
        ) {
            best = {
                name:
                    variableName,

                typeName,

                startOffset:
                    nameStart,

                endOffset:
                    nameStart +
                    variableName.length
            };
        }
    }

    if (!best) {
        return null;
    }

    return {
        name:
            best.name,

        typeName:
            best.typeName,

        uri:
            document.uri,

        range:
            this.rangeFromOffsets(
                document,
                best.startOffset,
                best.endOffset
            )
    };
}

    /*
     * -------------------------------------------------------------
     * struct.field を検索
     * -------------------------------------------------------------
     */

private findStructField(
    typeName: string,
    memberName: string
): ShaderSymbol | null {

    const normalizedType =
        typeName
            .replace(
                /\b(const|static|uniform|volatile|in|out|inout)\b/g,
                ""
            )
            .trim();

    const structMatches =
        this.documentManager
            .getWorkspaceIndex()
            .findByKind(
                normalizedType,
                "struct"
            );

    console.log(
        `[DefinitionProvider] Struct lookup: ` +
        `${normalizedType} -> ${structMatches.length}`
    );

    const normalizedMember =
        memberName.toLowerCase();

    for (
        const match
        of structMatches
    ) {

        const struct =
            match.symbol;

        const field =
            struct.children.find(
                child =>
                    child.kind === "field" &&
                    child.name.toLowerCase() ===
                    normalizedMember
            );

        if (field) {

            console.log(
                `[DefinitionProvider] Field resolved: ` +
                `${normalizedType}.${memberName} @ ` +
                `${field.location.uri}`
            );

            return field;
        }
    }

    return null;
}

    /*
     * -------------------------------------------------------------
     * ローカル / Workspace object選択
     * -------------------------------------------------------------
     */

    private selectBestObjectSymbol(
        currentUri: string,
        currentOffset: number,
        symbols: ShaderSymbol[]
    ): ShaderSymbol | null {

        const localSymbols =
            symbols.filter(
                symbol =>
                    symbol.location.uri ===
                    currentUri
            );

        if (
            localSymbols.length === 0
        ) {
            return symbols[0] ?? null;
        }

        const beforeCursor =
            localSymbols.filter(
                symbol =>
                    symbol.location.range.start.offset <=
                    currentOffset
            );

        if (
            beforeCursor.length > 0
        ) {

            beforeCursor.sort(
                (a, b) =>
                    b.location.range.start.offset -
                    a.location.range.start.offset
            );

            return beforeCursor[0];
        }

        return localSymbols[0];
    }

    /*
     * -------------------------------------------------------------
     * Include再帰
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

        if (
            visited.has(uri)
        ) {
            return;
        }

        visited.add(uri);

        let includePaths: string[];

        if (
            parsed.languageId === "hlsl" &&
            source !== undefined
        ) {

            includePaths =
                this.collectRawHlslIncludes(
                    source
                );

        } else {

            includePaths =
                this.collectIncludes(
                    parsed
                );
        }

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
                continue;
            }

            const externalDocument =
                this.documentManager
                    .ensureExternalDocument(
                        resolved.uri
                    );

            if (!externalDocument) {
                continue;
            }

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
     * Include収集
     * -------------------------------------------------------------
     */

    private collectIncludes(
        parsed: ParsedDocument
    ): string[] {

        const result: string[] = [];

        if (
            parsed.ast.kind ===
            "ShaderDocument"
        ) {

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

        return result;
    }

    private collectHlslIncludes(
        ast: any,
        result: string[]
    ): void {

        if (
            !ast ||
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
                declaration?.kind ===
                "HlslInclude" &&
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
                    block?.hlsl,
                    result
                );
            }
        }

        if (
            !Array.isArray(
                ast.subShaders
            )
        ) {
            return;
        }

        for (
            const subShader
            of ast.subShaders
        ) {

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
                        block?.hlsl,
                        result
                    );
                }
            }

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
                        block?.hlsl,
                        result
                    );
                }
            }
        }
    }

    /*
     * -------------------------------------------------------------
     * Raw HLSL include
     * -------------------------------------------------------------
     */

    private collectRawHlslIncludes(
        source: string
    ): string[] {

        const includes: string[] = [];

        const lines =
            source.split(/\r?\n/);

        for (
            const line
            of lines
        ) {

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

            includes.push(
                includePath
            );
        }

        return includes;
    }

    /*
     * -------------------------------------------------------------
     * Definition選択
     * -------------------------------------------------------------
     */

    private selectBestDefinition(
        currentUri: string,
        symbols: ShaderSymbol[]
    ): ShaderSymbol | null {

        if (
            symbols.length === 0
        ) {
            return null;
        }

        const localSymbols =
            symbols.filter(
                symbol =>
                    symbol.location.uri ===
                    currentUri
            );

        if (
            localSymbols.length > 0
        ) {

            const priority:
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
                    priority
                );

            if (selected) {
                return selected;
            }
        }

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
                        symbol.kind ===
                        kind
                );

            if (found) {
                return found;
            }
        }

        return symbols[0] ?? null;
    }

    /*
     * -------------------------------------------------------------
     * Built-in HLSL type
     * -------------------------------------------------------------
     */

    private isBuiltinHlslType(
        word: string
    ): boolean {

        const builtinTypes =
            new Set([

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

        return builtinTypes.has(
            word
        );
    }

    /*
     * -------------------------------------------------------------
     * HLSL semantic
     * -------------------------------------------------------------
     */

private isHlslSemantic(word: string): boolean {
    // HLSL semantic は大文字表記だけを対象にする。
    // "position" のような通常の変数名・field 名は semantic として扱わない。
    if (word !== word.toUpperCase()) {
        return false;
    }

    return (
        /^SV_[A-Z0-9_]+$/.test(word) ||
        /^POSITION\d*$/.test(word) ||
        /^NORMAL\d*$/.test(word) ||
        /^TANGENT\d*$/.test(word) ||
        /^BINORMAL\d*$/.test(word) ||
        /^BLENDINDICES\d*$/.test(word) ||
        /^BLENDWEIGHT\d*$/.test(word) ||
        /^TEXCOORD\d*$/.test(word) ||
        /^COLOR\d*$/.test(word) ||
        /^PSIZE\d*$/.test(word) ||
        /^FOG\d*$/.test(word)
    );
}
    /*
     * -------------------------------------------------------------
     * HLSL Swizzle
     * -------------------------------------------------------------
     */

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
            const character
            of lower
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

    /*
     * -------------------------------------------------------------
     * 変数宣言として扱わないkeyword
     * -------------------------------------------------------------
     */

    private isVariableDeclarationKeyword(
        word: string
    ): boolean {

        return new Set([

            "if",
            "else",
            "for",
            "while",
            "switch",
            "case",

            "return",

            "struct",
            "class",

            "cbuffer",
            "tbuffer",

            "SamplerState",
            "SamplerComparisonState",

            "Texture1D",
            "Texture2D",
            "Texture3D",
            "TextureCube",

            "RWTexture1D",
            "RWTexture2D",
            "RWTexture3D",

            "Buffer",
            "StructuredBuffer",
            "RWStructuredBuffer",

            "ByteAddressBuffer",
            "RWByteAddressBuffer"
        ]).has(
            word
        );
    }

    /*
     * -------------------------------------------------------------
     * Offset → Range
     * -------------------------------------------------------------
     */

    private rangeFromOffsets(
        document: TextDocument,
        startOffset: number,
        endOffset: number
    ) {

        return {
            start:
                document.positionAt(
                    startOffset
                ),

            end:
                document.positionAt(
                    endOffset
                )
        };
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
     * identifier取得
     * -------------------------------------------------------------
     */

    private getWordAtPosition(
        text: string,
        offset: number
    ): string | null {

        if (
            text.length === 0
        ) {
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

        let start =
            offset;

        let end =
            offset;

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

        if (
            start === end
        ) {
            return null;
        }

        return text.substring(
            start,
            end
        );
    }
}