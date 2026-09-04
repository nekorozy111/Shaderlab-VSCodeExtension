import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
    IncludeInfo,
    ShaderSymbol,
    SymbolDatabase
} from "./symbolDatabase";

export class ShaderDefinitionProvider
    implements vscode.DefinitionProvider
{
    constructor(
        private readonly database: SymbolDatabase
    ) {}

    public provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ):
        vscode.ProviderResult<
            vscode.Definition
        > {
        const wordRange =
            document.getWordRangeAtPosition(
                position,
                /[A-Za-z_][A-Za-z0-9_]*/
            );

        if (!wordRange) {
            return undefined;
        }

        const word =
            document.getText(
                wordRange
            );

        /*
         * #include の特殊処理
         */
        const includeDefinition =
            this.findIncludeDefinition(
                document,
                position
            );

        if (includeDefinition) {
            return includeDefinition;
        }

        /*
         * 通常の Symbol
         */
        const symbol =
            this.findSymbol(
                word
            );

        if (!symbol) {
            return undefined;
        }

        const location =
            this.createLocation(
                symbol
            );

        return location;
    }

    private findSymbol(
        name: string
    ): ShaderSymbol | undefined {
        const functionInfo =
            this.database.findFunction(
                name
            );

        if (functionInfo) {
            return functionInfo;
        }

        const structInfo =
            this.database.findStruct(
                name
            );

        if (structInfo) {
            return structInfo;
        }

        const macroInfo =
            this.database.findMacro(
                name
            );

        if (macroInfo) {
            return macroInfo;
        }

        const variable =
            this.database.findVariable(
                name
            );

        if (variable) {
            return variable;
        }

        return undefined;
    }

    private createLocation(
        symbol: ShaderSymbol
    ):
        vscode.Location | undefined {
        if (
            !symbol.File
        ) {
            return undefined;
        }

        const uri =
            this.resolveFileUri(
                symbol.File
            );

        if (!uri) {
            return undefined;
        }

        const line =
            Math.max(
                (symbol.Line ?? 1) - 1,
                0
            );

        return new vscode.Location(
            uri,
            new vscode.Position(
                line,
                0
            )
        );
    }

    private findIncludeDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ):
        vscode.Location | undefined {
        const line =
            document
                .lineAt(
                    position.line
                )
                .text;

        const includeMatch =
            line.match(
                /^\s*#\s*include\s*[<"]([^>"]+)[>"]/
            );

        if (!includeMatch) {
            return undefined;
        }

        const includePath =
            includeMatch[1];

        const include =
            this.database.includes.find(
                x =>
                    x.Path === includePath
                    ||
                    x.Aliases.includes(
                        includePath
                    )
            );

        if (!include) {
            return undefined;
        }

        return this.createIncludeLocation(
            include
        );
    }

    private createIncludeLocation(
        include: IncludeInfo
    ):
        vscode.Location | undefined {
        const candidates =
            [
                include.ResolvedPath,
                include.Path
            ];

        for (
            const candidate
            of candidates
        ) {
            if (!candidate) {
                continue;
            }

            const uri =
                this.resolveFileUri(
                    candidate
                );

            if (
                uri &&
                this.fileExists(
                    uri
                )
            ) {
                return new vscode.Location(
                    uri,
                    new vscode.Position(
                        0,
                        0
                    )
                );
            }
        }

        return undefined;
    }

    private resolveFileUri(
        file: string
    ): vscode.Uri | undefined {
        if (!file) {
            return undefined;
        }

        /*
         * Windows:
         *
         * C:\Unity\...
         */
        if (
            path.isAbsolute(
                file
            )
        ) {
            return vscode.Uri.file(
                file
            );
        }

        /*
         * file:// URI
         */
        if (
            file.startsWith(
                "file://"
            )
        ) {
            try {
                return vscode.Uri.parse(
                    file
                );
            } catch {
                return undefined;
            }
        }

        const workspace =
            vscode.workspace.workspaceFolders?.[0];

        if (!workspace) {
            return undefined;
        }

        const workspacePath =
            workspace.uri.fsPath;

        /*
         * Packages/...
         */
        const resolved =
            path.resolve(
                workspacePath,
                file
            );

        if (
            fs.existsSync(
                resolved
            )
        ) {
            return vscode.Uri.file(
                resolved
            );
        }

        return vscode.Uri.file(
            resolved
        );
    }

    private fileExists(
        uri: vscode.Uri
    ): boolean {
        if (
            uri.scheme !== "file"
        ) {
            return true;
        }

        return fs.existsSync(
            uri.fsPath
        );
    }
}
