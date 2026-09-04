import * as vscode from "vscode";

import {
    FunctionInfo,
    IncludeInfo,
    MacroInfo,
    ShaderVariableInfo,
    StructInfo,
    SymbolDatabase
} from "./symbolDatabase";

import {
    ShaderDocument
} from "./shaderDocument";

export class ShaderCompletionProvider
    implements vscode.CompletionItemProvider
{
constructor(
    private readonly database: SymbolDatabase,
    private readonly shaderDocument: ShaderDocument
) {}

public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
):
    vscode.ProviderResult<
        vscode.CompletionItem[]
    > {
    const linePrefix =
        document
            .lineAt(position.line)
            .text
            .substring(
                0,
                position.character
            );

    /*
     * #include
     */
    if (
        this.isIncludeCompletion(
            linePrefix
        )
    ) {
        return this.provideIncludeCompletion(
            linePrefix
        );
    }

    /*
     * struct.member
     */
    const memberContext =
        this.getMemberContext(
            document,
            position
        );

    if (memberContext) {
           return this.provideMemberCompletion(
                memberContext.type
            );
    }

    /*
     * 通常のシンボル。
     *
     * まずローカル変数・関数引数、
     * 次に Database のグローバルシンボル。
     */
    return this.provideSymbolCompletion(
        document,
        position
    );
}


    private provideIncludeCompletion(
        linePrefix: string
    ): vscode.CompletionItem[] {
        const match =
            linePrefix.match(
                /#\s*include\s*[<"]([^>"]*)$/
            );

        const query =
            match?.[1] ?? "";

        return this.database
            .searchIncludes(
                query
            )
            .map(
                include =>
                    this.createIncludeItem(
                        include
                    )
            );
    }

