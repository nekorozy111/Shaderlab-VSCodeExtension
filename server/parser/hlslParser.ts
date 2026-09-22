import {
  HlslCBufferNode,
  HlslDeclarationNode,
  HlslDocumentNode,
  HlslFunctionNode,
  HlslIncludeNode,
  HlslMacroNode,
  HlslParameterNode,
  HlslStructNode,
  HlslVariableNode,
} from './ast';

import { SourcePosition, SourceRange, Token } from './token';

import { Tokenizer } from './tokenizer';

export class HlslParser {
  private readonly source: string;

  private readonly tokens: Token[];

  private index = 0;

  public constructor(source: string) {
    this.source = source;

    this.tokens = new Tokenizer(source).tokenize();
  }

  public parse(): HlslDocumentNode {
    const declarations: HlslDeclarationNode[] = [];

    while (!this.isAtEnd()) {
      const wasPreprocessor = this.current().kind === 'preprocessor';

      const declaration = this.parseDeclaration();

      if (declaration) {
        declarations.push(declaration);
      } else {
        /*
         * parsePreprocessor() は #endif / #else / #elif / #ifdef
         * などを消費して undefined を返す場合がある。
         *
         * その場合、parsePreprocessor() 自身がすでに
         * 次のトークンまで進んでいるので、
         * ここで advance() してはいけない。
         */
        if (wasPreprocessor) {
          continue;
        }

        this.advance();
      }
    }

    return {
      kind: 'HlslDocument',

      declarations,

      range: {
        start: {
          offset: 0,
          line: 0,
          character: 0,
        },

        end: this.positionFromOffset(this.source.length),
      },
    };
  }

  private parseDeclaration(): HlslDeclarationNode | undefined {
    if (this.current().kind === 'preprocessor') {
      return this.parsePreprocessor();
    }

    if (this.checkIdentifier('struct')) {
      return this.parseStruct();
    }

    if (this.checkIdentifier('CBUFFER_START')) {
      return this.parseCBuffer();
    }

    return this.parseFunctionOrVariable();
  }

  private parsePreprocessor(): HlslDeclarationNode | undefined {
    const startToken = this.current();

    this.advance();

    if (!this.currentIsIdentifier()) {
      return undefined;
    }

    const directive = this.current().value;

    this.advance();

    if (directive === 'include') {
      const includeToken = this.current();

      if (includeToken.kind === 'string') {
        this.advance();

        const node: HlslIncludeNode = {
          kind: 'HlslInclude',

          path: includeToken.value,

          range: {
            start: startToken.range.start,

            end: includeToken.range.end,
          },
        };

        return node;
      }

      return undefined;
    }

    if (directive === 'define') {
      const nameToken = this.current();

      if (nameToken.kind !== 'identifier') {
        return undefined;
      }

      this.advance();

      const startLine = startToken.range.start.line;

      const valueTokens: Token[] = [];

      while (!this.isAtEnd() && this.current().range.start.line === startLine) {
        valueTokens.push(this.current());

        this.advance();
      }

      const value = valueTokens.map((token) => token.value).join(' ');

      const end = valueTokens.length > 0 ? valueTokens[valueTokens.length - 1].range.end : nameToken.range.end;

      const node: HlslMacroNode = {
        kind: 'HlslMacro',

        name: nameToken.value,

        value,

        range: {
          start: startToken.range.start,

          end,
        },
      };

      return node;
    }

    return undefined;
  }

  private parseStruct(): HlslStructNode | undefined {
    const startToken = this.current();

    this.advance();

    const nameToken = this.current();

    if (nameToken.kind !== 'identifier') {
      return undefined;
    }

    this.advance();

    if (!this.checkValue('{')) {
      return undefined;
    }

    this.advance();

    const fields: HlslVariableNode[] = [];

    while (!this.isAtEnd() && !this.checkValue('}')) {
      const field = this.parseVariableStatement();

      if (field !== undefined) {
        fields.push(field);
        continue;
      }

      this.advance();
    }

    let end = nameToken.range.end;

    if (this.checkValue('}')) {
      end = this.current().range.end;
      this.advance();
    }

    if (this.checkValue(';')) {
      end = this.current().range.end;
      this.advance();
    }

    return {
      kind: 'HlslStruct',

      name: nameToken.value,

      fields,

      range: {
        start: startToken.range.start,

        end,
      },
    };
  }

