import * as path from "path";

import {
    TextDocument
} from "vscode-languageserver-textdocument";

import { ParsedDocument } from "../parser/ast";
import { ParserService } from "../parser/parserService";
import { WorkspaceIndex } from "../symbol/workspaceIndex";
import { ProjectService } from "../project/projectService";

export class DocumentManager {
    private readonly documents =
        new Map<string, TextDocument>();

    private readonly parsedDocuments =
        new Map<string, ParsedDocument>();

    private readonly parserService =
        new ParserService();

    private readonly workspaceIndex =
        new WorkspaceIndex();

    private readonly projectService =
        new ProjectService();

    public initializeProject(
        params: Parameters<
            ProjectService["initialize"]
        >[0]
    ): void {
        this.projectService.initialize(
            params
        );
    }

    public getProjectService():
        ProjectService {
        return this.projectService;
    }

    public open(
        document: TextDocument
    ): ParsedDocument {
        this.documents.set(
            document.uri,
            document
        );

        return this.parseDocument(
            document
        );
    }

    public update(
        document: TextDocument
    ): ParsedDocument {
        this.documents.set(
            document.uri,
            document
        );

        return this.parseDocument(
            document
        );
    }

    public close(
        document: TextDocument
    ): void {
        this.documents.delete(
            document.uri
        );

        this.parsedDocuments.delete(
            document.uri
        );

        this.workspaceIndex.remove(
            document.uri
        );
    }

    public get(
        uri: string
    ): TextDocument | undefined {
        return this.documents.get(uri);
    }

    public getParsed(
        uri: string
    ): ParsedDocument | undefined {
        return this.parsedDocuments.get(uri);
    }

    public getWorkspaceIndex():
        WorkspaceIndex {
        return this.workspaceIndex;
    }

    public has(
        uri: string
    ): boolean {
        return this.documents.has(uri);
    }

    public all(): TextDocument[] {
        return Array.from(
            this.documents.values()
        );
    }

    public allParsed():
        ParsedDocument[] {
        return Array.from(
            this.parsedDocuments.values()
        );
    }

    public clear(): void {
        this.documents.clear();
        this.parsedDocuments.clear();
        this.workspaceIndex.clear();
    }

    public ensureExternalDocument(
        uri: string
    ): ParsedDocument | undefined {
        const existing =
            this.workspaceIndex
                .getDocument(uri);

        if (existing) {
            return existing;
        }

        const filePath =
            this.uriToPath(uri);

        if (!filePath) {
            return undefined;
        }

        const text =
            this.projectService
                .readFile(filePath);

        if (text === undefined) {
            return undefined;
        }

        const languageId =
            this.detectLanguageId(
                filePath
            );

        if (!languageId) {
            return undefined;
        }

        const document =
            TextDocument.create(
                uri,
                languageId,
                0,
                text
            );

        const parsed =
            this.parserService.parse(
                document
            );

        this.workspaceIndex.update(
            parsed
        );

        return parsed;
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

public getRelatedIncludeUris(
    rootUri: string
): Set<string> {
    const result =
        new Set<string>();

    result.add(rootUri);

    const visited =
        new Set<string>();

    const parsed =
        this.getParsed(rootUri);

    if (!parsed) {
        return result;
    }

    this.collectRelatedIncludeUrisRecursive(
        rootUri,
        parsed,
        visited,
        result
    );

    return result;
}

private collectRelatedIncludeUrisRecursive(
    uri: string,
    parsed: ParsedDocument,
    visited: Set<string>,
    result: Set<string>,
    source?: string
): void {
    if (
        visited.has(uri)
    ) {
        return;
    }

    visited.add(uri);

    let includePaths:
        string[];

    /*
     * 外部 HLSL は実ファイルの内容から
     * #include を取得する。
     */
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
            this.projectService
                .resolveInclude(
                    includePath,
                    uri
                );

        if (!resolved) {
            continue;
        }

        result.add(
            resolved.uri
        );

        /*
         * include 先を Parse / Index。
         */
        const externalDocument =
            this.ensureExternalDocument(
                resolved.uri
            );

        if (!externalDocument) {
            continue;
        }

        /*
         * 再帰的な #include を調べるため、
         * 外部ファイルの raw source を取得する。
         */
        const externalSource =
            this.projectService.readFile(
                resolved.resolvedPath
            );

        this.collectRelatedIncludeUrisRecursive(
            resolved.uri,
            externalDocument,
            visited,
            result,
            externalSource
        );
    }
}

private collectIncludes(
    parsed: ParsedDocument
): string[] {
    const result:
        string[] = [];

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

    private collectShaderLabIncludes(
        ast: any,
        result: string[]
    ): void {
        if (!ast) {
            return;
        }

        /*
         * Shader 全体の HLSL ブロック
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
            /*
             * SubShader 内の HLSL
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
                        block?.hlsl,
                        result
                    );
                }
            }

            /*
             * Pass 内の HLSL
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
        const includes:
            string[] = [];

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
                match[1] ??
                match[2];

            if (!includePath) {
                continue;
            }

            includes.push(
                includePath
            );
        }

        return includes;
    }
    private parseDocument(
        document: TextDocument
    ): ParsedDocument {
        const parsed =
            this.parserService.parse(
                document
            );

        this.parsedDocuments.set(
            document.uri,
            parsed
        );

        this.workspaceIndex.update(
            parsed
        );

        return parsed;
    }

    private detectLanguageId(
        filePath: string
    ): string | undefined {
        const extension =
            path.extname(filePath)
                .toLowerCase();

        switch (extension) {
            case ".shader":
                return "shaderlab";

            case ".hlsl":
            case ".hlsli":
                return "hlsl";

            default:
                return undefined;
        }
    }

    private uriToPath(
        uri: string
    ): string | undefined {
        if (!uri.startsWith("file://")) {
            return undefined;
        }

        try {
            let value =
                decodeURIComponent(
                    uri.substring(
                        "file://".length
                    )
                );

            if (
                /^\/[A-Za-z]:\//.test(value)
            ) {
                value = value.substring(1);
            }

            return value;
        } catch {
            return undefined;
        }
    }
}