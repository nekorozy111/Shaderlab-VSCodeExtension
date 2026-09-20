import {
    SourceRange
} from "../parser/token";

export type SymbolKind =
    | "shader"
    | "property"
    | "subShader"
    | "pass"
    | "struct"
    | "field"
    | "function"
    | "parameter"
    | "variable"
    | "cbuffer"
    | "macro"
    | "include";

export interface SymbolLocation {
    uri: string;

    range: SourceRange;

    selectionRange: SourceRange;
}

export interface ShaderSymbol {

    name: string;

    kind: SymbolKind;

    location: SymbolLocation;

    typeName?: string;

    returnType?: string;

    semantic?: string;

    parentName?: string;

    children: ShaderSymbol[];
}