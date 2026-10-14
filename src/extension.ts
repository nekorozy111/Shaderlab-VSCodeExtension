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
  private readonly rootCache = new Map<string, { activePath: string; roots: vscode.Uri[] }>();
  private readonly projectRootCache = new Map<string, string | undefined>();
  private readonly packageCacheEntries = new Map<string, string[]>();
  private readonly maxChildrenCacheEntries = 512;
  private rootSearchGeneration = 0;
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
    const generation = ++this.rootSearchGeneration;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!active || active.scheme !== 'file') return undefined;
    const current = this.selectedRootPath;
    // 選択中rootの構成内への移動ならrootを維持する。無関係なファイルへ移動した場合は候補を再判定する。
    if (current && fsSync.existsSync(current)) {
      const currentUri = vscode.Uri.file(current);
      if (await this.containsFile(currentUri, active, new Set())) return undefined;
    }
    const roots = await this.findRoots();
    if (generation !== this.rootSearchGeneration) return undefined;
    const next = roots[0];
    if (next && (!current || this.pathKey(next.fsPath) !== this.pathKey(current))) {
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

  public refresh(invalidateIncludes = false): void {
    // 通常の表示更新ではinclude解析結果を再利用し、明示更新や保存時だけ無効化する。
    this.rootSearchGeneration++;
    this.rootCache.clear();
    if (invalidateIncludes) {
      this.childrenCache.clear();
      this.packageCacheEntries.clear();
      this.projectRootCache.clear();
    }
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
      const generation = this.rootSearchGeneration;
      const roots = await this.findRoots();
      if (generation !== this.rootSearchGeneration) return [];
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

  private removeComments(source: string): string {
    // コメント内のincludeを誤認しないよう、文字列リテラルを維持してコメントだけを空白化する。
    let result = '';
    let state: 'code' | 'line' | 'block' | 'string' = 'code';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < source.length; i++) {
      const current = source[i];
      const next = source[i + 1];
      if (state === 'line') {
        if (current === '\n') {
          result += '\n';
          state = 'code';
        } else {
          result += ' ';
        }
        continue;
      }
      if (state === 'block') {
        if (current === '*' && next === '/') {
          result += '  ';
          i++;
          state = 'code';
        } else {
          result += current === '\n' ? '\n' : ' ';
        }
        continue;
      }
      if (state === 'string') {
        result += current;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) state = 'code';
        continue;
      }
      if (current === '"' || current === "'") {
        quote = current;
        state = 'string';
        result += current;
      } else if (current === '/' && next === '/') {
        result += '  ';
        i++;
        state = 'line';
      } else if (current === '/' && next === '*') {
        result += '  ';
        i++;
        state = 'block';
      } else {
        result += current;
      }
    }
    return result;
  }

  private async findRoots(): Promise<vscode.Uri[]> {
    // 開いているタブに依存せず、ワークスペース内のソースからincludeグラフを構築する。
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!active || active.scheme !== 'file') return [];

    const extensions = new Set(['.shader', '.hlsl', '.hlsli', '.cginc', '.compute']);
    const excluded = new Set([
      '.git',
      '.svn',
      '.hg',
      'node_modules',
      'Library',
      'Temp',
      'Obj',
      'Logs',
      'Build',
      'Builds',
      '.vs',
    ]);
    const files = new Map<string, vscode.Uri>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const pending = [folder.uri.fsPath];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        let entries: import('fs').Dirent[];
        try {
          entries = (await fs.readdir(directory, { withFileTypes: true })) as import('fs').Dirent[];
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (excluded.has(entry.name)) continue;
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            pending.push(fullPath);
          } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
            files.set(this.pathKey(fullPath), vscode.Uri.file(fullPath));
          }
        }
      }
    }

    const activeKey = this.pathKey(active.fsPath);
    if (!files.has(activeKey)) files.set(activeKey, active);

    // 各ファイルが参照するincludeを一度ずつ解決し、参照先集合を作る。
    const referenced = new Set<string>();
    const graph = new Map<string, vscode.Uri[]>();
    await Promise.all(
      Array.from(files.values()).map(async (file) => {
        const children = await this.readIncludes(file);
        graph.set(this.pathKey(file.fsPath), children);
        for (const child of children) referenced.add(this.pathKey(child.fsPath));
      }),
    );

    // 他のソースから参照されていないファイルのうち、includeを持つものをroot候補にする。
    // これによりincludeファイル自体がrootとして重複表示されるのを抑制する。
    let roots = Array.from(files.values()).filter((file) => {
      const key = this.pathKey(file.fsPath);
      return !referenced.has(key) && (graph.get(key)?.length ?? 0) > 0;
    });

    // 現在のファイルがincludeグラフに属している場合は、その祖先rootだけに絞り込む。
    const reaches = async (root: vscode.Uri, targetKey: string, seen: Set<string>): Promise<boolean> => {
      const key = this.pathKey(root.fsPath);
      if (key === targetKey) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      for (const child of graph.get(key) ?? []) {
        if (await reaches(child, targetKey, seen)) return true;
      }
      return false;
    };
    const activeRoots: vscode.Uri[] = [];
    for (const root of roots) {
      if (await reaches(root, activeKey, new Set())) activeRoots.push(root);
    }

    if (activeRoots.length > 0) roots = activeRoots;
    else if (graph.get(activeKey)?.length) roots = [active];
    else {
      // アクティブファイルが別rootから参照されるincludeなら、そのrootを候補にする。
      const parents: vscode.Uri[] = [];
      for (const file of files.values()) {
        if (await reaches(file, activeKey, new Set())) parents.push(file);
      }
      roots = parents.length > 0 ? parents : [active];
    }

    // 選択中rootは、現在のファイルへ到達できる場合に限り先頭へ維持する。
    if (this.selectedRootPath && fsSync.existsSync(this.selectedRootPath)) {
      const selected = vscode.Uri.file(this.selectedRootPath);
      if (await reaches(selected, activeKey, new Set())) {
        roots = [selected, ...roots.filter((item) => this.pathKey(item.fsPath) !== this.pathKey(selected.fsPath))];
      }
    }

    roots.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    this.rootCache.set(activeKey, { activePath: activeKey, roots });
    return roots;
  }

  private isPackageCachePath(uri: vscode.Uri): boolean {
    return /[\\/]Library[\\/]PackageCache[\\/]/i.test(uri.fsPath);
  }

  private async readIncludes(uri: vscode.Uri): Promise<vscode.Uri[]> {
    const cacheKey = this.pathKey(uri.fsPath);
    const cached = this.childrenCache.get(cacheKey);
    if (cached) {
      // LRUとして最近使ったエントリーを末尾へ移動する。
      this.childrenCache.delete(cacheKey);
      this.childrenCache.set(cacheKey, cached);
      return cached;
    }
    let source = '';
    // 開いているファイルはディスクではなく、編集中の最新テキストを解析する。
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === 'file' && this.pathKey(document.uri.fsPath) === cacheKey,
    );
    if (openDocument) {
      source = openDocument.getText();
    } else {
      try {
        source = await fs.readFile(uri.fsPath, 'utf8');
      } catch {
        return [];
      }
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
      // Unityプロジェクトルートは同じディレクトリ階層について一度だけ探索する。
      const workspaceKey = (vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? parent).toLowerCase();
      if (this.projectRootCache.has(workspaceKey)) {
        projectRoot = this.projectRootCache.get(workspaceKey);
      } else {
        while (true) {
          if (
            fsSync.existsSync(path.join(parent, 'Assets')) &&
            fsSync.existsSync(path.join(parent, 'ProjectSettings'))
          ) {
            projectRoot = parent;
            break;
          }
          const next = path.dirname(parent);
          if (next === parent) break;
          parent = next;
        }
        this.projectRootCache.set(workspaceKey, projectRoot);
      }
      parent = path.dirname(uri.fsPath);
      while (true) {
        candidates.push(path.resolve(parent, includePath));
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
            const packageKey = packageCache.toLowerCase();
            let entries = this.packageCacheEntries.get(packageKey);
            if (!entries) {
              entries = fsSync
                .readdirSync(packageCache, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
              this.packageCacheEntries.set(packageKey, entries);
            }
            for (const entryName of entries) {
              if (entryName === packageName || entryName.startsWith(`${packageName}@`)) {
                candidates.push(path.join(packageCache, entryName, remainder));
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
    this.childrenCache.set(cacheKey, result);
    while (this.childrenCache.size > this.maxChildrenCacheEntries) {
      const oldestKey = this.childrenCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.childrenCache.delete(oldestKey);
    }
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
    vscode.commands.registerCommand('urpShaderLab.refreshIncludeTree', () => includeTree.refresh(true)),
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
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => includeTree.refresh(true)));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => includeTree.refresh(true)));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => includeTree.refresh(true)));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => includeTree.refresh(true)));
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