private provideSymbolCompletion(
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.CompletionItem[] {
    const items:
        vscode.CompletionItem[] = [];

    /*
     * ----------------------------------------
     * Local variables
     * ----------------------------------------
     */
    const localVariables =
        this.shaderDocument
            .getVariables(
                document
            )
            .filter(
                variable =>
                    variable.line <=
                    position.line &&
                    position.line >=
                    variable.scopeStart &&
                    position.line <=
                    variable.scopeEnd
            );

    for (
        const variable
        of localVariables
    ) {
        items.push(
            this.createLocalVariableItem(
                variable
            )
        );
    }

    /*
     * ----------------------------------------
     * Function parameters
     * ----------------------------------------
     */
    const currentFunction =
        this.shaderDocument
            .getFunctions(
                document
            )
            .find(
                functionInfo =>
                    position.line >=
                        functionInfo.startLine &&
                    position.line <=
                        functionInfo.endLine
            );

    if (currentFunction) {
        for (
            const parameter
            of currentFunction.parameters
        ) {
            items.push(
                this.createParameterItem(
                    parameter
                )
            );
        }
    }

    /*
     * ----------------------------------------
     * Current file structs
     * ----------------------------------------
     */
    for (
        const structInfo
        of this.shaderDocument.getStructs(
            document
        )
    ) {
        items.push(
            this.createLocalStructItem(
                structInfo
            )
        );
    }

    /*
     * ----------------------------------------
     * Database Functions
     * ----------------------------------------
     */
    for (
        const functionInfo
        of this.database.functions
    ) {
        items.push(
            this.createFunctionItem(
                functionInfo
            )
        );
    }

    /*
     * ----------------------------------------
     * Database Structs
     * ----------------------------------------
     */
    for (
        const structInfo
        of this.database.structs
    ) {
        items.push(
            this.createStructItem(
                structInfo
            )
        );
    }

    /*
     * ----------------------------------------
     * Database Macros
     * ----------------------------------------
     */
    for (
        const macroInfo
        of this.database.macros
    ) {
        items.push(
            this.createMacroItem(
                macroInfo
            )
        );
    }

    /*
     * ----------------------------------------
     * Database Variables
     * ----------------------------------------
     */
    for (
        const variable
        of this.database.variables
    ) {
        items.push(
            this.createVariableItem(
                variable
            )
        );
    }

    return this.removeDuplicateItems(
        items
    );
}


    private provideMemberCompletion(
        type: string
    ): vscode.CompletionItem[] {
        const normalizedType =
            this.normalizeTypeName(
                type
            );

        const struct =
            this.database.findStruct(
                normalizedType
            );

        if (!struct) {
            return [];
        }

        return struct.Members.map(
            member => {
                const item =
                    new vscode.CompletionItem(
                        member.Name,
                        vscode.CompletionItemKind.Field
                    );

                item.detail =
                    `${member.Type}` +
                    (
                        member.Semantic
                            ? ` : ${member.Semantic}`
                            : ""
                    );

                item.documentation =
                    new vscode.MarkdownString(
                        this.formatMemberDocumentation(
                            member
                        )
                    );

                item.insertText =
                    member.Name;

                return item;
            }
        );
    }
    private formatMemberDocumentation(
        member: {
            Name: string;
            Type: string;
            Semantic?: string | null;
        }
    ): string {
        const semantic =
            member.Semantic
                ? ` : ${member.Semantic}`
                : "";

        return (
            `\`\`\`hlsl\n` +
            `${member.Type} ${member.Name}${semantic};` +
            `\n\`\`\``
        );
    }
private getMemberContext(
    document: vscode.TextDocument,
    position: vscode.Position
):
    { type: string } | undefined {
    const line =
        document
            .lineAt(
                position.line
            )
            .text;

    const prefix =
        line.substring(
            0,
            position.character
        );

    const match =
        prefix.match(
            /([A-Za-z_][A-Za-z0-9_]*)\.\s*[A-Za-z0-9_]*$/
        );

    if (!match) {
        return undefined;
    }

    const variableName =
        match[1];

    /*
     * 1. ローカル変数
     */
    const localVariable =
        this.shaderDocument.findVariable(
            document,
            variableName,
            position.line
        );

    if (localVariable) {
        return {
            type:
                localVariable.type
        };
    }

    /*
     * 2. 現在の関数の parameter
     */
    const currentFunction =
        this.shaderDocument
            .getFunctions(
                document
            )
            .find(
                functionInfo =>
                    position.line >=
                        functionInfo.startLine &&
                    position.line <=
                        functionInfo.endLine
            );

    if (currentFunction) {
        const parameter =
            currentFunction.parameters.find(
                x =>
                    x.name ===
                    variableName
            );

        if (parameter) {
            return {
                type:
                    parameter.type
            };
        }
    }

    /*
     * 3. Database global variable
     */
    const variable =
        this.database.findVariable(
            variableName
        );

    if (variable) {
        return {
            type:
                variable.Type
        };
    }

    return undefined;
}


private createLocalVariableItem(
    variable: {
        name: string;
        type: string;
    }
): vscode.CompletionItem {
    const item =
        new vscode.CompletionItem(
            variable.name,
            vscode.CompletionItemKind.Variable
        );

    item.detail =
        variable.type;

    item.insertText =
        variable.name;

    item.sortText =
        `0_${variable.name}`;

    item.documentation =
        new vscode.MarkdownString(
            `\`\`\`hlsl\n${variable.type} ${variable.name};\n\`\`\``
        );

    return item;
}


    private createIncludeItem(
        include: IncludeInfo
    ): vscode.CompletionItem {
        const item =
            new vscode.CompletionItem(
                include.Path,
                vscode.CompletionItemKind.File
            );

        item.insertText =
            include.Path;

        item.detail =
            include.ResolvedPath ??
            include.Package ??
            "Unity include";

        item.documentation =
            new vscode.MarkdownString(
                this.formatIncludeDocumentation(
                    include
                )
            );

        item.sortText =
            include.IsUrpInclude
                ? `0_${include.Path}`
                : include.IsUnityInclude
                    ? `1_${include.Path}`
                    : `2_${include.Path}`;

        return item;
    }

    private createFunctionItem(
        info: FunctionInfo
    ): vscode.CompletionItem {
        const item =
            new vscode.CompletionItem(
                info.Name,
                vscode.CompletionItemKind.Function
            );

        item.detail =
            info.Signature ??
            `${info.ReturnType} ${info.Name}(...)`;

        item.insertText =
            new vscode.SnippetString(
                this.createFunctionSnippet(
                    info
                )
            );

        return item;
    }

    private createStructItem(
        info: StructInfo
    ): vscode.CompletionItem {
        const item =
            new vscode.CompletionItem(
                info.Name,
                vscode.CompletionItemKind.Struct
            );

        item.detail =
            info.Signature ??
            `struct ${info.Name}`;

        item.insertText =
            info.Name;

        return item;
    }

    private createMacroItem(
        info: MacroInfo
    ): vscode.CompletionItem {
        const item =
            new vscode.CompletionItem(
                info.Name,
                vscode.CompletionItemKind.Keyword
            );

        item.detail =
            info.Signature ??
            `#define ${info.Name}`;

        item.insertText =
            info.Name;

        return item;
    }

    private createVariableItem(
        variable: ShaderVariableInfo
    ): vscode.CompletionItem {
        const item =
            new vscode.CompletionItem(
                variable.Name,
                vscode.CompletionItemKind.Variable
            );

        item.detail =
            this.getVariableDetail(
                variable
            );

        item.insertText =
            variable.Name;

        return item;
    }

    private getVariableDetail(
        variable: ShaderVariableInfo
    ): string {
        if (
            variable.IsTexture
        ) {
            return (
                `${variable.Type}` +
                ` (${variable.TextureDimension ?? "Texture"})`
            );
        }

        if (
            variable.IsSampler
        ) {
            return variable.Type;
        }

        if (
            variable.IsBuffer &&
            variable.ElementType
        ) {
            return (
                `${variable.Type}` +
                `<${variable.ElementType}>`
            );
        }

        return variable.Type;
    }

    private createFunctionSnippet(
        info: FunctionInfo
    ): string {
        if (
            info.Parameters.length === 0
        ) {
            return `${info.Name}()`;
        }

        const parameters =
            info.Parameters.map(
                (parameter, index) =>
                    `\${${index + 1}:${parameter.Name}}`
            );

        return (
            `${info.Name}` +
            `(${parameters.join(", ")})`
        );
    }

    private isIncludeCompletion(
        linePrefix: string
    ): boolean {
        return /^\s*#\s*include\s*[<"][^>"]*$/
            .test(
                linePrefix
            );
    }

    private normalizeTypeName(
        type: string
    ): string {
        return type
            .replace(
                /\b(const|in|out|inout|uniform)\b/g,
                ""
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim()
            .replace(
                /\*$/,
                ""
            );
    }

    private formatIncludeDocumentation(
        include: IncludeInfo
    ): string {
        const lines = [
            `**${include.Path}**`
        ];

        if (
            include.ResolvedPath
        ) {
            lines.push(
                "",
                `Resolved: \`${include.ResolvedPath}\``
            );
        }

        if (
            include.IsUrpInclude
        ) {
            lines.push(
                "",
                "Unity URP include"
            );
        }

        return lines.join("\n");
    }

private removeDuplicateItems(
    items: vscode.CompletionItem[]
): vscode.CompletionItem[] {
    const result:
        vscode.CompletionItem[] = [];

    const seen =
        new Set<string>();

    for (
        const item
        of items
    ) {
        const label =
            typeof item.label === "string"
                ? item.label
                : item.label.label;

        const kind =
            item.kind?.toString() ??
            "";

        const key =
            `${kind}:${label}`;

        if (
            seen.has(key)
        ) {
            continue;
        }

        seen.add(key);

        result.push(
            item
        );
    }

    return result;
}

    private createParameterItem(
    parameter: {
        name: string;
        type: string;
    }
): vscode.CompletionItem {
    const item =
        new vscode.CompletionItem(
            parameter.name,
            vscode.CompletionItemKind.Variable
        );

    item.detail =
        `${parameter.type} (parameter)`;

    item.insertText =
        parameter.name;

    item.sortText =
        `0_${parameter.name}`;

    item.documentation =
        new vscode.MarkdownString(
            `\`\`\`hlsl\n${parameter.type} ${parameter.name}\n\`\`\``
        );

    return item;
}
private createLocalStructItem(
    structInfo: {
        name: string;
        members: Array<{
            name: string;
            type: string;
            semantic?: string;
        }>;
    }
): vscode.CompletionItem {
    const item =
        new vscode.CompletionItem(
            structInfo.name,
            vscode.CompletionItemKind.Struct
        );

    item.detail =
        `struct ${structInfo.name}`;

    item.insertText =
        structInfo.name;

    const lines = [
        `struct ${structInfo.name}`,
        `{`
    ];

    for (
        const member
        of structInfo.members
    ) {
        const semantic =
            member.semantic
                ? ` : ${member.semantic}`
                : "";

        lines.push(
            `    ${member.type} ${member.name}${semantic};`
        );
    }

    lines.push(
        `}`
    );

    item.documentation =
        new vscode.MarkdownString(
            "```hlsl\n" +
            lines.join("\n") +
            "\n```"
        );

    item.sortText =
        `1_${structInfo.name}`;

    return item;
}

}
