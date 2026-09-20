import {
    TextDocument
} from "vscode-languageserver-textdocument";

import {
    ParsedDocument
} from "../parser/ast";

import {
    ParserService
} from "../parser/parserService";

export class DocumentManager {

    private readonly documents =
        new Map<string, TextDocument>();

    private readonly parsedDocuments =
        new Map<string, ParsedDocument>();

    private readonly parserService =
        new ParserService();

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
    }

    public get(
        uri: string
    ): TextDocument | undefined {

        return this.documents.get(
            uri
        );
    }

    public getParsed(
        uri: string
    ): ParsedDocument | undefined {

        return this.parsedDocuments.get(
            uri
        );
    }

    public has(
        uri: string
    ): boolean {

        return this.documents.has(uri);
    }

    public all():
        TextDocument[] {

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

        return parsed;
    }
}