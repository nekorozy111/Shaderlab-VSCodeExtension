import * as vscode from "vscode";

import {
    FunctionInfo,
    MacroInfo,
    ShaderVariableInfo,
    StructInfo,
    SymbolDatabase
} from "./symbolDatabase";

export class ShaderHoverProvider
    implements vscode.HoverProvider
{
    constructor(
        private readonly database: SymbolDatabase
    ) {}

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const wordRange =
            document.getWordRangeAtPosition(
                position,
                /[A-Za-z_][A-Za-z0-9_]*/
            );

        if (!wordRange) {
            return undefined;
        }

        const word =
            document.getText(
                wordRange
            );

        const functionInfo =
            this.database.findFunction(
                word
            );

        if (functionInfo) {
            return this.createFunctionHover(
                functionInfo
            );
        }

        const structInfo =
            this.database.findStruct(
                word
            );

        if (structInfo) {
            return this.createStructHover(
                structInfo
            );
        }

        const macroInfo =
            this.database.findMacro(
                word
            );

        if (macroInfo) {
            return this.createMacroHover(
                macroInfo
            );
        }

        const variable =
            this.database.findVariable(
                word
            );

        if (variable) {
            return this.createVariableHover(
                variable
            );
        }

        return undefined;
    }

    private createFunctionHover(
        info: FunctionInfo
    ): vscode.Hover {
        const markdown =
            new vscode.MarkdownString();

        markdown.isTrusted = true;

        markdown.appendCodeblock(
            info.Signature ??
                `${info.ReturnType} ${info.Name}(...)`,
            "hlsl"
        );

        if (
            info.Documentation
        ) {
            markdown.appendMarkdown(
                `\n${info.Documentation}\n`
            );
        }

        this.appendSource(
            markdown,
            info
        );

        return new vscode.Hover(
            markdown
        );
    }

    private createStructHover(
        info: StructInfo
    ): vscode.Hover {
        const markdown =
            new vscode.MarkdownString();

        markdown.isTrusted = true;

        const lines: string[] = [
            `struct ${info.Name}`,
            `{`
        ];

        for (
            const member
            of info.Members
        ) {
            const semantic =
                member.Semantic
                    ? ` : ${member.Semantic}`
                    : "";

            lines.push(
                `    ${member.Type} ${member.Name}${semantic};`
            );
        }

        lines.push(
            `}`
        );

        markdown.appendCodeblock(
            lines.join("\n"),
            "hlsl"
        );

        this.appendSource(
            markdown,
            info
        );

        return new vscode.Hover(
            markdown
        );
    }

    private createMacroHover(
        info: MacroInfo
    ): vscode.Hover {
        const markdown =
            new vscode.MarkdownString();

        markdown.isTrusted = true;

        markdown.appendCodeblock(
            info.Signature ??
                `#define ${info.Name}`,
            "hlsl"
        );

        if (
            info.Value
        ) {
            markdown.appendMarkdown(
                `\n**Expansion**\n\n`
            );

            markdown.appendCodeblock(
                info.Value,
                "hlsl"
            );
        }

        if (
            info.Documentation
        ) {
            markdown.appendMarkdown(
                `\n${info.Documentation}\n`
            );
        }

        this.appendSource(
            markdown,
            info
        );

        return new vscode.Hover(
            markdown
        );
    }

    private createVariableHover(
        info: ShaderVariableInfo
    ): vscode.Hover {
        const markdown =
            new vscode.MarkdownString();

        markdown.isTrusted = true;

        markdown.appendCodeblock(
            this.getVariableSignature(
                info
            ),
            "hlsl"
        );

        if (
            info.CBuffer
        ) {
            markdown.appendMarkdown(
                `\n**Constant Buffer:** \`${info.CBuffer}\`\n`
            );
        }

        if (
            info.ElementType
        ) {
            markdown.appendMarkdown(
                `\n**Element Type:** \`${info.ElementType}\`\n`
            );
        }

        if (
            info.TextureDimension
        ) {
            markdown.appendMarkdown(
                `\n**Dimension:** \`${info.TextureDimension}\`\n`
            );
        }

        this.appendSource(
            markdown,
            info
        );

        return new vscode.Hover(
            markdown
        );
    }

    private getVariableSignature(
        info: ShaderVariableInfo
    ): string {
        if (
            info.IsTexture
        ) {
            return `${info.Type}(${info.Name})`;
        }

        if (
            info.IsSampler
        ) {
            return `${info.Type}(${info.Name})`;
        }

        if (
            info.IsBuffer &&
            info.ElementType
        ) {
            return (
                `${info.Type}<${info.ElementType}> ` +
                info.Name
            );
        }

        return `${info.Type} ${info.Name}`;
    }

    private appendSource(
        markdown: vscode.MarkdownString,
        info: {
            File?: string | null;
            Line?: number | null;
        }
    ): void {
        if (!info.File) {
            return;
        }

        const line =
            Math.max(
                (info.Line ?? 1) - 1,
                0
            );

        markdown.appendMarkdown(
            `\n\nSource: \`${info.File}:${line + 1}\``
        );
    }
}