  private parseCBuffer(): HlslCBufferNode | undefined {
    const startToken = this.current();

    this.advance();

    if (!this.checkValue('(')) {
      return undefined;
    }

    this.advance();

    const nameToken = this.current();

    if (nameToken.kind !== 'identifier') {
      return undefined;
    }

    this.advance();

    if (this.checkValue(')')) {
      this.advance();
    }

    const fields: HlslVariableNode[] = [];

    while (!this.isAtEnd()) {
      if (this.checkIdentifier('CBUFFER_END')) {
        const endToken = this.current();

        this.advance();

        return {
          kind: 'HlslCBuffer',

          name: nameToken.value,

          fields,

          range: {
            start: startToken.range.start,

            end: endToken.range.end,
          },
        };
      }

      const variable = this.parseVariableStatement();

      if (variable !== undefined) {
        fields.push(variable);
        continue;
      }

      this.advance();
    }

    return {
      kind: 'HlslCBuffer',

      name: nameToken.value,

      fields,

      range: {
        start: startToken.range.start,

        end: nameToken.range.end,
      },
    };
  }

  private parseFunctionOrVariable(): HlslFunctionNode | HlslVariableNode | undefined {
    const startIndex = this.index;

    const typeToken = this.current();

    if (typeToken.kind !== 'identifier') {
      return undefined;
    }

    this.advance();

    const nameToken = this.current();

    if (nameToken.kind !== 'identifier') {
      this.index = startIndex;

      return undefined;
    }

    this.advance();

    if (this.checkValue('(')) {
      return this.parseFunctionAfterName(typeToken, nameToken);
    }

    this.index = startIndex;

    return this.parseVariableStatement();
  }

  private parseFunctionAfterName(typeToken: Token, nameToken: Token): HlslFunctionNode {
    this.advance();

    const parameters: HlslParameterNode[] = [];

    while (!this.isAtEnd() && !this.checkValue(')')) {
      const parameter = this.parseParameter();

      if (parameter !== undefined) {
        parameters.push(parameter);
      } else {
        this.advance();
      }

      if (this.checkValue(',')) {
        this.advance();
      }
    }

    let end = nameToken.range.end;

    if (this.checkValue(')')) {
      end = this.current().range.end;
      this.advance();
    }

    if (this.checkValue(':')) {
      this.advance();

      if (this.current().kind === 'identifier') {
        end = this.current().range.end;

        this.advance();
      }
    }

    if (this.checkValue(';')) {
      end = this.current().range.end;

      this.advance();

      return {
        kind: 'HlslFunction',

        returnType: typeToken.value,

        name: nameToken.value,

        parameters,

        range: {
          start: typeToken.range.start,

          end,
        },
      };
    }

    if (this.checkValue('{')) {
      let depth = 0;

      while (!this.isAtEnd()) {
        const token = this.current();

        if (token.value === '{') {
          depth++;
        }

        if (token.value === '}') {
          depth--;

          end = token.range.end;

          this.advance();

          if (depth <= 0) {
            break;
          }

          continue;
        }

        this.advance();
      }
    }

    return {
      kind: 'HlslFunction',

      returnType: typeToken.value,

      name: nameToken.value,

      parameters,

      range: {
        start: typeToken.range.start,

        end,
      },
    };
  }

