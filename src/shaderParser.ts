import * as vscode from "vscode";

export interface ParsedStructMember {
    name: string;
    type: string;
    semantic?: string;
    line: number;
}

export interface ParsedStruct {
    name: string;
    members: ParsedStructMember[];
    line: number;
}

export interface ParsedVariable {
    name: string;
    type: string;
    line: number;
    scopeStart: number;
    scopeEnd: number;
}

export interface ParsedFunctionParameter {
    name: string;
    type: string;
    line: number;
}

export interface ParsedFunction {
    name: string;
    returnType: string;
    parameters: ParsedFunctionParameter[];
    startLine: number;
    endLine: number;
}

export interface ParsedShaderDocument {
    structs: ParsedStruct[];
    variables: ParsedVariable[];
    functions: ParsedFunction[];
}

export class ShaderParser {
    public parse(
        document: vscode.TextDocument
    ): ParsedShaderDocument {
        const text =
            document.getText();

        const lines =
            text.split(/\r?\n/);

        const structs =
            this.parseStructs(
                lines
            );

        const functions =
            this.parseFunctions(
                lines
            );

        const variables =
            this.parseVariables(
                lines,
                functions
            );

        return {
            structs,
            variables,
            functions
        };
    }

    private parseStructs(
        lines: string[]
    ): ParsedStruct[] {
        const result:
            ParsedStruct[] = [];

        for (
            let i = 0;
            i < lines.length;
            i++
        ) {
            const match =
                lines[i].match(
                    /^\s*struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/
                );

            if (!match) {
                continue;
            }

            const name =
                match[1];

            const members:
                ParsedStructMember[] = [];

            let depth = 0;
            let endLine = i;

            for (
                let j = i;
                j < lines.length;
                j++
            ) {
                const line =
                    lines[j];

                for (
                    const character
                    of line
                ) {
                    if (
                        character === "{"
                    ) {
                        depth++;
                    } else if (
                        character === "}"
                    ) {
                        depth--;

                        if (
                            depth === 0
                        ) {
                            endLine = j;
                            break;
                        }
                    }
                }

                if (
                    j !== i &&
                    depth > 0
                ) {
                    const member =
                        this.parseStructMember(
                            lines[j],
                            j
                        );

                    if (member) {
                        members.push(
                            member
                        );
                    }
                }

                if (
                    depth === 0 &&
                    j >= i
                ) {
                    endLine = j;
                    break;
                }
            }

            result.push({
                name,
                members,
                line: i
            });

            i = endLine;
        }

        return result;
    }

    private parseStructMember(
        line: string,
        lineNumber: number
    ):
        ParsedStructMember | undefined {
        const match =
            line.match(
                /^\s*(?:const\s+)?([A-Za-z_][A-Za-z0-9_<>,\[\]\s]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\:\s*([A-Za-z_][A-Za-z0-9_]*))?\s*;/
            );

        if (!match) {
            return undefined;
        }

        return {
            type:
                this.normalizeType(
                    match[1]
                ),

            name:
                match[2],

            semantic:
                match[3],

            line:
                lineNumber
        };
    }

