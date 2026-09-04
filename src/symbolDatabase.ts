import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface FunctionParameter {
    Name: string;
    Type: string;
}

export interface StructMember {
    Name: string;
    Type: string;
    Semantic?: string | null;
    File?: string | null;
    Line?: number | null;
}

export interface ShaderSymbol {
    Name: string;
    File?: string | null;
    Line?: number | null;
    Documentation?: string | null;
    Kind?: string | null;
    Signature?: string | null;
}

export interface IncludeInfo extends ShaderSymbol {
    Path: string;
    ResolvedPath?: string | null;
    Package?: string | null;
    Aliases: string[];
    IsUnityInclude: boolean;
    IsUrpInclude: boolean;
}

export interface FunctionInfo
    extends ShaderSymbol
{
    ReturnType: string;
    Parameters: FunctionParameter[];
}


export interface StructInfo extends ShaderSymbol {
    Members: StructMember[];
}

export interface MacroInfo extends ShaderSymbol {
    Parameters: string[];
    Value?: string | null;
}

export interface ShaderVariableInfo extends ShaderSymbol {
    Type: string;
    ElementType?: string | null;
    Register?: string | null;
    BufferType?: string | null;
    TextureDimension?: string | null;
    CBuffer?: string | null;

    IsReadOnly: boolean;
    IsWriteOnly: boolean;
    IsTexture: boolean;
    IsSampler: boolean;
    IsBuffer: boolean;
}

export interface UnityInfo {
    Version?: string | null;
}

export interface UrpInfo {
    Version?: string | null;
    PackagePath?: string | null;
}

export interface ShaderDatabase {
    Version: number;
    GeneratedAtUtc: string;

    Unity?: UnityInfo | null;
    Urp?: UrpInfo | null;

    Includes: IncludeInfo[];
    Functions: FunctionInfo[];
    Structs: StructInfo[];
    Macros: MacroInfo[];
    Variables: ShaderVariableInfo[];

    SourceFiles: string[];
}

export class SymbolDatabase implements vscode.Disposable {
    private database: ShaderDatabase | undefined;

    private databasePath: string | undefined;

    private fileWatcher:
        vscode.FileSystemWatcher | undefined;

    private readonly onDidChangeEmitter =
        new vscode.EventEmitter<void>();

    public readonly onDidChange =
        this.onDidChangeEmitter.event;

    public dispose(): void {
        this.fileWatcher?.dispose();
        this.onDidChangeEmitter.dispose();
    }

    public load(
        extensionContext: vscode.ExtensionContext
    ): void {
        const configuredPath =
            vscode.workspace
                .getConfiguration(
                    "unityShaderIntellisense"
                )
                .get<string>(
                    "databasePath",
                    ""
                );

        const resolvedPath =
            this.resolveDatabasePath(
                configuredPath,
                extensionContext
            );

        if (!resolvedPath) {
            this.database = undefined;
            this.databasePath = undefined;
            return;
        }

        this.databasePath =
            resolvedPath;

        this.loadFile();

        this.setupWatcher();
    }

    public reload(): void {
        if (!this.databasePath) {
            return;
        }

        this.loadFile();
    }

    public get isLoaded(): boolean {
        return this.database !== undefined;
    }

    public get includes(): IncludeInfo[] {
        return this.database?.Includes ?? [];
    }

    public get functions(): FunctionInfo[] {
        return this.database?.Functions ?? [];
    }

    public get structs(): StructInfo[] {
        return this.database?.Structs ?? [];
    }

    public get macros(): MacroInfo[] {
        return this.database?.Macros ?? [];
    }

    public get variables(): ShaderVariableInfo[] {
        return this.database?.Variables ?? [];
    }

    public get allSymbols(): ShaderSymbol[] {
        return [
            ...this.functions,
            ...this.structs,
            ...this.macros,
            ...this.variables
        ];
    }

