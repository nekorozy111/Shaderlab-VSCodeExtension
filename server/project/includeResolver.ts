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
  private projectIncludeFiles: string[] | undefined;

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

    /*
     * 1. 絶対パス
     */
    if (path.isAbsolute(normalizedInclude)) {
      const absoluteResult = this.tryResolve(normalizedInclude, 'absolute', normalizedInclude);

      if (absoluteResult) {
        return absoluteResult;
      }
    }

    /*
     * 2. 現在のファイルからの相対パス
     *
     * #include "Common.hlsl"
     *
     * shader
     * ├── MyShader.shader
     * └── Common.hlsl
     */
    if (fromPath) {
      const fromDirectory = path.dirname(fromPath);

      const relativePath = path.resolve(fromDirectory, normalizedInclude);

      const relativeResult = this.tryResolve(relativePath, 'relative', normalizedInclude);

      if (relativeResult) {
        return relativeResult;
      }
    }

    /*
     * 3. Unity プロジェクトルート
     *
     * #include "Assets/Shaders/Common.hlsl"
     */
    const projectResult = this.resolveFromProject(normalizedInclude);

    if (projectResult) {
      return projectResult;
    }

    /*
     * 4. Packages
     *
     * #include
     * "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
     */
    const packagesResult = this.resolveFromPackages(normalizedInclude);

    if (packagesResult) {
      return packagesResult;
    }

    /*
     * 5. Library/PackageCache
     *
     * Unity Package Manager のキャッシュ。
     *
     * 例:
     *
     * Library/PackageCache/
     * └── com.unity.render-pipelines.universal@17.x.x/
     *     └── ShaderLibrary/
     *         └── Core.hlsl
     */
    const packageCacheResult = this.resolveFromPackageCache(normalizedInclude);

    if (packageCacheResult) {
      return packageCacheResult;
    }

    return undefined;
  }

  public invalidateProjectIncludeCache(): void {
    this.projectIncludeFiles = undefined;

    console.log('[IncludeResolver] Project include file cache invalidated');
  }

  public getCompletionCandidates(includePath: string, fromUri: string): IncludeCompletionCandidate[] {
    const normalizedInclude = this.normalizeIncludePath(includePath);
    const candidates = new Map<string, IncludeCompletionCandidate>();

    const root = this.projectRoot.getPath();

    if (!root) {
      return [];
    }

    /*
     * includePath の途中まで入力されている場合も、
     * その文字列をそのまま prefix として利用する。
     *
     * 例:
     *
     * ""
     * Packages/
     * Packages/com.unity.render-pipelines.universal/ShaderLibrary/Co
     */
    const prefix = normalizedInclude.toLowerCase();

    /*
     * 1. Packages/
     *
     * Unity Package Manager の Packages フォルダ。
     */
    const packagesRoot = path.resolve(root, 'Packages');

    this.collectIncludeFiles(packagesRoot, '', prefix, candidates);

    /*
     * 2. Library/PackageCache/
     *
     * Packages/xxx/... に対応する実体。
     */
    const packageCacheRoot = path.resolve(root, 'Library', 'PackageCache');

    if (this.fileSystem.isDirectory(packageCacheRoot)) {
      const packageDirectories = this.fileSystem.listDirectory(packageCacheRoot);

      for (const packageDirectory of packageDirectories) {
        const packageDirectoryPath = path.join(packageCacheRoot, packageDirectory);

        if (!this.fileSystem.isDirectory(packageDirectoryPath)) {
          continue;
        }

        /*
         * com.unity.render-pipelines.core@...
         * ↓
         * Packages/com.unity.render-pipelines.core/...
         */
        const atIndex = packageDirectory.indexOf('@');

        if (atIndex <= 0) {
          continue;
        }

        const packageName = packageDirectory.substring(0, atIndex);

        this.collectIncludeFiles(packageDirectoryPath, `Packages/${packageName}/`, prefix, candidates);
      }
    }

    /*
     * 3. 現在のファイルからの相対 include
     *
     * #include "Common.hlsl"
     * #include "Shaders/Common.hlsl"
     */
    const fromPath = this.uriToPath(fromUri);

    if (fromPath) {
      const fromDirectory = path.dirname(fromPath);

      this.collectRelativeIncludeCandidates(fromDirectory, normalizedInclude, candidates);
    }
    if (fromPath && normalizedInclude !== '' && !normalizedInclude.includes('/') && !normalizedInclude.includes('\\')) {
      const fromDirectory = path.dirname(fromPath);

      this.collectProjectRelativeIncludeCandidates(root, fromDirectory, normalizedInclude, candidates);
    }
    return Array.from(candidates.values()).sort((a, b) => a.includePath.localeCompare(b.includePath));
  }

  private resolveFromProject(includePath: string): IncludeResolution | undefined {
    const root = this.projectRoot.getPath();

    if (!root) {
      return undefined;
    }

    const candidate = path.resolve(root, includePath);

    return this.tryResolve(candidate, 'project', includePath);
  }

  private resolveFromPackages(includePath: string): IncludeResolution | undefined {
    const root = this.projectRoot.getPath();

    if (!root) {
      return undefined;
    }

    let normalized = includePath;

    if (normalized.startsWith('Packages/')) {
      normalized = normalized.substring('Packages/'.length);
    }

    const candidate = path.resolve(root, 'Packages', normalized);

    return this.tryResolve(candidate, 'packages', includePath);
  }

  private resolveFromPackageCache(includePath: string): IncludeResolution | undefined {
    const root = this.projectRoot.getPath();

    if (!root) {
      return undefined;
    }

    if (!includePath.startsWith('Packages/')) {
      return undefined;
    }

    const packageRelativePath = includePath.substring('Packages/'.length);

    const separatorIndex = packageRelativePath.indexOf('/');

    if (separatorIndex < 0) {
      return undefined;
    }

    const packageName = packageRelativePath.substring(0, separatorIndex);

    const packageFile = packageRelativePath.substring(separatorIndex + 1);

    const cacheRoot = path.resolve(root, 'Library', 'PackageCache');

    if (!this.fileSystem.isDirectory(cacheRoot)) {
      return undefined;
    }

    const packageDirectory = this.fileSystem.findDirectory(cacheRoot, `${packageName}@`);

    if (!packageDirectory) {
      return undefined;
    }

    const candidate = path.resolve(packageDirectory, packageFile);

    return this.tryResolve(candidate, 'packageCache', includePath);
  }

  private tryResolve(filePath: string, source: IncludeSource, includePath: string): IncludeResolution | undefined {
    if (!this.fileSystem.isFile(filePath)) {
      return undefined;
    }

    return {
      includePath,
      resolvedPath: path.normalize(filePath),
      uri: pathToFileURL(path.normalize(filePath)).toString(),
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

  private collectIncludeFiles(
    directoryPath: string,
    includeBasePath: string,
    prefix: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    if (!this.fileSystem.isDirectory(directoryPath)) {
      return;
    }

    for (const entry of this.fileSystem.listDirectory(directoryPath)) {
      const entryPath = path.join(directoryPath, entry);

      const includePath = `${includeBasePath}${entry}`;

      if (this.fileSystem.isDirectory(entryPath)) {
        this.collectIncludeFiles(entryPath, `${includePath}/`, prefix, candidates);

        continue;
      }

      if (!this.fileSystem.isFile(entryPath)) {
        continue;
      }

      /*
       * Shader include として扱うファイルだけ。
       */
      if (!entry.endsWith('.hlsl') && !entry.endsWith('.hlsli') && !entry.endsWith('.cginc')) {
        continue;
      }

      if (!includePath.toLowerCase().startsWith(prefix)) {
        continue;
      }

      candidates.set(includePath, {
        includePath,
      });
    }
  }

  private collectRelativeIncludeCandidates(
    fromDirectory: string,
    includePath: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    const slashIndex = Math.max(includePath.lastIndexOf('/'), includePath.lastIndexOf('\\'));

    const directoryPart = slashIndex >= 0 ? includePath.substring(0, slashIndex + 1) : '';

    const targetDirectory = path.resolve(fromDirectory, directoryPart || '.');

    if (!this.fileSystem.isDirectory(targetDirectory)) {
      return;
    }

    // パス指定がない場合は現在ディレクトリ直下だけを見る。
    // 例:
    //   #include "aabbcc"
    //
    // Folder1/Main.shader から
    // Folder2/aabbcc.hlsl は候補にしない。
    if (slashIndex < 0) {
      const prefix = includePath.toLowerCase();

      for (const entry of this.fileSystem.listDirectory(targetDirectory)) {
        const entryPath = path.join(targetDirectory, entry);

        if (!this.fileSystem.isFile(entryPath)) {
          continue;
        }

        if (!entry.endsWith('.hlsl') && !entry.endsWith('.hlsli') && !entry.endsWith('.cginc')) {
          continue;
        }

        if (!entry.toLowerCase().startsWith(prefix)) {
          continue;
        }

        candidates.set(entry, {
          includePath: entry,
        });
      }

      return;
    }

    const projectRoot = this.projectRoot.getPath();

    this.collectRelativeIncludeFilesRecursive(
      targetDirectory,
      directoryPart,
      includePath,
      candidates,
      fromDirectory,
      projectRoot,
    );
  }
  private collectProjectRelativeIncludeCandidates(
    projectRoot: string,
    fromDirectory: string,
    prefix: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    const projectFiles = this.getProjectIncludeFiles(projectRoot);
    const normalizedPrefix = prefix.toLowerCase();

    for (const entryPath of projectFiles) {
      const fileName = path.basename(entryPath);

      if (!fileName.toLowerCase().startsWith(normalizedPrefix)) {
        continue;
      }

      const relativePath = path.relative(fromDirectory, entryPath).replace(/\\/g, '/');

      if (!relativePath) {
        continue;
      }

      console.log(
        `[IncludeResolver] Cached project candidate:` +
          ` fromDirectory="${fromDirectory}"` +
          ` entryPath="${entryPath}"` +
          ` relativePath="${relativePath}"`,
      );

      candidates.set(relativePath, {
        includePath: relativePath,
      });
    }
  }
  private collectProjectRelativeIncludeFilesRecursive(
    directoryPath: string,
    projectRoot: string,
    fromDirectory: string,
    prefix: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    for (const entry of this.fileSystem.listDirectory(directoryPath)) {
      const entryPath = path.join(directoryPath, entry);

      if (this.fileSystem.isDirectory(entryPath)) {
        // Unityプロジェクトの特殊ディレクトリは
        // プロジェクト相対include検索の対象外。
        if (
          directoryPath === projectRoot &&
          (entry === 'Library' || entry === 'Packages' || entry === 'ProjectSettings')
        ) {
          continue;
        }

        this.collectProjectRelativeIncludeFilesRecursive(entryPath, projectRoot, fromDirectory, prefix, candidates);

        continue;
      }

      if (!this.fileSystem.isFile(entryPath)) {
        continue;
      }

      if (!entry.endsWith('.hlsl') && !entry.endsWith('.hlsli') && !entry.endsWith('.cginc')) {
        continue;
      }

      if (!entry.toLowerCase().startsWith(prefix)) {
        continue;
      }

      /*
       * 現在のshaderから見た相対パスを
       * include候補として使用する。
       *
       * 例:
       *
       * Assets/Folder1/Main.shader
       * Assets/Folder2/aabbcc.hlsl
       *
       * ↓
       *
       * ../Folder2/aabbcc.hlsl
       */
      const relativePath = path.relative(fromDirectory, entryPath).replace(/\\/g, '/');
      console.log(
        `[IncludeResolver] Project relative candidate:` +
          ` fromDirectory="${fromDirectory}"` +
          ` entryPath="${entryPath}"` +
          ` relativePath="${relativePath}"`,
      );
      if (!relativePath) {
        continue;
      }

      candidates.set(relativePath, {
        includePath: relativePath,
      });
    }
  }
  private collectRelativeIncludeFilesRecursive(
    directoryPath: string,
    includeBasePath: string,
    includePrefix: string,
    candidates: Map<string, IncludeCompletionCandidate>,
    fromDirectory: string,
    projectRoot: string | undefined,
  ): void {
    /*
     * 絶対に Unity プロジェクトの外へ出ない。
     *
     * 例:
     *
     * projectRoot = d:/UnityProj/ssr
     *
     * ../../../
     *
     * で d:/UnityProj などへ到達しても、
     * ここで即座に探索を停止する。
     */
    if (projectRoot) {
      const relativeToProjectRoot = path.relative(projectRoot, directoryPath);

      if (
        relativeToProjectRoot.startsWith('..' + path.sep) ||
        relativeToProjectRoot === '..' ||
        path.isAbsolute(relativeToProjectRoot)
      ) {
        return;
      }

      /*
       * Library / Packages は
       * 相対 include の補完対象外。
       */
      const firstSegment = relativeToProjectRoot.split(path.sep)[0];

      if (firstSegment === 'Library' || firstSegment === 'Packages') {
        return;
      }
    }

    for (const entry of this.fileSystem.listDirectory(directoryPath)) {
      const entryPath = path.join(directoryPath, entry);

      if (this.fileSystem.isDirectory(entryPath)) {
        /*
         * 現在のファイルがあるディレクトリへ
         * 再び潜り込まない。
         *
         * ../
         * ../../
         *
         * などで親へ移動したあと、
         * .VSCodeExtensionCheck/ に戻ってくるケースを防ぐ。
         */
        if (path.resolve(entryPath) === path.resolve(fromDirectory)) {
          continue;
        }

        this.collectRelativeIncludeFilesRecursive(
          entryPath,
          `${includeBasePath}${entry}/`,
          includePrefix,
          candidates,
          fromDirectory,
          projectRoot,
        );

        continue;
      }

      if (!this.fileSystem.isFile(entryPath)) {
        continue;
      }

      if (!entry.endsWith('.hlsl') && !entry.endsWith('.hlsli') && !entry.endsWith('.cginc')) {
        continue;
      }

      const candidatePath = `${includeBasePath}${entry}`.replace(/\\/g, '/');

      if (!candidatePath.toLowerCase().startsWith(includePrefix.toLowerCase())) {
        continue;
      }

      candidates.set(candidatePath, {
        includePath: candidatePath,
      });
    }
  }
  private uriToPath(uri: string): string | undefined {
    if (!uri.startsWith('file://')) {
      return undefined;
    }

    try {
      const decoded = decodeURIComponent(uri.substring('file://'.length));

      /*
       * Windows:
       *
       * file:///C:/Project/Test.shader
       *
       * Linux:
       *
       * file:///home/user/Project/Test.shader
       */
      if (/^\/[A-Za-z]:\//.test(decoded)) {
        return decoded.substring(1);
      }

      return decoded;
    } catch {
      return undefined;
    }
  }
  private getProjectIncludeFiles(projectRoot: string): string[] {
    if (this.projectIncludeFiles !== undefined) {
      console.log(`[IncludeResolver] Using cached project include files: ${this.projectIncludeFiles.length}`);

      return this.projectIncludeFiles;
    }

    const files: string[] = [];

    const collect = (directoryPath: string): void => {
      for (const entry of this.fileSystem.listDirectory(directoryPath)) {
        const entryPath = path.join(directoryPath, entry);

        if (this.fileSystem.isDirectory(entryPath)) {
          // Unityプロジェクトの外部・巨大な管理フォルダは検索対象外。
          if (
            directoryPath === projectRoot &&
            (entry === 'Library' || entry === 'Packages' || entry === 'ProjectSettings')
          ) {
            continue;
          }

          collect(entryPath);
          continue;
        }

        if (!this.fileSystem.isFile(entryPath)) {
          continue;
        }

        if (!entry.endsWith('.hlsl') && !entry.endsWith('.hlsli') && !entry.endsWith('.cginc')) {
          continue;
        }

        files.push(entryPath);
      }
    };

    collect(projectRoot);

    this.projectIncludeFiles = files;

    console.log(`[IncludeResolver] Cached project include files: ${files.length}`);

    return files;
  }
}
