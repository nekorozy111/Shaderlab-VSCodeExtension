import * as fs from 'fs';
import * as path from 'path';

export class FileSystem {
  public exists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  public isFile(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  public isDirectory(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  public readText(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  public listDirectory(directoryPath: string): string[] {
    try {
      return fs.readdirSync(directoryPath);
    } catch {
      return [];
    }
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
}
