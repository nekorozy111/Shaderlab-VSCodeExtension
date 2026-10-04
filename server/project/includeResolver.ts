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

  // Package/PackageCache include cache
  private readonly packageIncludeFiles = new Map<string, string>();
  private readonly packageIncludePathToFile = new Map<string, string>();
  // Package name -> PackageCache
  private readonly packageDirectories = new Map<string, string>();
  /**
   * URP ShaderLab編集で直接必要になるUnity SRPパッケージだけを補完用に索引する。
   * VFX GraphやHDRP等は明示的にincludeされた場合だけ個別解決し、全体索引には含めない。
   */
  private readonly relevantPackageNames = new Set<string>([
    'com.unity.render-pipelines.core',
    'com.unity.render-pipelines.universal',
  ]);

  // Directory -> direct include
  private readonly packageCompletionIndex = new Map<string, Set<string>>();
  // Package補完インデックスがPackage構造の増加で無制限に膨らまないようにする。
  private readonly maxPackageCompletionIndexEntries = 1024;
  // パッケージ全体を再帰走査した結果。unqualified include補完で再利用する。
  private readonly packageRecursiveCompletionCache = new Map<string, string[]>();
  private readonly maxPackageRecursiveCompletionCacheEntries = 4;
  // 同一パッケージの再帰走査を同時に開始しない。
  private readonly pendingPackageRecursiveCompletionCache = new Map<string, Promise<string[]>>();
  // 非同期Package走査の世代。無効化後に古い結果を再登録しない。
  private packageCompletionGeneration = 0;
  // Project directory -> file
  private readonly projectDirectoryIndex = new Map<string, Set<string>>();
  private readonly indexedProjectDirectories = new Set<string>();
  private readonly maxProjectDirectoryIndexEntries = 256;

  private readonly resolutionCache = new Map<string, IncludeResolution | null>();
  private readonly maxResolutionCacheEntries = 4096;

  public constructor(projectRoot: ProjectRoot, fileSystem: FileSystem) {
    this.projectRoot = projectRoot;
    this.fileSystem = fileSystem;
  }

  public warmUp(): void {
    /*
     * PackageCache全体の先行走査は行わない。
     * include解決と補完は必要になったパッケージ/ディレクトリだけ遅延索引する。
     */
  }

  public async resolve(includePath: string, fromUri: string): Promise<IncludeResolution | undefined> {
    const normalizedInclude = this.normalizeIncludePath(includePath);
    if (!normalizedInclude) {
      return undefined;
    }

    const fromPath = this.uriToPath(fromUri);
    if (!fromPath || !(await this.projectRoot.isInsideProjectAsync(fromPath))) {
      return undefined;
    }

    const cacheKey = `${fromUri}\0${normalizedInclude}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const result = await this.resolveUncached(normalizedInclude, fromUri);
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
      this.projectRoot.invalidatePath(normalizedPath);
      this.fileSystem.invalidate(normalizedPath);

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
    this.fileSystem.clearCache();
    this.packageIncludeFiles.clear();
    this.packageIncludePathToFile.clear();
    this.packageDirectories.clear();
    this.packageCompletionIndex.clear();
    this.packageRecursiveCompletionCache.clear();
    this.packageCompletionGeneration++;
    this.pendingPackageRecursiveCompletionCache.clear();
    this.projectDirectoryIndex.clear();
    this.indexedProjectDirectories.clear();
    this.resolutionCache.clear();
  }

  public async getCompletionCandidates(includePath: string, fromUri: string): Promise<IncludeCompletionCandidate[]> {
    const normalizedInclude = this.normalizeIncludePath(includePath);
    const root = this.projectRoot.getPath();
    const fromPath = this.uriToPath(fromUri);
    if (!root || !fromPath || !(await this.projectRoot.isInsideProjectAsync(fromPath))) {
      return [];
    }

    const candidates = new Map<string, IncludeCompletionCandidate>();

    // Packages/... , PackageCache/...
    await this.collectPackageCompletionCandidates(normalizedInclude, candidates);

    const fromDirectory = path.dirname(fromPath);
    await this.collectProjectCompletionCandidates(fromDirectory, normalizedInclude, candidates);

    return Array.from(candidates.values()).sort((a, b) => a.includePath.localeCompare(b.includePath));
  }

  private async resolveUncached(normalizedInclude: string, fromUri: string): Promise<IncludeResolution | undefined> {
    const fromPath = this.uriToPath(fromUri);
    if (!fromPath || !(await this.projectRoot.isInsideProjectAsync(fromPath))) {
      return undefined;
    }

    // ワークスペース内にある場合のみ許可する。
    if (path.isAbsolute(normalizedInclude)) {
      const absoluteResult = await this.tryResolve(normalizedInclude, 'absolute', normalizedInclude);
      if (absoluteResult) {
        return absoluteResult;
      }
    }

    const fromDirectory = path.dirname(fromPath);
    const isRelativeInclude =
      normalizedInclude === '.' ||
      normalizedInclude === '..' ||
      normalizedInclude.startsWith('./') ||
      normalizedInclude.startsWith('../');
    const relativePath = path.resolve(fromDirectory, normalizedInclude);
    if (isRelativeInclude && !this.isInsideAssets(relativePath)) {
      return undefined;
    }
    const relativeResult = await this.tryResolve(relativePath, 'relative', normalizedInclude);
    if (relativeResult) {
      return relativeResult;
    }

    const projectResult = await this.resolveFromProject(normalizedInclude);
    if (projectResult) {
      return projectResult;
    }

    const packagesResult = await this.resolveFromPackages(normalizedInclude);
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

  private async resolveFromProject(includePath: string): Promise<IncludeResolution | undefined> {
    const root = this.projectRoot.getPath();
    if (!root || includePath.startsWith('Packages/')) {
      return undefined;
    }

    const candidate = path.resolve(root, includePath);
    return this.tryResolve(candidate, 'project', includePath);
  }

  private async resolveFromPackages(includePath: string): Promise<IncludeResolution | undefined> {
    const root = this.projectRoot.getPath();
    if (!root || !includePath.startsWith('Packages/')) {
      return undefined;
    }

    const normalized = includePath.substring('Packages/'.length);
    const candidate = path.resolve(root, 'Packages', normalized);
    return this.tryResolve(candidate, 'packages', includePath);
  }

  private async resolveFromPackageCache(includePath: string): Promise<IncludeResolution | undefined> {
    const root = this.projectRoot.getPath();
    if (!root || !includePath.startsWith('Packages/')) {
      return undefined;
    }

    const cachedFilePath = this.packageIncludePathToFile.get(includePath);
    if (cachedFilePath) {
      return this.tryResolve(cachedFilePath, 'packageCache', includePath);
    }

    const relative = includePath.substring('Packages/'.length);
    const separator = relative.indexOf('/');
    const packageName = separator >= 0 ? relative.substring(0, separator) : relative;
    if (!packageName) {
      return undefined;
    }

    const packageDirectory = await this.getPackageCacheDirectory(packageName, root);
    if (!packageDirectory) {
      return undefined;
    }

    const packageRelative = separator >= 0 ? relative.substring(separator + 1) : '';
    if (!packageRelative) {
      return undefined;
    }

    return this.tryResolve(path.resolve(packageDirectory, packageRelative), 'packageCache', includePath);
  }

  private async tryResolve(
    filePath: string,
    source: IncludeSource,
    includePath: string,
  ): Promise<IncludeResolution | undefined> {
    const normalizedPath = path.normalize(filePath);
    if (!(await this.projectRoot.isInsideProjectAsync(normalizedPath))) {
      return undefined;
    }
    if (!(await this.fileSystem.isFileAsync(normalizedPath))) {
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

  private async collectPackageCompletionCandidates(
    includePath: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): Promise<void> {
    const normalized = includePath.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    const packagesPrefix = 'packages/';

    if (!lower.startsWith(packagesPrefix)) {
      // Core.hlslのようにパッケージ接頭辞を省略したincludeでは、
      // URP Core/Universalだけを必要時に探索する。空入力では全走査しない。
      if (lower.length > 0) {
        await this.collectRelevantPackageFileCandidates(lower, candidates);
      }
      return;
    }

    const relative = normalized.substring(packagesPrefix.length);
    const slashIndex = relative.indexOf('/');

    // Packages/ の直下では、URP ShaderLabに必要なパッケージだけを候補にする。
    if (slashIndex < 0) {
      const partial = relative.toLowerCase();
      await this.collectRelevantPackageDirectories(partial, candidates);
      if (partial.length > 0) {
        await this.collectRelevantPackageFileCandidates(partial, candidates);
      }
      return;
    }

    const packageName = relative.substring(0, slashIndex);
    if (!this.isRelevantPackage(packageName)) {
      // VFX Graph/HDRP等は全体索引に含めず、明示的includeの解決だけを許可する。
      return;
    }

    const parent = `Packages/${relative.substring(0, relative.lastIndexOf('/') + 1)}`;
    const partial = relative.substring(relative.lastIndexOf('/') + 1).toLowerCase();
    await this.ensurePackageCompletionDirectory(parent);
    const units = this.getPackageCompletionIndex(parent.toLowerCase());
    if (!units) {
      return;
    }

    for (const unit of units) {
      if (unit.toLowerCase().startsWith(partial)) {
        candidates.set(`${parent}${unit}`, { includePath: `${parent}${unit}` });
      }
    }
  }

  private async collectRelevantPackageDirectories(
    partial: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): Promise<void> {
    const root = this.projectRoot.getPath();
    if (!root) return;

    const seen = new Set<string>();
    const addDirectory = async (directoryRoot: string): Promise<void> => {
      if (!(await this.fileSystem.isDirectoryAsync(directoryRoot))) return;
      for (const entry of await this.fileSystem.listDirectoryEntriesAsync(directoryRoot)) {
        const atIndex = entry.name.indexOf('@');
        const packageName = atIndex > 0 ? entry.name.substring(0, atIndex) : entry.name;
        if (!this.isRelevantPackage(packageName) || seen.has(packageName.toLowerCase())) continue;
        if (!packageName.toLowerCase().startsWith(partial)) continue;
        const packageDirectory = path.join(directoryRoot, entry.name);
        if (!entry.isDirectory() || !(await this.fileSystem.isDirectoryAsync(packageDirectory))) continue;
        seen.add(packageName.toLowerCase());
        candidates.set(`Packages/${packageName}/`, { includePath: `Packages/${packageName}/` });
      }
    };

    await addDirectory(path.resolve(root, 'Packages'));
    await addDirectory(path.resolve(root, 'Library', 'PackageCache'));
  }

  private async collectRelevantPackageFileCandidates(
    partial: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): Promise<void> {
    const root = this.projectRoot.getPath();
    if (!root) {
      return;
    }

    for (const packageName of this.relevantPackageNames) {
      const packageDirectory = await this.getPackageDirectory(packageName, root);
      if (!packageDirectory) {
        continue;
      }

      const cacheKey = packageName.toLowerCase();
      let files = this.packageRecursiveCompletionCache.get(cacheKey);
      if (!files) {
        let pending = this.pendingPackageRecursiveCompletionCache.get(cacheKey);
        let generation = this.packageCompletionGeneration;
        if (!pending) {
          pending = this.buildRecursivePackageCompletionCache(packageDirectory);
          this.pendingPackageRecursiveCompletionCache.set(cacheKey, pending);
        }
        try {
          files = await pending;
          // 走査中にキャッシュが無効化された世代なら結果を破棄する。
          if (
            generation === this.packageCompletionGeneration &&
            this.pendingPackageRecursiveCompletionCache.get(cacheKey) === pending
          ) {
            this.setPackageRecursiveCompletionCache(cacheKey, files);
          } else if (generation !== this.packageCompletionGeneration) {
            files = undefined;
          }
        } finally {
          if (this.pendingPackageRecursiveCompletionCache.get(cacheKey) === pending) {
            this.pendingPackageRecursiveCompletionCache.delete(cacheKey);
          }
        }
      }

      for (const relative of files ?? []) {
        const fileName = path.posix.basename(relative).toLowerCase();
        if (!fileName.startsWith(partial)) {
          continue;
        }
        const includePath = `Packages/${packageName}/${relative}`;
        candidates.set(includePath, { includePath });
      }
    }
  }

  private async buildRecursivePackageCompletionCache(packageDirectory: string): Promise<string[]> {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [path.normalize(packageDirectory)];
    // PackageCache全体を直列探索すると初回Completionが長時間待たされるため、
    // Directory単位で限定並列化する。Promise数を無制限に増やさない。
    const concurrency = 8;

    const worker = async (): Promise<void> => {
      for (;;) {
        const directoryPath = queue.shift();
        if (!directoryPath) {
          return;
        }
        const normalizedDirectory = path.normalize(directoryPath);
        if (visited.has(normalizedDirectory)) {
          continue;
        }
        visited.add(normalizedDirectory);

        const entries = await this.fileSystem.listDirectoryEntriesAsync(normalizedDirectory);
        for (const entry of entries) {
          // PackageCache配下のsymlinkはproject外へ出る可能性があるため索引対象にしない。
          if (entry.isSymbolicLink()) {
            continue;
          }

          const entryPath = path.join(normalizedDirectory, entry.name);
          if (entry.isDirectory()) {
            queue.push(entryPath);
            continue;
          }
          if (!entry.isFile() || !this.isIncludeFile(entryPath)) {
            continue;
          }
          const relative = path.relative(packageDirectory, entryPath).replace(/\\/g, '/');
          result.push(relative);
        }
      }
    };

    const workerCount = Math.min(concurrency, queue.length || 1);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    result.sort();
    return result;
  }

  private async collectProjectCompletionCandidates(
    fromDirectory: string,
    includePath: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): Promise<void> {
    // プロジェクト側の相対include補完はAssets配下だけを検索対象にする。
    if (!this.isInsideAssets(fromDirectory)) {
      return;
    }

    // 大文字小文字は比較時だけ無視し、実際の入力パスはそのまま保持する。
    const normalizedPrefix = includePath.replace(/\\/g, '/');
    const lowerPrefix = normalizedPrefix.toLowerCase();
    if (!normalizedPrefix.includes('/')) {
      await this.ensureProjectDirectoryIndexed(fromDirectory);
      const files = this.projectDirectoryIndex.get(path.normalize(fromDirectory));
      if (files) {
        for (const filePath of files) {
          const relative = path.relative(fromDirectory, filePath).replace(/\\/g, '/');
          if (!relative || relative.includes('/')) {
            continue;
          }
          if (relative.toLowerCase().startsWith(lowerPrefix)) {
            candidates.set(relative, { includePath: relative });
          }
        }
      }

      // 同階層のディレクトリも候補にする。次の階層を入力できるようにする。
      await this.addProjectDirectoryCandidates(fromDirectory, normalizedPrefix, candidates);
      return;
    }

    const slashIndex = normalizedPrefix.lastIndexOf('/');
    const directoryPart = normalizedPrefix.substring(0, slashIndex + 1);
    const partial = normalizedPrefix.substring(slashIndex + 1);
    const targetDirectory = path.resolve(fromDirectory, directoryPart);
    // ../ を繰り返してもAssetsの外へ出ないようにする。
    if (!this.isInsideAssets(targetDirectory)) {
      return;
    }

    await this.ensureProjectDirectoryIndexed(targetDirectory);
    const files = this.projectDirectoryIndex.get(path.normalize(targetDirectory));
    if (files) {
      for (const filePath of files) {
        const relative = path.relative(fromDirectory, filePath).replace(/\\/g, '/');
        if (!relative.toLowerCase().startsWith(lowerPrefix)) {
          continue;
        }
        if (path.posix.basename(relative).toLowerCase().startsWith(partial.toLowerCase())) {
          candidates.set(relative, { includePath: relative });
        }
      }
    }

    // ../ や ./ の後にさらにディレクトリを選択できるよう、対象ディレクトリ直下も候補にする。
    await this.addProjectDirectoryCandidates(targetDirectory, partial, candidates, directoryPart);
  }

  private async addProjectDirectoryCandidates(
    directoryPath: string,
    partial: string,
    candidates: Map<string, IncludeCompletionCandidate>,
    includePrefix = '',
  ): Promise<void> {
    // ディレクトリ候補もAssets配下だけに限定する。
    if (!(await this.isInsideAssetsAsync(directoryPath)) || !(await this.fileSystem.isDirectoryAsync(directoryPath))) {
      return;
    }

    const lowerPartial = partial.toLowerCase();
    for (const entry of await this.fileSystem.listDirectoryEntriesAsync(directoryPath)) {
      if (!entry.name.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }

      const entryPath = path.join(directoryPath, entry.name);
      if (
        !entry.isDirectory() ||
        !(await this.fileSystem.isDirectoryAsync(entryPath)) ||
        !(await this.projectRoot.isInsideProjectAsync(entryPath))
      ) {
        continue;
      }

      const candidate = `${includePrefix}${entry.name}/`.replace(/\\/g, '/');
      candidates.set(candidate, { includePath: candidate });
    }
  }

  private async ensureProjectDirectoryIndexed(directoryPath: string): Promise<void> {
    const normalizedDirectory = path.normalize(directoryPath);
    if (this.indexedProjectDirectories.has(normalizedDirectory)) {
      // LRU: 最近利用したディレクトリを末尾へ移動する。
      const cached = this.projectDirectoryIndex.get(normalizedDirectory);
      if (cached) {
        this.projectDirectoryIndex.delete(normalizedDirectory);
        this.projectDirectoryIndex.set(normalizedDirectory, cached);
      }
      return;
    }
    // プロジェクト側キャッシュの最大到達地点をAssetsに固定する。
    if (
      !(await this.isInsideAssetsAsync(normalizedDirectory)) ||
      !(await this.fileSystem.isDirectoryAsync(normalizedDirectory))
    ) {
      return;
    }

    const files = new Set<string>();
    for (const entry of await this.fileSystem.listDirectoryEntriesAsync(normalizedDirectory)) {
      const entryPath = path.join(normalizedDirectory, entry.name);
      if (!entry.isFile() || !this.isIncludeFile(entryPath)) {
        continue;
      }
      files.add(path.normalize(entryPath));
    }

    this.projectDirectoryIndex.delete(normalizedDirectory);
    this.projectDirectoryIndex.set(normalizedDirectory, files);
    this.indexedProjectDirectories.add(normalizedDirectory);
    while (this.projectDirectoryIndex.size > this.maxProjectDirectoryIndexEntries) {
      const oldestDirectory = this.projectDirectoryIndex.keys().next().value as string | undefined;
      if (oldestDirectory === undefined) {
        break;
      }
      this.projectDirectoryIndex.delete(oldestDirectory);
      this.indexedProjectDirectories.delete(oldestDirectory);
    }
  }

  private removeProjectFileFromDirectoryIndex(filePath: string): void {
    const directory = path.normalize(path.dirname(filePath));
    const files = this.projectDirectoryIndex.get(directory);
    if (!files) {
      return;
    }
    files.delete(path.normalize(filePath));
    if (files.size === 0) {
      this.projectDirectoryIndex.delete(directory);
      this.indexedProjectDirectories.delete(directory);
    }
  }

  private startPackageCacheWarmup(_root: string): void {
    // 後方互換用の空実装。PackageCacheは必要時だけ遅延索引する。
  }

  private isRelevantPackage(packageName: string): boolean {
    return this.relevantPackageNames.has(packageName.toLowerCase());
  }

  private async getPackageDirectory(packageName: string, root: string): Promise<string | undefined> {
    const cached = this.packageDirectories.get(packageName);
    if (cached && (await this.fileSystem.isDirectoryAsync(cached))) {
      return cached;
    }

    const projectPackage = path.resolve(root, 'Packages', packageName);
    if (await this.fileSystem.isDirectoryAsync(projectPackage)) {
      return projectPackage;
    }

    const cacheRoot = path.resolve(root, 'Library', 'PackageCache');
    const found = await this.fileSystem.findDirectoryAsync(cacheRoot, `${packageName}@`);
    if (found) {
      this.packageDirectories.set(packageName, found);
    }
    return found;
  }

  private async getPackageCacheDirectory(packageName: string, root: string): Promise<string | undefined> {
    const cached = this.packageDirectories.get(packageName);
    if (cached && (await this.fileSystem.isDirectoryAsync(cached))) {
      return cached;
    }

    const cacheRoot = path.resolve(root, 'Library', 'PackageCache');
    const found = await this.fileSystem.findDirectoryAsync(cacheRoot, `${packageName}@`);
    if (found) {
      this.packageDirectories.set(packageName, found);
    }
    return found;
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

  private async ensurePackageCompletionDirectory(includeDirectory: string): Promise<void> {
    const normalized = includeDirectory.replace(/\\/g, '/');
    if (!normalized.startsWith('Packages/')) {
      return;
    }

    const relative = normalized.substring('Packages/'.length);
    const slashIndex = relative.indexOf('/');
    const packageName = slashIndex >= 0 ? relative.substring(0, slashIndex) : relative;
    const subPath = slashIndex >= 0 ? relative.substring(slashIndex + 1) : '';
    const root = this.projectRoot.getPath();
    if (!root) {
      return;
    }
    if (!this.isRelevantPackage(packageName)) {
      return;
    }

    const packageDirectory = await this.getPackageDirectory(packageName, root);
    if (!packageDirectory) {
      return;
    }

    const actualDirectory = subPath ? path.resolve(packageDirectory, subPath) : packageDirectory;
    if (!(await this.fileSystem.isDirectoryAsync(actualDirectory))) {
      return;
    }

    const key = normalized.toLowerCase().replace(/\\/g, '/');
    if (this.packageCompletionIndex.has(key)) {
      return;
    }

    const units = new Set<string>();
    for (const entry of await this.fileSystem.listDirectoryEntriesAsync(actualDirectory)) {
      const entryPath = path.join(actualDirectory, entry.name);
      if (entry.isDirectory()) {
        units.add(`${entry.name}/`);
      } else if (entry.isFile() && this.isIncludeFile(entryPath)) {
        units.add(entry.name);
      }
    }
    this.setPackageCompletionIndex(key, units);
  }

  private getPackageCompletionIndex(key: string): Set<string> | undefined {
    const units = this.packageCompletionIndex.get(key);
    if (!units) {
      return undefined;
    }
    // LRU: 最近参照したディレクトリを末尾へ移動する。
    this.packageCompletionIndex.delete(key);
    this.packageCompletionIndex.set(key, units);
    return units;
  }

  private setPackageCompletionIndex(key: string, units: Set<string>): void {
    this.packageCompletionIndex.delete(key);
    this.packageCompletionIndex.set(key, units);
    while (this.packageCompletionIndex.size > this.maxPackageCompletionIndexEntries) {
      const oldestKey = this.packageCompletionIndex.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.packageCompletionIndex.delete(oldestKey);
    }
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
        this.setPackageCompletionIndex(parentKey, units);
      }
      units.add(unit);
      parent += unit;
    }

    const leafParentKey = parent.toLowerCase();
    let units = this.packageCompletionIndex.get(leafParentKey);
    if (!units) {
      units = new Set<string>();
      this.setPackageCompletionIndex(leafParentKey, units);
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
      const units = this.getPackageCompletionIndex(parent.toLowerCase());
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

  private removePackageIncludeEntriesUnderDirectory(directoryPath: string): void {
    const normalizedDirectory = path.normalize(directoryPath);
    const prefix = normalizedDirectory.endsWith(path.sep) ? normalizedDirectory : normalizedDirectory + path.sep;
    for (const cachedPath of Array.from(this.packageIncludeFiles.keys())) {
      const normalizedCachedPath = path.normalize(cachedPath);
      if (normalizedCachedPath === normalizedDirectory || normalizedCachedPath.startsWith(prefix)) {
        this.removePackageIncludeFile(normalizedCachedPath);
      }
    }
  }

  private removePackageIncludeFileOrDirectory(filePath: string): void {
    const normalized = path.normalize(filePath);
    if (this.packageIncludeFiles.has(normalized)) {
      this.removePackageIncludeFile(normalized);
      return;
    }
    this.removePackageIncludeEntriesUnderDirectory(normalized);
  }

  private setPackageRecursiveCompletionCache(cacheKey: string, files: string[]): void {
    this.packageRecursiveCompletionCache.delete(cacheKey);
    this.packageRecursiveCompletionCache.set(cacheKey, files);
    while (this.packageRecursiveCompletionCache.size > this.maxPackageRecursiveCompletionCacheEntries) {
      const oldest = this.packageRecursiveCompletionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.packageRecursiveCompletionCache.delete(oldest);
    }
  }

  private updatePackageCacheFile(filePath: string, type: number): void {
    const root = this.projectRoot.getPath();
    if (!root) {
      return;
    }

    const cacheRoot = path.resolve(root, 'Library', 'PackageCache');
    const relative = path.relative(cacheRoot, filePath);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return;
    }

    const parts = relative.split(path.sep);
    const packageDirectoryName = parts.shift();
    if (!packageDirectoryName) {
      return;
    }

    const atIndex = packageDirectoryName.indexOf('@');
    if (atIndex <= 0) {
      return;
    }
    const packageName = packageDirectoryName.substring(0, atIndex);
    if (!this.isRelevantPackage(packageName)) {
      // URP ShaderLabに不要なパッケージは監視イベントでも索引を作らない。
      return;
    }

    const packageDirectory = path.join(cacheRoot, packageDirectoryName);
    const packageKey = packageName.toLowerCase();
    const isIncludeFileChange = parts.length > 0 && this.isIncludeFile(filePath);

    if (type === 3 && parts.length === 0) {
      if (this.packageDirectories.get(packageName) === packageDirectory) {
        this.packageDirectories.delete(packageName);
      }
      this.removePackageIncludeEntriesUnderDirectory(packageDirectory);
      this.packageCompletionIndex.clear();
      this.packageRecursiveCompletionCache.delete(packageKey);
      this.packageCompletionGeneration++;
      return;
    }

    if (parts.length > 0 && type === 3) {
      // ファイル削除は対象エントリだけを取り除き、他ファイルの索引を保持する。
      this.removePackageIncludeFileOrDirectory(filePath);
      this.packageRecursiveCompletionCache.delete(packageKey);
      this.packageCompletionGeneration++;
      return;
    }

    if ((type === 1 || type === 2) && parts.length === 0) {
      this.packageDirectories.set(packageName, packageDirectory);
      this.packageCompletionIndex.clear();
      this.packageRecursiveCompletionCache.delete(packageKey);
      this.packageCompletionGeneration++;
      return;
    }

    if ((type === 1 || type === 2) && isIncludeFileChange) {
      // ファイル単位の変更では全体のcompletion indexを破棄せず、該当URIだけ更新する。
      const logicalInclude = `Packages/${packageName}/${parts.join('/')}`;
      this.addPackageIncludeFile(filePath, logicalInclude);
      this.packageRecursiveCompletionCache.delete(packageKey);
      this.packageCompletionGeneration++;
      return;
    }

    // ディレクトリ変更は配下の候補構造が変わるため、関連索引を再構築する。
    if (parts.length > 0) {
      this.packageCompletionIndex.clear();
      this.packageRecursiveCompletionCache.delete(packageKey);
      this.packageCompletionGeneration++;
    }
  }

  private updateProjectPackageFile(filePath: string, type: number): void {
    const root = this.projectRoot.getPath();
    if (!root) {
      return;
    }

    const relative = path.relative(root, filePath).replace(/\\/g, '/');
    const parts = relative.split('/');
    const packageName = parts[1];
    if (!packageName || !this.isRelevantPackage(packageName)) {
      // URP ShaderLabに不要なパッケージは補完索引を更新しない。
      return;
    }

    // Packages側も全走査はせず、既に作成済みの補完索引だけを無効化する。
    this.packageCompletionIndex.clear();
    this.packageRecursiveCompletionCache.delete(packageName.toLowerCase());
    this.packageCompletionGeneration++;
    if (type === 3 || !this.isIncludeFile(filePath)) {
      this.removePackageIncludeFile(filePath);
      return;
    }
    // Packages配下のincludeも論理パスで索引し、削除時に正しく解放できるようにする。
    this.addPackageIncludeFile(filePath, relative);
  }

  private updateProjectIncludeFile(filePath: string, type: number): void {
    const normalized = path.normalize(filePath);
    if (!this.isInsideAssets(normalized)) {
      return;
    }

    // ディレクトリ自体が削除された場合は、空集合だけでなく索引済みマーカーも解放する。
    if (type === 3 && this.projectDirectoryIndex.has(normalized)) {
      this.projectDirectoryIndex.delete(normalized);
      this.indexedProjectDirectories.delete(normalized);
      return;
    }

    const directory = path.normalize(path.dirname(normalized));
    const indexed = this.indexedProjectDirectories.has(directory);

    if (type === 3 || !this.isIncludeFile(filePath)) {
      if (indexed) {
        this.removeProjectFileFromDirectoryIndex(normalized);
      }
      return;
    }

    if (indexed) {
      let files = this.projectDirectoryIndex.get(directory);
      if (!files) {
        files = new Set<string>();
        this.projectDirectoryIndex.set(directory, files);
      }
      files.add(normalized);
    }
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
    if (!this.isInsideAssets(filePath) || !this.isIncludeFile(filePath)) {
      return false;
    }
    return true;
  }

  private async isInsideAssetsAsync(filePath: string): Promise<boolean> {
    const root = this.projectRoot.getPath();
    if (!root) return false;
    const assetsRoot = path.resolve(root, 'Assets');
    const normalizedPath = path.resolve(filePath);
    const relative = path.relative(assetsRoot, normalizedPath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
    return this.projectRoot.isInsideProjectAsync(normalizedPath);
  }

  private isInsideAssets(filePath: string): boolean {
    const root = this.projectRoot.getPath();
    if (!root) {
      return false;
    }

    const assetsRoot = path.resolve(root, 'Assets');
    const normalizedPath = path.resolve(filePath);
    const relative = path.relative(assetsRoot, normalizedPath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return false;
    }

    // Assets内のsymlinkから外へ出る経路も許可しない。
    return this.projectRoot.isInsideProject(normalizedPath);
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