    private parseFunctions(
        lines: string[]
    ): ParsedFunction[] {
        const result:
            ParsedFunction[] = [];

        /*
         * 関数宣言は複数行になる可能性があるため、
         * まずテキストを連結して検索する。
         */
        const text =
            lines.join("\n");

        const regex =
            /(?:^|\n)\s*(?:(?:inline|static|extern|precise|const)\s+)*([A-Za-z_][A-Za-z0-9_<>,\[\]\s\*]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^{};]*)\)\s*\{/g;

        let match:
            RegExpExecArray | null;

        while (
            (match = regex.exec(text))
                !== null
        ) {
            const returnType =
                this.normalizeType(
                    match[1]
                );

            const name =
                match[2];

            if (
                this.isControlKeyword(
                    name
                )
            ) {
                continue;
            }

            const parameters =
                this.parseParameters(
                    match[3],
                    this.getLineNumber(
                        text,
                        match.index
                    )
                );

            const startLine =
                this.getLineNumber(
                    text,
                    match.index
                );

            const braceIndex =
                text.indexOf(
                    "{",
                    match.index
                );

            const endLine =
                this.findBlockEndLine(
                    text,
                    braceIndex
                );

            result.push({
                name,
                returnType,
                parameters,
                startLine,
                endLine
            });
        }

        return result;
    }

    private parseParameters(
        text: string,
        baseLine: number
    ): ParsedFunctionParameter[] {
        if (
            text.trim().length === 0
        ) {
            return [];
        }

        const result:
            ParsedFunctionParameter[] = [];

        for (
            const raw
            of this.splitParameters(
                text
            )
        ) {
            let parameter =
                raw.trim();

            if (
                parameter.length === 0
            ) {
                continue;
            }

            parameter =
                parameter.replace(
                    /\b(inout|in|out|uniform|const)\b/g,
                    ""
                ).trim();

            const parts =
                parameter.split(
                    /\s+/
                );

            if (
                parts.length < 2
            ) {
                continue;
            }

            const name =
                parts[parts.length - 1];

            const type =
                this.normalizeType(
                    parts
                        .slice(
                            0,
                            -1
                        )
                        .join(" ")
                );

            result.push({
                name,
                type,
                line: baseLine
            });
        }

        return result;
    }

    private parseVariables(
        lines: string[],
        functions: ParsedFunction[]
    ): ParsedVariable[] {
        const result:
            ParsedVariable[] = [];

        for (
            let i = 0;
            i < lines.length;
            i++
        ) {
            /*
             * struct 内部の member は通常の variable として
             * 扱わない。
             */
            if (
                this.isInsideStruct(
                    lines,
                    i
                )
            ) {
                continue;
            }

            const match =
                lines[i].match(
                    /^\s*(?:(?:const|static|uniform|precise|volatile)\s+)*([A-Za-z_][A-Za-z0-9_<>,\[\]\s\*]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*(?:=[^;]+)?;/
                );

            if (!match) {
                continue;
            }

            const type =
                this.normalizeType(
                    match[1]
                );

            const name =
                match[2];

            if (
                !this.looksLikeType(
                    type
                )
            ) {
                continue;
            }

            const scope =
                this.findContainingScope(
                    i,
                    functions
                );

            result.push({
                name,
                type,
                line: i,

                scopeStart:
                    scope?.start ??
                    0,

                scopeEnd:
                    scope?.end ??
                    lines.length - 1
            });
        }

        return result;
    }

    private isInsideStruct(
        lines: string[],
        lineNumber: number
    ): boolean {
        let depth = 0;
        let insideStruct = false;

        for (
            let i = 0;
            i <= lineNumber;
            i++
        ) {
            const line =
                lines[i];

            if (
                /^\s*struct\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/
                    .test(line)
            ) {
                insideStruct = true;
            }

            for (
                const character
                of line
            ) {
                if (
                    character === "{"
                ) {
                    depth++;
                } else if (
                    character === "}"
                ) {
                    depth--;

                    if (
                        depth === 0 &&
                        insideStruct
                    ) {
                        insideStruct = false;
                    }
                }
            }
        }

        return insideStruct;
    }

    private findContainingScope(
        line: number,
        functions: ParsedFunction[]
    ):
        { start: number; end: number }
        | undefined {
        for (
            const functionInfo
            of functions
        ) {
            if (
                line >= functionInfo.startLine &&
                line <= functionInfo.endLine
            ) {
                return {
                    start:
                        functionInfo.startLine,

                    end:
                        functionInfo.endLine
                };
            }
        }

        return undefined;
    }

    private findBlockEndLine(
        text: string,
        braceIndex: number
    ): number {
        if (
            braceIndex < 0
        ) {
            return 0;
        }

        let depth = 0;

        for (
            let i = braceIndex;
            i < text.length;
            i++
        ) {
            if (
                text[i] === "{"
            ) {
                depth++;
            } else if (
                text[i] === "}"
            ) {
                depth--;

                if (
                    depth === 0
                ) {
                    return this.getLineNumber(
                        text,
                        i
                    );
                }
            }
        }

        return this.getLineNumber(
            text,
            text.length
        );
    }

    private splitParameters(
        text: string
    ): string[] {
        const result: string[] = [];

        let depth = 0;
        let start = 0;

        for (
            let i = 0;
            i < text.length;
            i++
        ) {
            const character =
                text[i];

            if (
                character === "<"
            ) {
                depth++;
            } else if (
                character === ">"
            ) {
                depth--;
            } else if (
                character === "," &&
                depth === 0
            ) {
                result.push(
                    text.substring(
                        start,
                        i
                    )
                );

                start =
                    i + 1;
            }
        }

        result.push(
            text.substring(
                start
            )
        );

        return result;
    }

    private getLineNumber(
        text: string,
        position: number
    ): number {
        let line = 0;

        for (
            let i = 0;
            i < position;
            i++
        ) {
            if (
                text[i] === "\n"
            ) {
                line++;
            }
        }

        return line;
    }

    private normalizeType(
        type: string
    ): string {
        return type
            .replace(
                /\s+/g,
                " "
            )
            .trim();
    }

    private looksLikeType(
        type: string
    ): boolean {
        const knownTypes = [
            "float",
            "float2",
            "float3",
            "float4",
            "half",
            "half2",
            "half3",
            "half4",
            "real",
            "real2",
            "real3",
            "real4",
            "int",
            "int2",
            "int3",
            "int4",
            "uint",
            "uint2",
            "uint3",
            "uint4",
            "bool",
            "bool2",
            "bool3",
            "bool4",
            "double",
            "double2",
            "double3",
            "double4"
        ];

        if (
            knownTypes.includes(
                type
            )
        ) {
            return true;
        }

        /*
         * User-defined struct
         */
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(
            type
        );
    }

    private isControlKeyword(
        name: string
    ): boolean {
        return [
            "if",
            "for",
            "while",
            "switch",
            "catch"
        ].includes(name);
    }
}