    public findStruct(
        name: string
    ): StructInfo | undefined {
        return this.structs.find(
            x =>
                x.Name === name
        );
    }

    public findFunction(
        name: string
    ): FunctionInfo | undefined {
        return this.functions.find(
            x =>
                x.Name === name
        );
    }

    public findVariable(
        name: string
    ): ShaderVariableInfo | undefined {
        return this.variables.find(
            x =>
                x.Name === name
        );
    }

    public findMacro(
        name: string
    ): MacroInfo | undefined {
        return this.macros.find(
            x =>
                x.Name === name
        );
    }

    public searchIncludes(
        query: string
    ): IncludeInfo[] {
        const normalized =
            query.toLowerCase();

        return this.includes.filter(
            include =>
                include.Path
                    .toLowerCase()
                    .includes(normalized)
                ||
                include.Aliases.some(
                    alias =>
                        alias
                            .toLowerCase()
                            .includes(
                                normalized
                            )
                )
        );
    }

    private resolveDatabasePath(
        configuredPath: string,
        extensionContext: vscode.ExtensionContext
    ): string | undefined {
        if (configuredPath.trim().length > 0) {
            if (
                path.isAbsolute(
                    configuredPath
                )
            ) {
                return configuredPath;
            }

            const workspace =
                vscode.workspace.workspaceFolders?.[0];

            if (!workspace) {
                return undefined;
            }

            return path.resolve(
                workspace.uri.fsPath,
                configuredPath
            );
        }

        const workspace =
            vscode.workspace.workspaceFolders?.[0];

        if (!workspace) {
            return undefined;
        }

        /*
         * デフォルト:
         *
         * <workspace>/.unity-shader-intellisense/shader-database.json
         */
        return path.join(
            workspace.uri.fsPath,
            ".unity-shader-intellisense",
            "shader-database.json"
        );
    }

    private loadFile(): void {
        if (!this.databasePath) {
            return;
        }

        try {
            if (
                !fs.existsSync(
                    this.databasePath
                )
            ) {
                this.database = undefined;
                return;
            }

            const text =
                fs.readFileSync(
                    this.databasePath,
                    "utf8"
                );

            const parsed =
                JSON.parse(
                    text
                ) as ShaderDatabase;

            this.database =
                this.normalizeDatabase(
                    parsed
                );

            this.onDidChangeEmitter.fire();
        } catch (error) {
            this.database = undefined;

            console.error(
                "Failed to load Unity Shader IntelliSense database:",
                error
            );

            vscode.window.showWarningMessage(
                "Unity Shader IntelliSense database could not be loaded."
            );
        }
    }

    private normalizeDatabase(
        database: ShaderDatabase
    ): ShaderDatabase {
        return {
            Version:
                database.Version ?? 1,

            GeneratedAtUtc:
                database.GeneratedAtUtc ?? "",

            Unity:
                database.Unity ?? null,

            Urp:
                database.Urp ?? null,

            Includes:
                database.Includes ?? [],

            Functions:
                database.Functions ?? [],

            Structs:
                database.Structs ?? [],

            Macros:
                database.Macros ?? [],

            Variables:
                database.Variables ?? [],

            SourceFiles:
                database.SourceFiles ?? []
        };
    }

    private setupWatcher(): void {
        this.fileWatcher?.dispose();

        if (!this.databasePath) {
            return;
        }

        const pattern =
            new vscode.RelativePattern(
                vscode.Uri.file(
                    path.dirname(
                        this.databasePath
                    )
                ),
                path.basename(
                    this.databasePath
                )
            );

        this.fileWatcher =
            vscode.workspace.createFileSystemWatcher(
                pattern
            );

        this.fileWatcher.onDidChange(
            () => this.loadFile()
        );

        this.fileWatcher.onDidCreate(
            () => this.loadFile()
        );

        this.fileWatcher.onDidDelete(
            () => {
                this.database =
                    undefined;

                this.onDidChangeEmitter.fire();
            }
        );
    }
}
