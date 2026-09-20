import * as path from "path";
import { fileURLToPath } from "url";
import { InitializeParams } from "vscode-languageserver/node";

export class ProjectRoot {
    private rootPath: string | undefined;

    public initialize(params: InitializeParams): void {
        const workspaceFolders = params.workspaceFolders;

        if (workspaceFolders && workspaceFolders.length > 0) {
            this.rootPath = this.uriToPath(workspaceFolders[0].uri);
            return;
        }

        if (params.rootUri) {
            this.rootPath = this.uriToPath(params.rootUri);
            return;
        }

        this.rootPath = undefined;
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

    public isInsideProject(filePath: string): boolean {
        if (!this.rootPath) {
            return false;
        }

        const root = path.resolve(this.rootPath);
        const target = path.resolve(filePath);

        const relative = path.relative(root, target);

        return (
            relative === "" ||
            (!relative.startsWith("..") &&
                !path.isAbsolute(relative))
        );
    }

    public toRelativePath(filePath: string): string | undefined {
        if (!this.rootPath) {
            return undefined;
        }

        return path.relative(this.rootPath, filePath);
    }

    private uriToPath(uri: string): string {
        if (uri.startsWith("file://")) {
            return fileURLToPath(uri);
        }

        return uri;
    }
}