import * as path from 'path';
import { pathToFileURL } from 'url';
import { ProjectRoot } from './projectRoot';
import { FileSystem } from './fileSystem';

export type IncludeSource = 'relative' | 'project' | 'packages' | 'packageCache' | 'absolute';
export interface IncludeResolution {
  includePath: string;
  resolvedPath: string;
  uri: string;
  source: IncludeSource;
}

export interface IncludeCompletionCandidate {
  includePath: string;
}

export class IncludeResolver {
  private readonly projectRoot: ProjectRoot;
  private readonly fileSystem: FileSystem;

  // Project include cache
  private readonly projectIncludeFiles = new Map<string, string>();
  // Package/PackageCache include cache
  private readonly packageIncludeFiles = new Map<string, string>();
  private readonly packageIncludePathToFile = new Map<string, string>();
  // Package name -> PackageCache
  private readonly packageDirectories = new Map<string, string>();

  // Directory -> direct include
  private readonly packageCompletionIndex = new Map<string, Set<string>>();
  // Project directory -> file
  private readonly projectDirectoryIndex = new Map<string, Set<string>>();

  private packageCacheInitialized = false;
  private projectIncludeCacheInitialized = false;
  private readonly resolutionCache = new Map<string, IncludeResolution | null>();
  private readonly maxResolutionCacheEntries = 4096;

  public constructor(projectRoot: ProjectRoot, fileSystem: FileSystem) {
    this.projectRoot = projectRoot;
    this.fileSystem = fileSystem;
  }

