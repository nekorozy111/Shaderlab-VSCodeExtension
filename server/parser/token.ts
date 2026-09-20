export type TokenKind =
    | "identifier"
    | "number"
    | "string"
    | "symbol"
    | "operator"
    | "preprocessor"
    | "unknown"
    | "eof";

export interface SourcePosition {
    offset: number;
    line: number;
    character: number;
}

export interface SourceRange {
    start: SourcePosition;
    end: SourcePosition;
}

export interface Token {
    kind: TokenKind;
    value: string;
    range: SourceRange;
}

export function createPosition(
    offset: number,
    line: number,
    character: number
): SourcePosition {
    return {
        offset,
        line,
        character
    };
}

export function createRange(
    start: SourcePosition,
    end: SourcePosition
): SourceRange {
    return {
        start,
        end
    };
}