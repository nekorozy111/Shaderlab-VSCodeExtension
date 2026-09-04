import * as vscode from "vscode";

import {
    SymbolDatabase
} from "./symbolDatabase";

import {
    ShaderCompletionProvider
} from "./completionProvider";

import {
    ShaderHoverProvider
} from "./hoverProvider";

import {
    ShaderDefinitionProvider
} from "./definitionProvider";

import {
    ShaderParser
} from "./shaderParser";

import {
    ShaderDocument
} from "./shaderDocument";

let database:
    SymbolDatabase | undefined;

let shaderDocument:
    ShaderDocument | undefined;

export function activate(
    context: vscode.ExtensionContext
): void {
    database =
        new SymbolDatabase();

    database.load(
        context
    );

    context.subscriptions.push(
        database
    );

    /*
     * Local shader parser
     */
    const parser =
        new ShaderParser();

    shaderDocument =
        new ShaderDocument(
            parser
        );

    context.subscriptions.push(
        shaderDocument
    );

    /*
     * Providers
     */
    const completionProvider =
        new ShaderCompletionProvider(
            database,
            shaderDocument
        );

    const hoverProvider =
        new ShaderHoverProvider(
            database
        );

    const definitionProvider =
        new ShaderDefinitionProvider(
            database
        );

    const selector:
        vscode.DocumentSelector = [
            {
                language: "shaderlab"
            },
            {
                language: "hlsl"
            },
            {
                language: "compute"
            }
        ];

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            completionProvider,
            "#",
            "\"",
            "<",
            "."
        )
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            selector,
            hoverProvider
        )
    );

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            selector,
            definitionProvider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "unityShaderIntellisense.reloadDatabase",
            () => {
                database?.reload();

                vscode.window.showInformationMessage(
                    "Unity Shader IntelliSense database reloaded."
                );
            }
        )
    );
}

export function deactivate(): void {
    database?.dispose();

    shaderDocument?.dispose();

    database = undefined;
    shaderDocument = undefined;
}
