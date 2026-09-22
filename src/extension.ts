import * as vscode from 'vscode';

import { startLanguageClient, stopLanguageClient } from './client/languageClient';

let clientStarted = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('urpShaderLab');

  const enabled = configuration.get<boolean>('enable', true);

  if (!enabled) {
    return;
  }

  await startLanguageClient(context);

  clientStarted = true;
}

export async function deactivate(): Promise<void> {
  if (!clientStarted) {
    return;
  }

  await stopLanguageClient();

  clientStarted = false;
}
