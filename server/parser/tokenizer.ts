import {
    SourcePosition,
    Token,
    TokenKind
} from "./token";

const TWO_CHARACTER_OPERATORS = new Set<string>([
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "<<",
    ">>",
    "->",
    "::",
    "&=",
    "|=",
    "^="
]);

const ONE_CHARACTER_OPERATORS = new Set<string>([
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "<",
    ">",
    "!",
    "&",
    "|",
    "^",
    "~",
    "?"
]);

const SYMBOLS = new Set<string>([
    "{",
    "}",
    "(",
    ")",
    "[",
    "]",
    ";",
    ",",
    ":",
    "."
]);

export class Tokenizer {

    private readonly source: string;

    private offset = 0;
    private line = 0;
    private character = 0;

    public constructor(source: string) {
        this.source = source;
    }

    public tokenize(): Token[] {

        const tokens: Token[] = [];

        while (!this.isAtEnd()) {

            this.skipWhitespaceAndComments();

            if (this.isAtEnd()) {
                break;
            }

            const token = this.readToken();

            if (token !== undefined) {
                tokens.push(token);
            }
        }

        const eofPosition = this.currentPosition();

        tokens.push({
            kind: "eof",
            value: "",
            range: {
                start: eofPosition,
                end: eofPosition
            }
        });

        return tokens;
    }

    private readToken(): Token | undefined {

        const char = this.peek();

        if (char === undefined) {
            return undefined;
        }

        if (char === "#") {
            return this.readPreprocessorMarker();
        }

        if (this.isIdentifierStart(char)) {
            return this.readIdentifier();
        }

        if (this.isDigit(char)) {
            return this.readNumber();
        }

        if (char === "\"" || char === "'") {
            return this.readString();
        }

        const twoCharacters =
            `${char}${this.peek(1) ?? ""}`;

        if (
            TWO_CHARACTER_OPERATORS.has(
                twoCharacters
            )
        ) {
            return this.readFixedLengthToken(
                "operator",
                2
            );
        }

        if (ONE_CHARACTER_OPERATORS.has(char)) {
            return this.readFixedLengthToken(
                "operator",
                1
            );
        }

        if (SYMBOLS.has(char)) {
            return this.readFixedLengthToken(
                "symbol",
                1
            );
        }

        return this.readFixedLengthToken(
            "unknown",
            1
        );
    }

    private readIdentifier(): Token {

        const start = this.currentPosition();

        let value = "";

        while (!this.isAtEnd()) {

            const char = this.peek();

            if (
                char === undefined ||
                !this.isIdentifierPart(char)
            ) {
                break;
            }

            value += char;
            this.advance();
        }

        return {
            kind: "identifier",
            value,
            range: {
                start,
                end: this.currentPosition()
            }
        };
    }

    private readNumber(): Token {

        const start = this.currentPosition();

        let value = "";

        let hasDot = false;

        while (!this.isAtEnd()) {

            const char = this.peek();

            if (char === undefined) {
                break;
            }

            if (this.isDigit(char)) {
                value += char;
                this.advance();
                continue;
            }

            if (
                char === "." &&
                !hasDot
            ) {
                hasDot = true;
                value += char;
                this.advance();
                continue;
            }

            if (
                char === "f" ||
                char === "F" ||
                char === "h" ||
                char === "H" ||
                char === "u" ||
                char === "U"
            ) {
                value += char;
                this.advance();
                break;
            }

            break;
        }

        return {
            kind: "number",
            value,
            range: {
                start,
                end: this.currentPosition()
            }
        };
    }

    private readString(): Token {

        const start = this.currentPosition();

        const quote = this.peek();

        let value = "";

        if (quote === undefined) {
            return {
                kind: "string",
                value,
                range: {
                    start,
                    end: start
                }
            };
        }

        this.advance();

        while (!this.isAtEnd()) {

            const char = this.peek();

            if (char === undefined) {
                break;
            }

            if (char === "\\") {

                value += char;
                this.advance();

                const escaped = this.peek();

                if (escaped !== undefined) {
                    value += escaped;
                    this.advance();
                }

                continue;
            }

            if (char === quote) {
                this.advance();
                break;
            }

            value += char;
            this.advance();
        }

        return {
            kind: "string",
            value,
            range: {
                start,
                end: this.currentPosition()
            }
        };
    }

    private readPreprocessorMarker(): Token {

        const start = this.currentPosition();

        this.advance();

        return {
            kind: "preprocessor",
            value: "#",
            range: {
                start,
                end: this.currentPosition()
            }
        };
    }

    private readFixedLengthToken(
        kind: TokenKind,
        length: number
    ): Token {

        const start = this.currentPosition();

        let value = "";

        for (
            let index = 0;
            index < length;
            index++
        ) {

            const char = this.peek();

            if (char === undefined) {
                break;
            }

            value += char;
            this.advance();
        }

        return {
            kind,
            value,
            range: {
                start,
                end: this.currentPosition()
            }
        };
    }

    private skipWhitespaceAndComments(): void {

        while (!this.isAtEnd()) {

            const char = this.peek();

            if (char === undefined) {
                return;
            }

            if (this.isWhitespace(char)) {
                this.advance();
                continue;
            }

            if (
                char === "/" &&
                this.peek(1) === "/"
            ) {
                this.skipLineComment();
                continue;
            }

            if (
                char === "/" &&
                this.peek(1) === "*"
            ) {
                this.skipBlockComment();
                continue;
            }

            return;
        }
    }

    private skipLineComment(): void {

        this.advance();
        this.advance();

        while (!this.isAtEnd()) {

            const char = this.peek();

            if (
                char === undefined ||
                char === "\n"
            ) {
                return;
            }

            this.advance();
        }
    }

    private skipBlockComment(): void {

        this.advance();
        this.advance();

        while (!this.isAtEnd()) {

            if (
                this.peek() === "*" &&
                this.peek(1) === "/"
            ) {
                this.advance();
                this.advance();
                return;
            }

            this.advance();
        }
    }

    private currentPosition(): SourcePosition {

        return {
            offset: this.offset,
            line: this.line,
            character: this.character
        };
    }

    private peek(
        lookahead = 0
    ): string | undefined {

        return this.source[
            this.offset + lookahead
        ];
    }

    private advance(): void {

        if (this.isAtEnd()) {
            return;
        }

        const char =
            this.source[this.offset];

        this.offset++;

        if (char === "\n") {
            this.line++;
            this.character = 0;
        } else {
            this.character++;
        }
    }

    private isAtEnd(): boolean {

        return this.offset >=
            this.source.length;
    }

    private isWhitespace(
        char: string
    ): boolean {

        return (
            char === " " ||
            char === "\t" ||
            char === "\r" ||
            char === "\n"
        );
    }

    private isIdentifierStart(
        char: string
    ): boolean {

        return (
            this.isLetter(char) ||
            char === "_"
        );
    }

    private isIdentifierPart(
        char: string
    ): boolean {

        return (
            this.isIdentifierStart(char) ||
            this.isDigit(char)
        );
    }

    private isLetter(
        char: string
    ): boolean {

        return (
            (char >= "a" && char <= "z") ||
            (char >= "A" && char <= "Z")
        );
    }

    private isDigit(
        char: string
    ): boolean {

        return (
            char >= "0" &&
            char <= "9"
        );
    }
}