  private parseParameter(): HlslParameterNode | undefined {
    const startIndex = this.index;

    const qualifierTokens: Token[] = [];

    while (
      this.checkIdentifier('in') ||
      this.checkIdentifier('out') ||
      this.checkIdentifier('inout') ||
      this.checkIdentifier('const') ||
      this.checkIdentifier('uniform')
    ) {
      qualifierTokens.push(this.current());

      this.advance();
    }

    const typeToken = this.current();

    if (typeToken.kind !== 'identifier') {
      this.index = startIndex;

      return undefined;
    }

    this.advance();

    const nameToken = this.current();

    if (nameToken.kind !== 'identifier') {
      this.index = startIndex;

      return undefined;
    }

    this.advance();

    let semantic: string | undefined;

    let end = nameToken.range.end;

    if (this.checkValue(':')) {
      this.advance();

      if (this.current().kind === 'identifier') {
        semantic = this.current().value;

        end = this.current().range.end;

        this.advance();
      }
    }

    const start = qualifierTokens.length > 0 ? qualifierTokens[0].range.start : typeToken.range.start;

    return {
      kind: 'HlslParameter',

      typeName: typeToken.value,

      name: nameToken.value,

      semantic,

      range: {
        start,
        end,
      },
    };
  }

  private parseVariableStatement(): HlslVariableNode | undefined {
    const startIndex = this.index;

    while (
      this.checkIdentifier('const') ||
      this.checkIdentifier('static') ||
      this.checkIdentifier('uniform') ||
      this.checkIdentifier('volatile')
    ) {
      this.advance();
    }

    const typeToken = this.current();

    if (typeToken.kind !== 'identifier') {
      this.index = startIndex;

      return undefined;
    }

    this.advance();

    const nameToken = this.current();

    if (nameToken.kind !== 'identifier') {
      this.index = startIndex;

      return undefined;
    }

    this.advance();

    if (this.checkValue('(')) {
      this.index = startIndex;

      return undefined;
    }

    let semantic: string | undefined;

    let end = nameToken.range.end;

    if (this.checkValue('[')) {
      let depth = 0;

      while (!this.isAtEnd()) {
        const token = this.current();

        if (token.value === '[') {
          depth++;
        }

        if (token.value === ']') {
          depth--;

          end = token.range.end;

          this.advance();

          if (depth <= 0) {
            break;
          }

          continue;
        }

        this.advance();
      }
    }

    if (this.checkValue(':')) {
      this.advance();

      if (this.current().kind === 'identifier') {
        semantic = this.current().value;

        end = this.current().range.end;

        this.advance();
      }
    }

    while (!this.isAtEnd() && !this.checkValue(';')) {
      if (this.checkValue('{') || this.checkValue('}')) {
        this.index = startIndex;

        return undefined;
      }

      this.advance();
    }

    if (!this.checkValue(';')) {
      this.index = startIndex;

      return undefined;
    }

    end = this.current().range.end;

    this.advance();

    return {
      kind: 'HlslVariable',

      typeName: typeToken.value,

      name: nameToken.value,

      semantic,

      range: {
        start: typeToken.range.start,

        end,
      },
    };
  }

  private current(): Token {
    return this.tokens[Math.min(this.index, this.tokens.length - 1)];
  }

  private advance(): Token {
    const token = this.current();

    if (!this.isAtEnd()) {
      this.index++;
    }

    return token;
  }

  private isAtEnd(): boolean {
    return this.current().kind === 'eof';
  }

  private currentIsIdentifier(): boolean {
    return this.current().kind === 'identifier';
  }

  private checkIdentifier(value: string): boolean {
    return this.current().kind === 'identifier' && this.current().value === value;
  }

  private checkValue(value: string): boolean {
    return this.current().value === value;
  }

  private positionFromOffset(offset: number): SourcePosition {
    let line = 0;
    let character = 0;

    for (let index = 0; index < offset; index++) {
      if (this.source[index] === '\n') {
        line++;
        character = 0;
      } else {
        character++;
      }
    }

    return {
      offset,
      line,
      character,
    };
  }
}
