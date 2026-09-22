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

      this.collectRelativeIncludeFiles(fromDirectory, '', prefix, candidates);
    }

    return Array.from(candidates.values()).sort((a, b) => a.includePath.localeCompare(b.includePath));
  }

  private getCompletionDirectories(directoryPart: string, fromUri: string): string[] {
    const root = this.projectRoot.getPath();

    if (!root) {
      return [];
    }

    const result: string[] = [];

    /*
     * 1. include path が Packages/... の場合
     */
    if (directoryPart === 'Packages' || directoryPart.startsWith('Packages/')) {
      const packagePath = directoryPart === 'Packages' ? '' : directoryPart.substring('Packages/'.length);

      /*
       * Packages/ 以下の実体
       */
      const packagesDirectory = path.resolve(root, 'Packages', packagePath);

      if (this.fileSystem.isDirectory(packagesDirectory)) {
        result.push(packagesDirectory);
      }

      /*
       * Library/PackageCache 以下
       */
      const cacheRoot = path.resolve(root, 'Library', 'PackageCache');

      if (packagePath) {
        const separatorIndex = packagePath.indexOf('/');

        if (separatorIndex >= 0) {
          const packageName = packagePath.substring(0, separatorIndex);

          const packageRelativePath = packagePath.substring(separatorIndex + 1);

          const packageDirectory = this.fileSystem.findDirectory(cacheRoot, `${packageName}@`);

          if (packageDirectory) {
            const cacheDirectory = path.resolve(packageDirectory, packageRelativePath);

            if (this.fileSystem.isDirectory(cacheDirectory)) {
              result.push(cacheDirectory);
            }
          }
        } else {
          const packageDirectory = this.fileSystem.findDirectory(cacheRoot, `${packagePath}@`);

          if (packageDirectory) {
            result.push(packageDirectory);
          }
        }
      } else if (this.fileSystem.isDirectory(cacheRoot)) {
        result.push(cacheRoot);
      }

      return result;
    }

    /*
     * 2. Assets/... などプロジェクトルート基準
     */
    if (directoryPart === 'Assets' || directoryPart.startsWith('Assets/')) {
      const directory = path.resolve(root, directoryPart);

      if (this.fileSystem.isDirectory(directory)) {
        result.push(directory);
      }

      return result;
    }

    /*
     * 3. 通常の相対 include
     *
     * #include "Common.hlsl"
     * #include "Shaders/Common.hlsl"
     */
    const fromPath = this.uriToPath(fromUri);

    if (fromPath) {
      const fromDirectory = path.dirname(fromPath);

      const relativeDirectory = path.resolve(fromDirectory, directoryPart || '.');

      if (this.fileSystem.isDirectory(relativeDirectory)) {
        result.push(relativeDirectory);
      }
    }

    /*
     * 4. プロジェクトルート
     *
     * Assets/... などでない場合の候補。
     */
    const projectDirectory = path.resolve(root, directoryPart || '.');

    if (this.fileSystem.isDirectory(projectDirectory) && !result.includes(projectDirectory)) {
      result.push(projectDirectory);
    }

    /*
     * 5. Packages/ のルート
     *
     * #include "com.unity...."
     * のような記述にも対応しやすくする。
     */
    if (!directoryPart) {
      const packagesDirectory = path.resolve(root, 'Packages');

      if (this.fileSystem.isDirectory(packagesDirectory) && !result.includes(packagesDirectory)) {
        result.push(packagesDirectory);
      }
    }

    return result;
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

  private collectRelativeIncludeFiles(
    directoryPath: string,
    relativeBasePath: string,
    prefix: string,
    candidates: Map<string, IncludeCompletionCandidate>,
  ): void {
    if (!this.fileSystem.isDirectory(directoryPath)) {
      return;
    }

    for (const entry of this.fileSystem.listDirectory(directoryPath)) {
      const entryPath = path.join(directoryPath, entry);

      const relativePath = `${relativeBasePath}${entry}`;

      /*
       * prefix と同じ階層にある候補だけを対象にする。
       */
      const normalizedRelativePath = relativePath.replace(/\\/g, '/');

      if (this.fileSystem.isFile(entryPath)) {
        if (!entry.endsWith('.hlsl') && !entry.endsWith('.hlsli') && !entry.endsWith('.cginc')) {
          continue;
        }

        if (!normalizedRelativePath.toLowerCase().startsWith(prefix)) {
          continue;
        }

        candidates.set(normalizedRelativePath, {
          includePath: normalizedRelativePath,
        });

        continue;
      }

      if (this.fileSystem.isDirectory(entryPath)) {
        this.collectRelativeIncludeFiles(entryPath, `${relativePath}/`, prefix, candidates);
      }
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
}
