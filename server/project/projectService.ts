import { IncludeResolution, IncludeResolver } from './includeResolver';
import { FileSystem } from './fileSystem';
import { ProjectRoot } from './projectRoot';
import * as path from 'path';
import { pathToFileURL } from 'url';

export class ProjectService {
  private readonly projectRoot = new ProjectRoot();
  private readonly fileSystem = new FileSystem();
  public readonly includeResolver = new IncludeResolver(this.projectRoot, this.fileSystem);

  public initialize(params: Parameters<ProjectRoot['initialize']>[0]): void {
    this.projectRoot.initialize(params);
  }

  /**
   * プロジェクト内のシェーダーソースを列挙する。
   * ディレクトリを逐次走査し、生成物や依存パッケージの巨大なキャッシュを避ける。
   */
  public async listProjectSourceUris(): Promise<string[]> {
    const root = this.projectRoot.getPath();
    if (!root) {
      return [];
    }

    const extensions = new Set(['.shader', '.hlsl', '.hlsli', '.compute', '.cginc']);
    const excludedDirectories = new Set([
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
    const results: string[] = [];
    const pending: string[] = [root];

    while (pending.length > 0) {
      const directory = pending.pop()!;
      const entries = await this.fileSystem.listDirectoryEntriesAsync(directory);
      for (const entry of entries) {
        if (entry.name.startsWith('.') && excludedDirectories.has(entry.name)) {
          continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excludedDirectories.has(entry.name)) {
            pending.push(fullPath);
          }
          continue;
        }
        if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          results.push(pathToFileURL(fullPath).toString());
        }
      }
    }

    return results;
  }

  public getRootPath(): string | undefined {
    return this.projectRoot.getPath();
  }

  public isInsideProject(filePath: string): boolean {
    return this.projectRoot.isInsideProject(filePath);
  }

  public resolveInclude(includePath: string, fromUri: string): Promise<IncludeResolution | undefined> {
    return this.includeResolver.resolve(includePath, fromUri);
  }

  public updateChangedIncludeFiles(changes: Array<{ uri: string; type: number }>): void {
    this.includeResolver.updateChangedFiles(changes);
  }

  public invalidateIncludeCache(): void {
    this.includeResolver.invalidateProjectIncludeCache();
  }

  public readFile(filePath: string): string | undefined {
    if (!this.projectRoot.isInsideProject(filePath)) {
      return undefined;
    }
    return this.fileSystem.readText(filePath);
  }

  public async readFileAsync(filePath: string): Promise<string | undefined> {
    // LSPのイベントループをブロックしないよう、プロジェクト判定も非同期化する。
    if (!(await this.projectRoot.isInsideProjectAsync(filePath))) {
      return undefined;
    }
    return this.fileSystem.readTextAsync(filePath);
  }

  public exists(filePath: string): boolean {
    if (!this.projectRoot.isInsideProject(filePath)) {
      return false;
    }
    return this.fileSystem.exists(filePath);
  }

  public getFileSystemCacheStats(): { statEntries: number; directoryEntries: number } {
    return this.fileSystem.getCacheStats();
  }
}
