import * as vscode from "vscode";

import {
    ParsedFunction,
    ParsedShaderDocument,
    ParsedStruct,
    ParsedVariable,
    ShaderParser
} from "./shaderParser";

export class ShaderDocument
    implements vscode.Disposable
{
    private readonly documents =
        new Map<
            string,
            ParsedShaderDocument
        >();

    private readonly versions =
        new Map<
            string,
            number
        >();

    private readonly disposables:
        vscode.Disposable[] = [];

    constructor(
        private readonly parser:
            ShaderParser
    ) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(
                event => {
                    this.update(
                        event.document
                    );
                }
            )
        );

        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(
                document => {
                    this.remove(
                        document
                    );
                }
            )
        );
    }

    public dispose(): void {
        for (
            const disposable
            of this.disposables
        ) {
            disposable.dispose();
        }

        this.documents.clear();
        this.versions.clear();
    }

    public get(
        document: vscode.TextDocument
    ): ParsedShaderDocument {
        const key =
            document.uri.toString();

        const version =
            document.version;

        const cachedVersion =
            this.versions.get(
                key
            );

        const cached =
            this.documents.get(
                key
            );

        if (
            cached &&
            cachedVersion === version
        ) {
            return cached;
        }

        const parsed =
            this.parser.parse(
                document
            );

        this.documents.set(
            key,
            parsed
        );

        this.versions.set(
            key,
            version
        );

        return parsed;
    }

    public getFunctions(
        document: vscode.TextDocument
    ): ParsedFunction[] {
        return this.get(
            document
        ).functions;
    }

    public getStructs(
        document: vscode.TextDocument
    ): ParsedStruct[] {
        return this.get(
            document
        ).structs;
    }

    public getVariables(
        document: vscode.TextDocument
    ): ParsedVariable[] {
        return this.get(
            document
        ).variables;
    }

    public findFunction(
        document: vscode.TextDocument,
        name: string,
        line: number
    ): ParsedFunction | undefined {
        return this.getFunctions(
            document
        ).find(
            functionInfo =>
                functionInfo.name === name &&
                line >= functionInfo.startLine &&
                line <= functionInfo.endLine
        );
    }

    public findVariable(
        document: vscode.TextDocument,
        name: string,
        line: number
    ): ParsedVariable | undefined {
        /*
         * 内側の scope を優先するため、
         * 後ろから検索する。
         */
        const variables =
            this.getVariables(
                document
            );

        for (
            let i = variables.length - 1;
            i >= 0;
            i--
        ) {
            const variable =
                variables[i];

            if (
                variable.name === name &&
                line >= variable.scopeStart &&
                line <= variable.scopeEnd &&
                variable.line <= line
            ) {
                return variable;
            }
        }

        return undefined;
    }

    public findStruct(
        document: vscode.TextDocument,
        name: string
    ): ParsedStruct | undefined {
        return this.getStructs(
            document
        ).find(
            structInfo =>
                structInfo.name === name
        );
    }

    private update(
        document: vscode.TextDocument
    ): void {
        if (
            !this.isSupportedLanguage(
                document
            )
        ) {
            return;
        }

        const key =
            document.uri.toString();

        const parsed =
            this.parser.parse(
                document
            );

        this.documents.set(
            key,
            parsed
        );

        this.versions.set(
            key,
            document.version
        );
    }

    private remove(
        document: vscode.TextDocument
    ): void {
        const key =
            document.uri.toString();

        this.documents.delete(
            key
        );

        this.versions.delete(
            key
        );
    }

    private isSupportedLanguage(
        document: vscode.TextDocument
    ): boolean {
        return [
            "shaderlab",
            "hlsl",
            "compute"
        ].includes(
            document.languageId
        );
    }
}