  public resolve(includePath: string, fromUri: string): IncludeResolution | undefined {
    const normalizedInclude = this.normalizeIncludePath(includePath);
    if (!normalizedInclude) {
      return undefined;
    }

    const fromPath = this.uriToPath(fromUri);
    if (!fromPath || !this.projectRoot.isInsideProject(fromPath)) {
      return undefined;
    }

    const cacheKey = `${fromUri}\0${normalizedInclude}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const result = this.resolveUncached(normalizedInclude, fromUri);
    this.setResolutionCache(cacheKey, result);
    return result;
  }

  public updateChangedFiles(changes: Array<{ uri: string; type: number }>): void {
    if (!this.projectRoot.isInitialized()) {
      return;
    }

    for (const change of changes) {
      const filePath = this.uriToPath(change.uri);
      if (!filePath || !this.projectRoot.isInsideProject(filePath)) {
        continue;
      }

      const normalizedPath = path.normalize(filePath);
      const type = change.type;

      if (this.isPackageCachePath(normalizedPath)) {
        this.updatePackageCacheFile(normalizedPath, type);
      } else if (this.isPackagePath(normalizedPath)) {
        this.updateProjectPackageFile(normalizedPath, type);
      } else if (this.isProjectIncludeFile(normalizedPath)) {
        this.updateProjectIncludeFile(normalizedPath, type);
      }

      this.invalidateResolutionEntriesForPath(normalizedPath, type);
    }
  }

  public invalidateProjectIncludeCache(): void {
    this.projectIncludeFiles.clear();
    this.packageIncludeFiles.clear();
    this.packageIncludePathToFile.clear();
    this.packageDirectories.clear();
    this.packageCompletionIndex.clear();
    this.projectDirectoryIndex.clear();
    this.packageCacheInitialized = false;
    this.projectIncludeCacheInitialized = false;
    this.resolutionCache.clear();
  }

  public getCompletionCandidates(includePath: string, fromUri: string): IncludeCompletionCandidate[] {
    const normalizedInclude = this.normalizeIncludePath(includePath);
    const root = this.projectRoot.getPath();
    const fromPath = this.uriToPath(fromUri);
    if (!root || !fromPath || !this.projectRoot.isInsideProject(fromPath)) {
      return [];
    }

    this.ensurePackageCacheInitialized(root);
    this.ensureProjectIncludeCacheInitialized(root);

    const candidates = new Map<string, IncludeCompletionCandidate>();

    // Packages/... , PackageCache/...
    this.collectPackageCompletionCandidates(normalizedInclude, candidates);

    const fromDirectory = path.dirname(fromPath);
    this.collectProjectCompletionCandidates(fromDirectory, normalizedInclude, candidates);

    return Array.from(candidates.values()).sort((a, b) => a.includePath.localeCompare(b.includePath));
  }

  private resolveUncached(normalizedInclude: string, fromUri: string): IncludeResolution | undefined {
    const fromPath = this.uriToPath(fromUri);
    if (!fromPath || !this.projectRoot.isInsideProject(fromPath)) {
      return undefined;
    }

    // ワークスペース内にある場合のみ許可する。
    if (path.isAbsolute(normalizedInclude)) {
      const absoluteResult = this.tryResolve(normalizedInclude, 'absolute', normalizedInclude);
      if (absoluteResult) {
        return absoluteResult;
      }
    }

    const fromDirectory = path.dirname(fromPath);
    const relativePath = path.resolve(fromDirectory, normalizedInclude);
    const relativeResult = this.tryResolve(relativePath, 'relative', normalizedInclude);
    if (relativeResult) {
      return relativeResult;
    }

    const projectResult = this.resolveFromProject(normalizedInclude);
    if (projectResult) {
      return projectResult;
    }

    const packagesResult = this.resolveFromPackages(normalizedInclude);
    if (packagesResult) {
      return packagesResult;
    }

    return this.resolveFromPackageCache(normalizedInclude);
  }

  private setResolutionCache(key: string, result: IncludeResolution | undefined): void {
    this.resolutionCache.set(key, result ?? null);
    while (this.resolutionCache.size > this.maxResolutionCacheEntries) {
      const oldestKey = this.resolutionCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.resolutionCache.delete(oldestKey);
    }
  }

  private invalidateResolutionEntriesForPath(filePath: string, type: number): void {
    const normalized = path.normalize(filePath);
    for (const [key, value] of this.resolutionCache) {
      if (value && path.normalize(value.resolvedPath) === normalized) {
        this.resolutionCache.delete(key);
        continue;
      }

      // 新規に作成されたファイルの影響で無効なキャッシュが有効となることがあるので対策する。
      if (!value && type === 1) {
        const separator = key.indexOf('\0');
        if (separator < 0) {
          continue;
        }
        const fromUri = key.substring(0, separator);
        const includePath = key.substring(separator + 1);
        const fromPath = this.uriToPath(fromUri);
        if (!fromPath) {
          continue;
        }
        if (this.isPotentialIncludeTarget(filePath, includePath, fromPath)) {
          this.resolutionCache.delete(key);
        }
      }
    }
  }

  private isPotentialIncludeTarget(filePath: string, includePath: string, fromPath: string): boolean {
    const normalized = path.normalize(filePath);
    const candidates = [
      path.resolve(path.dirname(fromPath), includePath),
      path.resolve(this.projectRoot.getPath() ?? '', includePath),
    ];

    if (includePath.startsWith('Packages/')) {
      const packageRelative = includePath.substring('Packages/'.length);
      candidates.push(path.resolve(this.projectRoot.getPath() ?? '', 'Packages', packageRelative));
    }

    return candidates.some((candidate) => path.normalize(candidate) === normalized);
  }

  private resolveFromProject(includePath: string): IncludeResolution | undefined {
    const root = this.projectRoot.getPath();
    if (!root || includePath.startsWith('Packages/')) {
      return undefined;
    }

    const candidate = path.resolve(root, includePath);
    return this.tryResolve(candidate, 'project', includePath);
  }

  private resolveFromPackages(includePath: string): IncludeResolution | undefined {
    const root = this.projectRoot.getPath();
    if (!root || !includePath.startsWith('Packages/')) {
      return undefined;
    }

    const normalized = includePath.substring('Packages/'.length);
    const candidate = path.resolve(root, 'Packages', normalized);
    return this.tryResolve(candidate, 'packages', includePath);
  }

  private resolveFromPackageCache(includePath: string): IncludeResolution | undefined {
    const root = this.projectRoot.getPath();
    if (!root || !includePath.startsWith('Packages/')) {
      return undefined;
    }

    this.ensurePackageCacheInitialized(root);
    const filePath = this.packageIncludePathToFile.get(includePath);
    if (!filePath) {
      return undefined;
    }

    return this.tryResolve(filePath, 'packageCache', includePath);
  }

  private tryResolve(filePath: string, source: IncludeSource, includePath: string): IncludeResolution | undefined {
    const normalizedPath = path.normalize(filePath);
    if (!this.projectRoot.isInsideProject(normalizedPath)) {
      return undefined;
    }
    if (!this.fileSystem.isFile(normalizedPath)) {
      return undefined;
    }

    return {
      includePath,
      resolvedPath: normalizedPath,
      uri: pathToFileURL(normalizedPath).toString(),
      source,
    };
  }

  private normalizeIncludePath(includePath: string): string {
    let result = includePath.trim();
    if (result.startsWith('"') && result.endsWith('"')) {
      result = result.substring(1, result.length - 1);
    }
    if (result.startsWith('<') && result.endsWith('>')) {
      result = result.substring(1, result.length - 1);
    }
    return result.replace(/\\/g, '/');
  }

  private collectPackageCompletionCandidates(
    includePath: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    const normalized = includePath.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    const slashIndex = lower.lastIndexOf('/');
    const parent = slashIndex >= 0 ? normalized.substring(0, slashIndex + 1) : '';
    const partial = slashIndex >= 0 ? lower.substring(slashIndex + 1) : lower;

    // トークンのみが指定された場合、キャッシュされたすべてのファイルではなく、ベースネームのインデックスのみを検索する。
    if (slashIndex < 0) {
      const seen = new Set<string>();
      for (const include of this.packageIncludeFiles.values()) {
        const base = path.posix.basename(include).toLowerCase();
        if (!base.startsWith(partial) || seen.has(include)) {
          continue;
        }
        seen.add(include);
        candidates.set(include, { includePath: include });
      }
      return;
    }

    const units = this.packageCompletionIndex.get(parent.toLowerCase());
    if (!units) {
      return;
    }

    for (const unit of units) {
      if (!unit.toLowerCase().startsWith(partial)) {
        continue;
      }
      const candidate = `${parent}${unit}`;
      if (candidate.endsWith('/')) {
        candidates.set(candidate, { includePath: candidate });
      } else {
        candidates.set(candidate, { includePath: candidate });
      }
    }
  }

  private collectProjectCompletionCandidates(
    fromDirectory: string,
    includePath: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    if (!this.projectRoot.isInsideProject(fromDirectory)) {
      return;
    }

    const normalizedPrefix = includePath.toLowerCase();
    const files = this.projectDirectoryIndex.get(path.normalize(fromDirectory));
    if (!files) {
      return;
    }

    if (!normalizedPrefix.includes('/')) {
      const normalizedFromDirectory = path.normalize(fromDirectory);
      for (const filePath of files) {
        const relative = path.relative(normalizedFromDirectory, path.normalize(filePath)).replace(/\\/g, '/');
        if (!relative || relative.includes('/') || relative === '..' || relative.startsWith('../')) {
          continue;
        }
        if (!relative.toLowerCase().startsWith(normalizedPrefix)) {
          continue;
        }
        candidates.set(relative, { includePath: relative });
      }
      return;
    }

    // パス補完：ディレクトリ解決後、子ディレクトリのみを検索
    const slashIndex = normalizedPrefix.lastIndexOf('/');
    const directoryPart = normalizedPrefix.substring(0, slashIndex + 1);
    const partial = normalizedPrefix.substring(slashIndex + 1);
    const targetDirectory = path.resolve(fromDirectory, directoryPart);
    if (!this.projectRoot.isInsideProject(targetDirectory)) {
      return;
    }

    const descendants = this.projectDirectoryIndex.get(path.normalize(targetDirectory));
    if (!descendants) {
      return;
    }

    for (const filePath of descendants) {
      const relative = path.relative(fromDirectory, filePath).replace(/\\/g, '/');
      if (!relative.toLowerCase().startsWith(normalizedPrefix)) {
        continue;
      }
      const candidate = relative;
      if (path.posix.basename(candidate).toLowerCase().startsWith(partial)) {
        candidates.set(candidate, { includePath: candidate });
      }
    }
  }

  private ensureProjectIncludeCacheInitialized(root: string): void {
    if (this.projectIncludeCacheInitialized) {
      return;
    }

    this.projectIncludeFiles.clear();
    this.projectDirectoryIndex.clear();

    const collect = (directoryPath: string): void => {
      if (!this.projectRoot.isInsideProject(directoryPath)) {
        return;
      }

      for (const entry of this.fileSystem.listDirectory(directoryPath)) {
        const entryPath = path.join(directoryPath, entry);
        if (this.fileSystem.isDirectory(entryPath)) {
          if (
            path.normalize(directoryPath) === path.normalize(root) &&
            (entry === 'Library' || entry === 'Packages' || entry === 'ProjectSettings')
          ) {
            continue;
          }
          collect(entryPath);
          continue;
        }

        if (!this.isIncludeFile(entryPath)) {
          continue;
        }

        const normalized = path.normalize(entryPath);
        this.projectIncludeFiles.set(normalized, normalized);
        this.addProjectFileToDirectoryIndex(normalized, root);
      }
    };

    collect(root);
    this.projectIncludeCacheInitialized = true;
  }

  private addProjectFileToDirectoryIndex(filePath: string, root: string): void {
    let directory = path.dirname(filePath);
    while (this.projectRoot.isInsideProject(directory)) {
      let files = this.projectDirectoryIndex.get(path.normalize(directory));
      if (!files) {
        files = new Set<string>();
        this.projectDirectoryIndex.set(path.normalize(directory), files);
      }
      files.add(filePath);

      if (path.normalize(directory) === path.normalize(root)) {
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }

  private removeProjectFileFromDirectoryIndex(filePath: string): void {
    for (const [directory, files] of this.projectDirectoryIndex) {
      if (!files.delete(filePath)) {
        continue;
      }
      if (files.size === 0) {
        this.projectDirectoryIndex.delete(directory);
      }
    }
  }

  private ensurePackageCacheInitialized(root: string): void {
    if (this.packageCacheInitialized) {
      return;
    }

    this.packageIncludeFiles.clear();
    this.packageIncludePathToFile.clear();
    this.packageDirectories.clear();
    this.packageCompletionIndex.clear();

    const packagesRoot = path.resolve(root, 'Packages');
    this.collectPackageFiles(packagesRoot, 'Packages/');

    const cacheRoot = path.resolve(root, 'Library', 'PackageCache');
    if (this.fileSystem.isDirectory(cacheRoot)) {
      for (const directoryName of this.fileSystem.listDirectory(cacheRoot)) {
        const packageDirectory = path.join(cacheRoot, directoryName);
        if (!this.fileSystem.isDirectory(packageDirectory)) {
          continue;
        }
        const atIndex = directoryName.indexOf('@');
        if (atIndex <= 0) {
          continue;
        }
        const packageName = directoryName.substring(0, atIndex);
        if (!this.packageDirectories.has(packageName)) {
          this.packageDirectories.set(packageName, packageDirectory);
        }
        this.collectPackageFiles(packageDirectory, `Packages/${packageName}/`);
      }
    }

    this.packageCacheInitialized = true;
  }

  private collectPackageFiles(directoryPath: string, includeBasePath: string): void {
    if (!this.projectRoot.isInsideProject(directoryPath) || !this.fileSystem.isDirectory(directoryPath)) {
      return;
    }

    for (const entry of this.fileSystem.listDirectory(directoryPath)) {
      const entryPath = path.join(directoryPath, entry);
      if (this.fileSystem.isDirectory(entryPath)) {
        this.collectPackageFiles(entryPath, `${includeBasePath}${entry}/`);
        continue;
      }
      if (!this.isIncludeFile(entryPath)) {
        continue;
      }

      const includePath = `${includeBasePath}${entry}`.replace(/\\/g, '/');
      this.addPackageIncludeFile(path.normalize(entryPath), includePath);
    }
  }

  private addPackageIncludeFile(filePath: string, includePath: string): void {
    const normalizedPath = path.normalize(filePath);
    const previous = this.packageIncludeFiles.get(normalizedPath);
    if (previous && previous !== includePath) {
      this.removeCompletionIndex(previous);
      this.packageIncludePathToFile.delete(previous);
    }
    this.packageIncludeFiles.set(normalizedPath, includePath);
    this.packageIncludePathToFile.set(includePath, normalizedPath);
    this.addCompletionIndex(includePath);
  }

  private removePackageIncludeFile(filePath: string): void {
    const normalized = path.normalize(filePath);
    const includePath = this.packageIncludeFiles.get(normalized);
    if (!includePath) {
      return;
    }
    this.packageIncludeFiles.delete(normalized);
    this.packageIncludePathToFile.delete(includePath);
    this.removeCompletionIndex(includePath);
  }

  private addCompletionIndex(includePath: string): void {
    const normalized = includePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const fileName = parts.pop();
    if (!fileName) {
      return;
    }

    let parent = '';
    for (const part of parts) {
      const unit = `${part}/`;
      const parentKey = parent.toLowerCase();
      let units = this.packageCompletionIndex.get(parentKey);
      if (!units) {
        units = new Set<string>();
        this.packageCompletionIndex.set(parentKey, units);
      }
      units.add(unit);
      parent += unit;
    }

    const leafParentKey = parent.toLowerCase();
    let units = this.packageCompletionIndex.get(leafParentKey);
    if (!units) {
      units = new Set<string>();
      this.packageCompletionIndex.set(leafParentKey, units);
    }
    units.add(fileName);
  }

  private removeCompletionIndex(includePath: string): void {
    // 編集を受けたパッケージインデックスを再構築する
    const normalized = includePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const fileName = parts.pop();
    if (!fileName) {
      return;
    }

    const parents: string[] = [''];
    let current = '';
    for (const part of parts) {
      current += `${part}/`;
      parents.push(current);
    }

    const leafParent = parents[parents.length - 1];
    const leaf = this.packageCompletionIndex.get(leafParent.toLowerCase());
    if (leaf) {
      leaf.delete(fileName);
      if (leaf.size === 0) {
        this.packageCompletionIndex.delete(leafParent.toLowerCase());
      }
    }

    // そのディレクトリの下にキャッシュされたファイルが一切残っていない場合にのみ、ディレクトリ単位で削除する。
    for (let i = parents.length - 2; i >= 0; i--) {
      const parent = parents[i];
      const unit = parts[i] + '/';
      const units = this.packageCompletionIndex.get(parent.toLowerCase());
      if (!units || !units.has(unit)) {
        continue;
      }
      const prefix = `${parent}${unit}`;
      let stillExists = false;
      for (const cachedInclude of this.packageIncludeFiles.values()) {
        if (cachedInclude.startsWith(prefix)) {
          stillExists = true;
          break;
        }
      }
      if (!stillExists) {
        units.delete(unit);
        if (units.size === 0) {
          this.packageCompletionIndex.delete(parent.toLowerCase());
        }
      }
    }
  }

  private updatePackageCacheFile(filePath: string, type: number): void {
    if (!this.packageCacheInitialized) {
      return;
    }

    const cacheRoot = path.resolve(this.projectRoot.getPath() ?? '', 'Library', 'PackageCache');
    const relative = path.relative(cacheRoot, filePath);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return;
    }

    const parts = relative.split(path.sep);
    const packageDirectoryName = parts.shift();
    if (!packageDirectoryName) {
      return;
    }

    const packageDirectory = path.join(cacheRoot, packageDirectoryName);
    const atIndex = packageDirectoryName.indexOf('@');
    if (atIndex <= 0) {
      return;
    }
    const packageName = packageDirectoryName.substring(0, atIndex);
    if (parts.length === 0) {
      if (type === 3) {
        this.removePackageEntriesUnderPath(packageDirectory);
        if (this.packageDirectories.get(packageName) === packageDirectory) {
          this.packageDirectories.delete(packageName);
          this.selectPackageDirectory(packageName, cacheRoot);
        }
      } else if (type === 1 || type === 2) {
        this.packageDirectories.set(packageName, packageDirectory);
        this.collectPackageFiles(packageDirectory, `Packages/${packageName}/`);
      }
      return;
    }

    const includePath = `Packages/${packageName}/${parts.join('/')}`.replace(/\\/g, '/');

    if (type === 3 || !this.isIncludeFile(filePath)) {
      this.removePackageIncludeFile(filePath);
    } else if (type === 1 || type === 2) {
      this.addPackageIncludeFile(filePath, includePath);
    }

    if (type === 3 && parts.length === 1) {
      const current = this.packageDirectories.get(packageName);
      if (current && path.normalize(current) === path.normalize(packageDirectory)) {
        this.packageDirectories.delete(packageName);
        this.selectPackageDirectory(packageName, cacheRoot);
      }
    } else if (type !== 3 && !this.packageDirectories.has(packageName)) {
      this.packageDirectories.set(packageName, packageDirectory);
    }
  }

  private removePackageEntriesUnderPath(directoryPath: string): void {
    const normalizedDirectory = path.normalize(directoryPath) + path.sep;
    for (const filePath of Array.from(this.packageIncludeFiles.keys())) {
      if (filePath.startsWith(normalizedDirectory)) {
        this.removePackageIncludeFile(filePath);
      }
    }
  }

  private selectPackageDirectory(packageName: string, cacheRoot: string): void {
    for (const entry of this.fileSystem.listDirectory(cacheRoot)) {
      if (!entry.startsWith(`${packageName}@`)) {
        continue;
      }
      const candidate = path.join(cacheRoot, entry);
      if (this.fileSystem.isDirectory(candidate)) {
        this.packageDirectories.set(packageName, candidate);
        return;
      }
    }
  }

  private updateProjectPackageFile(filePath: string, type: number): void {
    if (!this.packageCacheInitialized) {
      return;
    }
    if (type === 3 || !this.isIncludeFile(filePath)) {
      this.removePackageIncludeFile(filePath);
      return;
    }
    const root = this.projectRoot.getPath();
    if (!root) {
      return;
    }
    const relative = path.relative(root, filePath).replace(/\\/g, '/');
    this.addPackageIncludeFile(filePath, relative);
  }

  private updateProjectIncludeFile(filePath: string, type: number): void {
    if (!this.projectIncludeCacheInitialized) {
      return;
    }
    const normalized = path.normalize(filePath);
    if (type === 3 || !this.isIncludeFile(filePath)) {
      if (this.projectIncludeFiles.delete(normalized)) {
        this.removeProjectFileFromDirectoryIndex(normalized);
      }
      return;
    }

    this.projectIncludeFiles.set(normalized, normalized);
    this.removeProjectFileFromDirectoryIndex(normalized);
    this.addProjectFileToDirectoryIndex(normalized, this.projectRoot.getPath() ?? path.dirname(normalized));
  }

  private isPackageCachePath(filePath: string): boolean {
    const root = this.projectRoot.getPath();
    return (
      !!root &&
      this.projectRoot.isInsideProject(filePath) &&
      path.normalize(filePath).startsWith(path.normalize(path.resolve(root, 'Library', 'PackageCache')) + path.sep)
    );
  }

  private isPackagePath(filePath: string): boolean {
    const root = this.projectRoot.getPath();
    return !!root && path.normalize(filePath).startsWith(path.normalize(path.resolve(root, 'Packages')) + path.sep);
  }

  private isProjectIncludeFile(filePath: string): boolean {
    const root = this.projectRoot.getPath();
    if (!root || !this.isIncludeFile(filePath)) {
      return false;
    }
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return false;
    }
    const first = relative.split(path.sep)[0];
    return first !== 'Library' && first !== 'Packages' && first !== 'ProjectSettings';
  }

  private isIncludeFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      lower.endsWith('.hlsl') || lower.endsWith('.hlsli') || lower.endsWith('.cginc') || lower.endsWith('.compute')
    );
  }

  private uriToPath(uri: string): string | undefined {
    if (!uri.startsWith('file://')) {
      return undefined;
    }
    try {
      const decoded = decodeURIComponent(uri.substring('file://'.length));
      if (/^\/[A-Za-z]:\//.test(decoded)) {
        return decoded.substring(1);
      }
      return decoded;
    } catch {
      return undefined;
    }
  }
}
