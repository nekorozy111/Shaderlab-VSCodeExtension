import { IncludeResolution, IncludeResolver } from './includeResolver';

import { FileSystem } from './fileSystem';
import { ProjectRoot } from './projectRoot';

export class ProjectService {
  private readonly projectRoot = new ProjectRoot();
  private readonly fileSystem = new FileSystem();

  public readonly includeResolver = new IncludeResolver(this.projectRoot, this.fileSystem);

  public initialize(params: Parameters<ProjectRoot['initialize']>[0]): void {
    this.projectRoot.initialize(params);
  }

  public getRootPath(): string | undefined {
    return this.projectRoot.getPath();
  }

  public resolveInclude(includePath: string, fromUri: string): IncludeResolution | undefined {
    return this.includeResolver.resolve(includePath, fromUri);
  }

  public readFile(filePath: string): string | undefined {
    return this.fileSystem.readText(filePath);
  }

  public exists(filePath: string): boolean {
    return this.fileSystem.exists(filePath);
  }
}
