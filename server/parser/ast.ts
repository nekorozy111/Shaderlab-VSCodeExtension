import {
    SourceRange
} from "./token";

export interface AstNode {
    kind: string;
    range: SourceRange;
}

/* =========================================================
 * HLSL
 * =======================================================*/

export interface HlslParameterNode
    extends AstNode {

    kind: "HlslParameter";

    typeName: string;
    name: string;

    semantic?: string;
}

export interface HlslVariableNode
    extends AstNode {

    kind: "HlslVariable";

    typeName: string;
    name: string;

    semantic?: string;
}

export interface HlslStructNode
    extends AstNode {

    kind: "HlslStruct";

    name: string;

    fields: HlslVariableNode[];
}

export interface HlslFunctionNode
    extends AstNode {

    kind: "HlslFunction";

    returnType: string;
    name: string;

    parameters: HlslParameterNode[];
}

export interface HlslIncludeNode
    extends AstNode {

    kind: "HlslInclude";

    path: string;
}

export interface HlslMacroNode
    extends AstNode {

    kind: "HlslMacro";

    name: string;
    value: string;
}

export interface HlslCBufferNode
    extends AstNode {

    kind: "HlslCBuffer";

    name: string;

    fields: HlslVariableNode[];
}

export type HlslDeclarationNode =
    | HlslStructNode
    | HlslFunctionNode
    | HlslVariableNode
    | HlslIncludeNode
    | HlslMacroNode
    | HlslCBufferNode;

export interface HlslDocumentNode
    extends AstNode {

    kind: "HlslDocument";

    declarations:
        HlslDeclarationNode[];
}

/* =========================================================
 * ShaderLab
 * =======================================================*/

export interface ShaderPropertyNode
    extends AstNode {

    kind: "ShaderProperty";

    name: string;

    displayName?: string;

    propertyType?: string;

    defaultValue?: string;

    attributes: string[];
}

export interface ShaderTagEntryNode
    extends AstNode {

    kind: "ShaderTagEntry";

    key: string;
    value: string;
}

export interface ShaderTagsNode
    extends AstNode {

    kind: "ShaderTags";

    entries: ShaderTagEntryNode[];
}

export interface ShaderHlslBlockNode
    extends AstNode {

    kind: "ShaderHlslBlock";

    blockType:
        | "HLSLPROGRAM"
        | "HLSLINCLUDE"
        | "CGPROGRAM";

    source: string;

    hlsl: HlslDocumentNode;
}

export interface ShaderPassNode
    extends AstNode {

    kind: "ShaderPass";

    name?: string;

    tags?: ShaderTagsNode;

    hlslBlocks:
        ShaderHlslBlockNode[];
}

export interface ShaderSubShaderNode
    extends AstNode {

    kind: "ShaderSubShader";

    tags?: ShaderTagsNode;

    passes:
        ShaderPassNode[];

    hlslBlocks:
        ShaderHlslBlockNode[];
}

export interface ShaderDocumentNode
    extends AstNode {

    kind: "ShaderDocument";

    shaderName?: string;

    properties:
        ShaderPropertyNode[];

    subShaders:
        ShaderSubShaderNode[];

    hlslBlocks:
        ShaderHlslBlockNode[];
}

/* =========================================================
 * Parsed document wrapper
 * =======================================================*/

export type ParsedAst =
    | ShaderDocumentNode
    | HlslDocumentNode;

export interface ParsedDocument {
    uri: string;

    languageId: string;

    version: number;

    ast: ParsedAst;
}