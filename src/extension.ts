import * as vscode from 'vscode';
import { requestMemoryStats, startLanguageClient, stopLanguageClient } from './client/languageClient';

let clientStarted = false;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('urpShaderLab');
  const enabled = configuration.get<boolean>('enable', true);
  if (!enabled) {
    return;
  }

  await startLanguageClient(context);
  clientStarted = true;

  const output = vscode.window.createOutputChannel('URP ShaderLab Tools');
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand('urpShaderLab.showMemoryStats', async () => {
      const stats = await requestMemoryStats();
      if (!stats) {
        return;
      }
      output.appendLine(JSON.stringify(stats, null, 2));
      output.show(true);
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (!clientStarted) {
    return;
  }

  await stopLanguageClient();
  clientStarted = false;
}
