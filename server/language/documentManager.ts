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