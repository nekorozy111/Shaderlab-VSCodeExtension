import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { requestMemoryStats, setAnalysisRoot, startLanguageClient, stopLanguageClient } from './client/languageClient';

let clientStarted = false;

class IncludeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly rootUri: vscode.Uri,
    public readonly isRoot: boolean,
    public readonly ancestors: string[],
    public readonly isSelected: boolean,
    public readonly isActive: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(path.basename(uri.fsPath), collapsibleState);
    this.description = isRoot ? '解析root' : path.relative(path.dirname(rootUri.fsPath), uri.fsPath);
    this.resourceUri = uri;
    if (isRoot && isSelected) {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      this.description = '✓ 解析root（選択中）';
    } else if (isActive) {
      // 編集中のファイルを黄色い三角で示す
      this.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('editorWarning.foreground'));
      this.description = `${this.description ?? ''}  ▶ 編集中`;
    }
    this.command = {
      command: 'vscode.open',
      title: 'ファイルを開く',
      arguments: [uri],
    };
    this.contextValue = isRoot ? 'shaderlabAnalysisRoot' : 'shaderlabInclude';
  }
}

class IncludeTreeProvider implements vscode.TreeDataProvider<IncludeTreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly childrenCache = new Map<string, vscode.Uri[]>();
  private readonly rootCache = new Map<string, vscode.Uri[]>();
  // パスの比較には小文字化したキーを使い、実際のパス表記は保持する。
  private selectedRootPath: string | undefined;

  private pathKey(value: string): string {
    return value.toLowerCase();
  }

  private get activePath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? uri.fsPath.toLowerCase() : undefined;
  }

  public setSelectedRoot(uri: string | undefined): void {
    this.selectedRootPath = uri ? vscode.Uri.parse(uri).fsPath : undefined;
    this.refresh();
  }

  public getSelectedRoot(): string | undefined {
    return this.selectedRootPath;
  }

  public async reconcileActiveRoot(): Promise<string | undefined> {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!active || active.scheme !== 'file') return undefined;
    const current = this.selectedRootPath;
    // 選択中rootの構成内への移動ならrootを維持する。無関係なファイルへ移動した場合は候補を再判定する。
    if (current && fsSync.existsSync(current)) {
      const currentUri = vscode.Uri.file(current);
      if (await this.containsFile(currentUri, active, new Set())) return undefined;
    }
    const roots = await this.findRoots();
    const next = roots[0];
    if (next && next.fsPath.toLowerCase() !== current) {
      this.selectedRootPath = next.fsPath;
      return next.toString();
    }
    return undefined;
  }

  private async containsFile(root: vscode.Uri, target: vscode.Uri, seen: Set<string>): Promise<boolean> {
    const key = root.fsPath.toLowerCase();
    if (key === target.fsPath.toLowerCase()) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    for (const child of await this.readIncludes(root)) {
      if (await this.containsFile(child, target, seen)) return true;
    }
    return false;
  }

  public refresh(): void {
    this.childrenCache.clear();
    this.rootCache.clear();
    this.changed.fire();
  }

  public getTreeItem(item: IncludeTreeItem): vscode.TreeItem {
    return item;
  }

  public async getChildren(item?: IncludeTreeItem): Promise<IncludeTreeItem[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    if (!item) {
      const roots = await this.findRoots();
      const items: IncludeTreeItem[] = [];
      for (const uri of roots) {
        const children = await this.readIncludes(uri);
        items.push(
          new IncludeTreeItem(
            uri,
            uri,
            true,
            [uri.fsPath.toLowerCase()],
            this.selectedRootPath !== undefined && this.pathKey(this.selectedRootPath) === this.pathKey(uri.fsPath),
            this.activePath === uri.fsPath.toLowerCase(),
            children.length > 0
              ? this.isPackageCachePath(uri)
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.None,
          ),
        );
      }
      return items;
    }
    const children = await this.readIncludes(item.uri);
    const items: IncludeTreeItem[] = [];
    for (const uri of children) {
      const seen = item.ancestors.includes(uri.fsPath.toLowerCase());
      const grandchildren = seen ? [] : await this.readIncludes(uri);
      items.push(
        new IncludeTreeItem(
          uri,
          item.rootUri,
          false,
          [...item.ancestors, uri.fsPath.toLowerCase()],
          false,
          this.activePath === uri.fsPath.toLowerCase(),
          seen || grandchildren.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : this.isPackageCachePath(uri)
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.Expanded,
        ),
      );
    }
    return items;
  }

  private async findRoots(): Promise<vscode.Uri[]> {
    // 現在アクティブなファイルを含む、開いているファイルだけをroot候補にする
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!active || active.scheme !== 'file') {
      return [];
    }

    const extensions = new Set(['.hlsl', '.hlsli', '.cginc', '.compute', '.shader']);
    const openFiles = new Map<string, vscode.Uri>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri; modified?: vscode.Uri } | undefined;
        const uri = input?.uri ?? input?.modified;
        if (uri?.scheme === 'file' && extensions.has(path.extname(uri.fsPath).toLowerCase())) {
          openFiles.set(uri.fsPath.toLowerCase(), uri);
        }
      }
    }

    const activePath = active.fsPath.toLowerCase();
    // タブ情報からアクティブファイルを取得できない場合でも、開いているファイル自身をroot候補として扱う。
    // そのファイルがincludeしている子ファイルのツリーを表示できるよう、ここでは早期returnしない。

    // includeの推移的な到達関係を調べ、アクティブファイルの祖先だけを候補に残す
    const memo = new Map<string, boolean>();
    const reachesActive = async (uri: vscode.Uri, visiting: Set<string>): Promise<boolean> => {
      const key = uri.fsPath.toLowerCase();
      if (key === activePath) return true;
      if (visiting.has(key)) return false;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(key);
      for (const child of await this.readIncludes(uri)) {
        if (await reachesActive(child, nextVisiting)) {
          memo.set(key, true);
          return true;
        }
      }
      memo.set(key, false);
      return false;
    };

    const ancestors: vscode.Uri[] = [];
    for (const file of openFiles.values()) {
      if (file.fsPath.toLowerCase() !== activePath && (await reachesActive(file, new Set()))) {
        ancestors.push(file);
      }
    }

    // 候補同士で親子関係がある場合は最上位だけを表示し、ツリーで全構造を確認できるようにする
    const ancestorPaths = new Set(ancestors.map((uri) => uri.fsPath.toLowerCase()));
    const nested = new Set<string>();
    for (const file of ancestors) {
      for (const child of await this.readIncludes(file)) {
        if (ancestorPaths.has(child.fsPath.toLowerCase())) {
          nested.add(child.fsPath.toLowerCase());
        }
      }
    }
    const roots = ancestors
      .filter((file) => !nested.has(file.fsPath.toLowerCase()))
      .sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    // 選択中rootが現在のファイルを実際に含む場合だけ、そのrootを候補の先頭に維持する。
    // 無関係なrootを混ぜると、別ファイルのツリーが表示されるため到達関係を必ず確認する。
    if (this.selectedRootPath && fsSync.existsSync(this.selectedRootPath)) {
      const selected = vscode.Uri.file(this.selectedRootPath);
      if (await this.containsFile(selected, active, new Set())) {
        const selectedKey = this.pathKey(this.selectedRootPath);
        return [selected, ...roots.filter((root) => this.pathKey(root.fsPath) !== selectedKey)];
      }
    }
    // include祖先がないファイルは、そのファイル自身をrootにして子includeを表示する。
    return roots.length > 0 ? roots : [active];
  }

  private isPackageCachePath(uri: vscode.Uri): boolean {
    return /[\\/]Library[\\/]PackageCache[\\/]/i.test(uri.fsPath);
  }

  private async readIncludes(uri: vscode.Uri): Promise<vscode.Uri[]> {
    const cached = this.childrenCache.get(uri.fsPath);
    if (cached) {
      return cached;
    }
    let source = '';
    try {
      source = await fs.readFile(uri.fsPath, 'utf8');
    } catch {
      return [];
    }
    const result: vscode.Uri[] = [];
    const pattern = /^\s*#\s*include\s*[\"<]([^\">]+)[\">]/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const includePath = match[1].replace(/\\/g, path.sep);
      const candidates = [
        path.resolve(path.dirname(uri.fsPath), includePath),
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => path.resolve(folder.uri.fsPath, includePath)),
      ];

      // UnityプロジェクトのAssets配下などを開いている場合も、親ディレクトリを遡ってPackagesを探す。
      let parent = path.dirname(uri.fsPath);
      let projectRoot: string | undefined;
      while (true) {
        candidates.push(path.resolve(parent, includePath));
        if (fsSync.existsSync(path.join(parent, 'Assets')) && fsSync.existsSync(path.join(parent, 'ProjectSettings'))) {
          projectRoot = parent;
        }
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }

      // Packages配下のパッケージがLibrary/PackageCacheに実体を持つ場合も解決する。
      // Packages/com.example.foo/... を com.example.foo@version/... に対応付ける。
      if (projectRoot) {
        const packageMatch = includePath
          .replace(/\\/g, '/')
          .match(/^(?:Packages|Library\/PackageCache)\/([^/]+)\/(.*)$/i);
        if (packageMatch) {
          const packageName = packageMatch[1];
          const remainder = packageMatch[2];
          const packageCache = path.join(projectRoot, 'Library', 'PackageCache');
          try {
            for (const entry of fsSync.readdirSync(packageCache, { withFileTypes: true })) {
              if (entry.isDirectory() && (entry.name === packageName || entry.name.startsWith(`${packageName}@`))) {
                candidates.push(path.join(packageCache, entry.name, remainder));
              }
            }
          } catch {
            // PackageCacheが存在しないプロジェクトでは通常のinclude候補だけを使う。
          }
        }
      }
      const found = candidates.find((candidate) => {
        try {
          return fsSync.existsSync(candidate);
        } catch {
          return false;
        }
      });
      if (found && !result.some((item) => item.fsPath.toLowerCase() === found.toLowerCase())) {
        result.push(vscode.Uri.file(found));
      }
    }
    this.childrenCache.set(uri.fsPath, result);
    return result;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('urpShaderLab');
  const enabled = configuration.get<boolean>('enable', true);
  if (!enabled) {
    return;
  }

  await startLanguageClient(context);
  clientStarted = true;

  const includeTree = new IncludeTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('urpShaderLab.includeTree', includeTree));
  const savedRoot = context.globalState.get<string>('urpShaderLab.analysisRoot');
  if (savedRoot) {
    includeTree.setSelectedRoot(savedRoot);
    await setAnalysisRoot(savedRoot);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('urpShaderLab.refreshIncludeTree', () => includeTree.refresh()),
  );
  // タブの開閉や切り替えに合わせて root 候補を更新する
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => includeTree.refresh()));
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async () => {
      const nextRoot = await includeTree.reconcileActiveRoot();
      if (nextRoot) {
        await setAnalysisRoot(nextRoot);
        await context.globalState.update('urpShaderLab.analysisRoot', nextRoot);
      }
      includeTree.refresh();
    }),
  );
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => includeTree.refresh()));
  context.subscriptions.push(
    vscode.commands.registerCommand('urpShaderLab.selectAnalysisRoot', async (item?: IncludeTreeItem) => {
      const selected = item?.rootUri ?? item?.uri;
      if (!selected) {
        vscode.window.showWarningMessage('ツリーから解析rootを選択してください。');
        return;
      }
      includeTree.setSelectedRoot(selected.toString());
      await setAnalysisRoot(selected.toString());
      await context.globalState.update('urpShaderLab.analysisRoot', selected.toString());
      vscode.window.showInformationMessage(`解析rootを設定しました: ${path.basename(selected.fsPath)}`);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('urpShaderLab.clearAnalysisRoot', async () => {
      includeTree.setSelectedRoot(undefined);
      await setAnalysisRoot(undefined);
      await context.globalState.update('urpShaderLab.analysisRoot', undefined);
      vscode.window.showInformationMessage('解析rootの固定を解除しました。');
    }),
  );

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
