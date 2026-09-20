import * as path from "path";
import * as vscode from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function startLanguageClient(
    context: vscode.ExtensionContext
): Promise<void> {

    if (client !== undefined) {
        return;
    }

    const serverModule = context.asAbsolutePath(
        path.join(
            "out",
            "server",
            "server.js"
        )
    );

    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },

        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                execArgv: [
                    "--nolazy",
                    "--inspect=6009"
                ]
            }
        }
    };

    const clientOptions: LanguageClientOptions = {

        documentSelector: [
            {
                scheme: "file",
                language: "shaderlab"
            },
            {
                scheme: "file",
                language: "hlsl"
            },
            {
                scheme: "file",
                language: "hlsli"
            }
        ],

        synchronize: {
            configurationSection: "urpShaderLab"
        },

        outputChannelName:
            "URP ShaderLab Tools"
    };

    client = new LanguageClient(
        "urpShaderLabLanguageServer",
        "URP ShaderLab Language Server",
        serverOptions,
        clientOptions
    );

    await client.start();
}

export async function stopLanguageClient(): Promise<void> {

    if (client === undefined) {
        return;
    }

    const currentClient = client;

    client = undefined;

    await currentClient.stop();
}