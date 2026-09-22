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
