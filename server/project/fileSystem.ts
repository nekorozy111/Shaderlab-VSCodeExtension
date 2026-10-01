import * as fs from 'fs';
import * as path from 'path';

type CachedStat = {
  kind: 'file' | 'directory' | 'missing';
  expiresAt: number;
};

export class FileSystem {
  // Language Serverのリクエスト中に同じパスを何度もstatしないための短期キャッシュ。
  private readonly statCache = new Map<string, CachedStat>();
  private readonly directoryCache = new Map<string, { entries: string[]; expiresAt: number }>();
  private readonly cacheTtlMs = 500;
  private readonly maxStatCacheEntries = 4096;
  private readonly maxDirectoryCacheEntries = 512;

  public exists(filePath: string): boolean {
    return this.getStatKind(filePath) !== 'missing';
  }

  public isFile(filePath: string): boolean {
    return this.getStatKind(filePath) === 'file';
  }

  public isDirectory(filePath: string): boolean {
    return this.getStatKind(filePath) === 'directory';
  }

  public readText(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  public async readTextAsync(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  public async isDirectoryAsync(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(path.normalize(filePath));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  public async isFileAsync(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(path.normalize(filePath));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  public listDirectory(directoryPath: string): string[] {
    const normalized = path.normalize(directoryPath);
    const now = Date.now();
    const cached = this.directoryCache.get(normalized);
    if (cached && cached.expiresAt > now) {
      this.directoryCache.delete(normalized);
      this.directoryCache.set(normalized, cached);
      return cached.entries;
    }
    if (cached) {
      this.directoryCache.delete(normalized);
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(normalized);
    } catch {
      entries = [];
    }
    this.setDirectoryCache(normalized, entries, now + this.cacheTtlMs);
    return entries;
  }

  /**
   * 大きなディレクトリ走査をイベントループから切り離すための非同期列挙。
   */
  public async listDirectoryEntriesAsync(directoryPath: string): Promise<fs.Dirent[]> {
    try {
      return await fs.promises.readdir(path.normalize(directoryPath), { withFileTypes: true });
    } catch {
      return [];
    }
  }

  public async findDirectoryAsync(parentDirectory: string, prefix: string): Promise<string | undefined> {
    try {
      const entries = await fs.promises.readdir(path.normalize(parentDirectory), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.startsWith(prefix) || !entry.isDirectory()) {
          continue;
        }
        return path.join(parentDirectory, entry.name);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  public findDirectory(parentDirectory: string, prefix: string): string | undefined {
    if (!this.isDirectory(parentDirectory)) {
      return undefined;
    }

    const entries = this.listDirectory(parentDirectory);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }

      const candidate = path.join(parentDirectory, entry);
      if (this.isDirectory(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  public findFile(parentDirectory: string, fileName: string): string | undefined {
    const candidate = path.join(parentDirectory, fileName);
    if (this.isFile(candidate)) {
      return candidate;
    }

    return undefined;
  }

  /**
   * File Watcherから変更を受けたとき、該当パスと親ディレクトリの短期キャッシュを破棄する。
   */
  public invalidate(filePath: string): void {
    const normalized = path.normalize(filePath);
    this.statCache.delete(normalized);
    this.statCache.delete(path.normalize(path.dirname(normalized)));
    this.directoryCache.delete(path.normalize(path.dirname(normalized)));
    this.directoryCache.delete(normalized);
  }

  public clearCache(): void {
    this.statCache.clear();
    this.directoryCache.clear();
  }

  public getCacheStats(): { statEntries: number; directoryEntries: number } {
    return {
      statEntries: this.statCache.size,
      directoryEntries: this.directoryCache.size,
    };
  }

  private getStatKind(filePath: string): CachedStat['kind'] {
    const normalized = path.normalize(filePath);
    const now = Date.now();
    const cached = this.statCache.get(normalized);
    if (cached && cached.expiresAt > now) {
      this.statCache.delete(normalized);
      this.statCache.set(normalized, cached);
      return cached.kind;
    }
    if (cached) {
      this.statCache.delete(normalized);
    }

    let kind: CachedStat['kind'] = 'missing';
    try {
      const stat = fs.statSync(normalized);
      kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'missing';
    } catch {
      kind = 'missing';
    }

    this.statCache.set(normalized, {
      kind,
      expiresAt: now + this.cacheTtlMs,
    });
    while (this.statCache.size > this.maxStatCacheEntries) {
      const oldest = this.statCache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.statCache.delete(oldest);
    }
    return kind;
  }

  private setDirectoryCache(directoryPath: string, entries: string[], expiresAt: number): void {
    this.directoryCache.delete(directoryPath);
    this.directoryCache.set(directoryPath, { entries, expiresAt });
    while (this.directoryCache.size > this.maxDirectoryCacheEntries) {
      const oldest = this.directoryCache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.directoryCache.delete(oldest);
    }
  }
}
