import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { InitializeParams } from 'vscode-languageserver/node';

export class ProjectRoot {
  private rootPath: string | undefined;
  private realRootPath: string | undefined;
  private readonly realPathCache = new Map<string, string | undefined>();
  private readonly insideProjectCache = new Map<string, boolean>();
  private readonly maxRealPathCacheEntries = 2048;
  private readonly maxInsideProjectCacheEntries = 4096;

  public initialize(params: InitializeParams): void {
    const workspaceFolders = params.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.setRoot(this.uriToPath(workspaceFolders[0].uri));
      return;
    }

    if (params.rootUri) {
      this.setRoot(this.uriToPath(params.rootUri));
      return;
    }

    this.rootPath = undefined;
    this.realRootPath = undefined;
    this.realPathCache.clear();
    this.insideProjectCache.clear();
  }

  public getPath(): string | undefined {
    return this.rootPath;
  }

  public isInitialized(): boolean {
    return this.rootPath !== undefined;
  }

  public resolve(...segments: string[]): string | undefined {
    if (!this.rootPath) {
      return undefined;
    }
    return path.resolve(this.rootPath, ...segments);
  }

  public async isInsideProjectAsync(filePath: string): Promise<boolean> {
    if (!this.rootPath) return false;
    const normalizedFilePath = path.resolve(filePath);
    const cached = this.insideProjectCache.get(normalizedFilePath);
    if (cached !== undefined) return cached;

    const root = path.resolve(this.realRootPath ?? this.rootPath);
    const lexicalRoot = path.resolve(this.rootPath);
    const lexicalRelative = path.relative(lexicalRoot, normalizedFilePath);
    if (lexicalRelative.startsWith('..' + path.sep) || lexicalRelative === '..' || path.isAbsolute(lexicalRelative)) {
      this.setInsideProjectCache(normalizedFilePath, false);
      return false;
    }

    const target = await this.realPathForCheckAsync(normalizedFilePath);
    if (!target) {
      this.setInsideProjectCache(normalizedFilePath, false);
      return false;
    }
    const relative = path.relative(root, target);
    const result = relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    this.setInsideProjectCache(normalizedFilePath, result);
    return result;
  }

  public isInsideProject(filePath: string): boolean {
    if (!this.rootPath) {
      return false;
    }

    const normalizedFilePath = path.resolve(filePath);
    const cached = this.insideProjectCache.get(normalizedFilePath);
    if (cached !== undefined) {
      return cached;
    }

    const root = path.resolve(this.realRootPath ?? this.rootPath);
    const lexicalRoot = path.resolve(this.rootPath);
    const lexicalRelative = path.relative(lexicalRoot, normalizedFilePath);
    if (lexicalRelative.startsWith('..' + path.sep) || lexicalRelative === '..' || path.isAbsolute(lexicalRelative)) {
      this.setInsideProjectCache(normalizedFilePath, false);
      return false;
    }

    const target = this.realPathForCheck(normalizedFilePath);
    if (!target) {
      this.setInsideProjectCache(normalizedFilePath, false);
      return false;
    }

    const relative = path.relative(root, target);
    const result =
      relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    this.setInsideProjectCache(normalizedFilePath, result);
    return result;
  }

  private setInsideProjectCache(filePath: string, value: boolean): void {
    this.insideProjectCache.set(filePath, value);
    while (this.insideProjectCache.size > this.maxInsideProjectCacheEntries) {
      const oldest = this.insideProjectCache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.insideProjectCache.delete(oldest);
    }
  }

  /**
   * ファイル監視イベントに合わせて、変更経路に依存するrealpath判定を無効化する。
   */
  public invalidatePath(filePath: string): void {
    const normalized = path.resolve(filePath);
    const prefixes = [normalized + path.sep];

    for (const key of this.realPathCache.keys()) {
      if (key === normalized || prefixes.some((prefix) => key.startsWith(prefix))) {
        this.realPathCache.delete(key);
      }
    }
    for (const key of this.insideProjectCache.keys()) {
      if (key === normalized || prefixes.some((prefix) => key.startsWith(prefix))) {
        this.insideProjectCache.delete(key);
      }
    }
  }

  public toRelativePath(filePath: string): string | undefined {
    if (!this.rootPath) {
      return undefined;
    }
    return path.relative(this.rootPath, filePath);
  }

  private setRoot(rootPath: string): void {
    this.realPathCache.clear();
    this.insideProjectCache.clear();
    this.rootPath = path.resolve(rootPath);
    try {
      this.realRootPath = fs.realpathSync(this.rootPath);
    } catch {
      this.realRootPath = this.rootPath;
    }
  }

  private async realPathForCheckAsync(filePath: string): Promise<string | undefined> {
    const normalized = path.resolve(filePath);
    if (this.realPathCache.has(normalized)) return this.realPathCache.get(normalized);

    let result: string | undefined;
    try {
      result = await fs.promises.realpath(normalized);
    } catch {
      let current = normalized;
      while (current !== path.dirname(current)) {
        try {
          const realParent = await fs.promises.realpath(current);
          result = path.resolve(realParent, path.relative(current, normalized));
          break;
        } catch {
          current = path.dirname(current);
        }
      }
    }
    this.realPathCache.set(normalized, result);
    while (this.realPathCache.size > this.maxRealPathCacheEntries) {
      const oldest = this.realPathCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.realPathCache.delete(oldest);
    }
    return result;
  }

  private realPathForCheck(filePath: string): string | undefined {
    const normalized = path.resolve(filePath);
    if (this.realPathCache.has(normalized)) {
      return this.realPathCache.get(normalized);
    }

    let result: string | undefined;
    try {
      result = fs.realpathSync(normalized);
    } catch {
      // まだ作成されていないファイルについては、最も近い既存の親ファイルを特定し、外部パスは使用しない
      let current = normalized;
      while (current !== path.dirname(current)) {
        try {
          const realParent = fs.realpathSync(current);
          result = path.resolve(realParent, path.relative(current, normalized));
          break;
        } catch {
          current = path.dirname(current);
        }
      }
      // 最も近い既存の親ノードの結果を保持する
    }

    this.realPathCache.set(normalized, result);
    while (this.realPathCache.size > this.maxRealPathCacheEntries) {
      const oldest = this.realPathCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.realPathCache.delete(oldest);
    }
    return result;
  }

  private uriToPath(uri: string): string {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri);
    }
    return uri;
  }
}
