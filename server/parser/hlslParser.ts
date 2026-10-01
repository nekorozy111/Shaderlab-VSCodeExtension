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
import { SourcePosition, Token } from './token';
import { Tokenizer } from './tokenizer';

export class HlslParser {
  private readonly source: string;
  private readonly tokens: Token[];
  // offsetから位置を求めるための行頭offset表。毎回ソース先頭を走査しない。
  private readonly lineStartOffsets: number[];
  private index = 0;
  public constructor(source: string, tokens?: Token[]) {
    this.source = source;
    this.lineStartOffsets = [0];
    for (let index = 0; index < source.length; index++) {
      if (source[index] === '\n') {
        this.lineStartOffsets.push(index + 1);
      }
    }
    this.tokens = tokens ?? new Tokenizer(source).tokenize();
  }

  public parse(): HlslDocumentNode {
    const declarations: HlslDeclarationNode[] = [];
    while (!this.isAtEnd()) {
      const wasPreprocessor = this.current().kind === 'preprocessor';
      const parsedDeclarations = this.parseDeclaration();
      if (parsedDeclarations.length > 0) {
        declarations.push(...parsedDeclarations);
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

  private parseDeclaration(): HlslDeclarationNode[] {
    if (this.current().kind === 'preprocessor') {
      const declaration = this.parsePreprocessor();
      return declaration ? [declaration] : [];
    }

    if (this.checkIdentifier('struct')) {
      const declaration = this.parseStruct();
      return declaration ? [declaration] : [];
    }

    if (this.checkIdentifier('CBUFFER_START') || this.checkIdentifier('cbuffer') || this.checkIdentifier('tbuffer')) {
      const declaration = this.parseCBuffer();
      return declaration ? [declaration] : [];
    }

    const parsed = this.parseFunctionOrVariables();
    if (parsed.function) {
      return [parsed.function];
    }
    return parsed.variables;
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

      // #include <Foo.hlsl> はTokenizer上では複数tokenになるため、
      // 山括弧を含む1行をinclude pathとして組み立てる。
      if (includeToken.value === '<') {
        const pathTokens: Token[] = [];
        this.advance();
        while (!this.isAtEnd() && this.current().range.start.line === startToken.range.start.line) {
          if (this.current().value === '>') {
            const endToken = this.current();
            this.advance();
            const node: HlslIncludeNode = {
              kind: 'HlslInclude',
              path: this.source.slice(includeToken.range.end.offset, endToken.range.start.offset).trim(),
              range: {
                start: startToken.range.start,
                end: endToken.range.end,
              },
            };
            return node;
          }
          pathTokens.push(this.current());
          this.advance();
        }
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
      const parsedFields = this.parseVariableStatements();
      if (parsedFields.length > 0) {
        fields.push(...parsedFields);
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
    const macroStyle = startToken.value === 'CBUFFER_START';
    this.advance();

    let nameToken: Token | undefined;
    if (macroStyle) {
      if (!this.checkValue('(')) {
        return undefined;
      }
      this.advance();
      nameToken = this.current();
      if (nameToken.kind !== 'identifier') {
        return undefined;
      }
      this.advance();
      if (this.checkValue(')')) {
        this.advance();
      }
    } else {
      nameToken = this.current();
      if (nameToken.kind !== 'identifier') {
        return undefined;
      }
      this.advance();
      // cbuffer Name : register(b0) / tbuffer Name : register(b0)
      if (this.checkValue(':')) {
        this.skipBalancedDeclarationSuffix();
      }
    }

    const fields: HlslVariableNode[] = [];
    let end = nameToken.range.end;

    if (macroStyle) {
      while (!this.isAtEnd()) {
        if (this.checkIdentifier('CBUFFER_END')) {
          const endToken = this.current();
          this.advance();
          end = endToken.range.end;
          return { kind: 'HlslCBuffer', name: nameToken.value, fields, range: { start: startToken.range.start, end } };
        }
        const parsedFields = this.parseVariableStatements();
        if (parsedFields.length > 0) {
          fields.push(...parsedFields);
          end = parsedFields[parsedFields.length - 1].range.end;
          continue;
        }
        this.advance();
      }
    } else {
      if (!this.checkValue('{')) {
        return undefined;
      }
      this.advance();
      while (!this.isAtEnd() && !this.checkValue('}')) {
        const parsedFields = this.parseVariableStatements();
        if (parsedFields.length > 0) {
          fields.push(...parsedFields);
          end = parsedFields[parsedFields.length - 1].range.end;
          continue;
        }
        this.advance();
      }
      if (this.checkValue('}')) {
        end = this.current().range.end;
        this.advance();
      }
      if (this.checkValue(';')) {
        end = this.current().range.end;
        this.advance();
      }
    }

    return { kind: 'HlslCBuffer', name: nameToken.value, fields, range: { start: startToken.range.start, end } };
  }

  private skipBalancedDeclarationSuffix(): void {
    // register(...) など、宣言名の後ろにある属性/semanticを次の宣言まで読み飛ばす。
    this.advance();
    let depth = 0;
    while (!this.isAtEnd()) {
      if (this.checkValue('(')) depth++;
      if (this.checkValue(')')) {
        depth--;
        this.advance();
        if (depth <= 0) break;
        continue;
      }
      this.advance();
    }
  }

  private parseFunctionOrVariables(): { function?: HlslFunctionNode; variables: HlslVariableNode[] } {
    const startIndex = this.index;
    const typeToken = this.parseTypeName();
    if (typeToken === undefined) {
      return { variables: [] };
    }

    const nameToken = this.current();
    if (nameToken.kind !== 'identifier') {
      this.index = startIndex;
      return { variables: [] };
    }

    this.advance();
    if (this.checkValue('(')) {
      return { function: this.parseFunctionAfterName(typeToken, nameToken), variables: [] };
    }

    this.index = startIndex;
    return { variables: this.parseVariableStatements() };
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

    const locals: HlslVariableNode[] = [];
    if (this.checkValue(';')) {
      end = this.current().range.end;
      this.advance();
      return {
        kind: 'HlslFunction',
        returnType: typeToken.value,
        name: nameToken.value,
        parameters,
        locals,
        range: {
          start: typeToken.range.start,
          end,
        },
      };
    }

    if (this.checkValue('{')) {
      const scopeStack: Array<{ range: { start: SourcePosition; end: SourcePosition } }> = [];
      const open = this.current();
      const rootScope = {
        range: {
          start: open.range.start,
          end: open.range.end,
        },
      };
      this.advance();
      scopeStack.push(rootScope);

      while (!this.isAtEnd() && scopeStack.length > 0) {
        if (this.checkValue('{')) {
          const nestedOpen = this.current();
          const nestedScope = {
            range: {
              start: nestedOpen.range.start,
              end: nestedOpen.range.end,
            },
          };
          scopeStack.push(nestedScope);
          this.advance();
          continue;
        }

        if (this.checkValue('}')) {
          const close = this.current();
          const scope = scopeStack.pop();
          if (scope) {
            scope.range.end = close.range.end;
          }
          end = close.range.end;
          this.advance();
          continue;
        }

        const parsedLocals = this.parseVariableStatements();
        if (parsedLocals.length > 0) {
          const scope = scopeStack[scopeStack.length - 1];
          for (const local of parsedLocals) {
            if (scope) {
              local.scope = scope.range;
            }
            locals.push(local);
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
      locals,
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

    const typeToken = this.parseTypeName();
    if (typeToken === undefined) {
      this.index = startIndex;
      return undefined;
    }

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

  /**
   * テンプレート/ジェネリックなリソース型を含むHLSL型名を解析する。対象には
   * RWTexture2D<float4> や StructuredBuffer<MyStruct> など。
   *
   * Unityのcompute shaderではこれらの宣言を多用する。Tokenizerは
   * `<` と `>` を演算子として扱うため、変数名を探す前に型全体を読み取る必要がある。
   * 変数名を探す前に型全体を読み取る必要がある。
   */
  private parseTypeName(): Token | undefined {
    const startIndex = this.index;
    const baseToken = this.current();
    if (baseToken.kind !== 'identifier') {
      return undefined;
    }

    this.advance();
    let typeName = baseToken.value;
    let end = baseToken.range.end;
    if (this.checkValue('<')) {
      let depth = 0;
      while (!this.isAtEnd()) {
        const token = this.current();
        if (token.value === '<') {
          depth++;
          typeName += token.value;
          end = token.range.end;
          this.advance();
          continue;
        }

        if (token.value === '>') {
          depth--;
          typeName += token.value;
          end = token.range.end;
          this.advance();
          if (depth === 0) {
            break;
          }

          continue;
        }

        // Tokenizerは `>>` を1つの演算子としてまとめる。ネストしたジェネリック型では
        // これが2つの閉じ山括弧を表す場合がある。
        if (token.value === '>>' && depth > 0) {
          typeName += '>>';
          end = token.range.end;
          this.advance();
          depth -= 2;
          if (depth <= 0) {
            break;
          }

          continue;
        }

        // ジェネリック型には識別子、数値、カンマ、ネストした
        // 型用の記号が含まれる。型の一部でなくなった時点で読み取りを終了する。
        if (
          token.kind === 'identifier' ||
          token.kind === 'number' ||
          token.value === ',' ||
          token.value === '.' ||
          token.value === ':' ||
          token.value === '[' ||
          token.value === ']' ||
          token.value === '*' ||
          token.value === '&'
        ) {
          typeName += token.value;
          end = token.range.end;
          this.advance();
          continue;
        }

        this.index = startIndex;
        return undefined;
      }

      if (depth !== 0) {
        this.index = startIndex;
        return undefined;
      }
    }

    return {
      ...baseToken,
      value: typeName,
      range: {
        start: baseToken.range.start,
        end,
      },
    };
  }

  private parseVariableStatements(): HlslVariableNode[] {
    const startIndex = this.index;
    const qualifiers: string[] = [];
    while (this.current().kind === 'identifier' && this.isDeclarationQualifier(this.current().value)) {
      qualifiers.push(this.current().value);
      this.advance();
    }

    const typeToken = this.parseTypeName();
    if (typeToken === undefined || this.isVariableDeclarationKeyword(typeToken.value)) {
      this.index = startIndex;
      return [];
    }

    const variables: HlslVariableNode[] = [];
    let first = true;
    while (!this.isAtEnd()) {
      const nameToken = this.current();
      if (nameToken.kind !== 'identifier') {
        this.index = startIndex;
        return [];
      }
      this.advance();
      if (first && this.checkValue('(')) {
        this.index = startIndex;
        return [];
      }

      let end = nameToken.range.end;
      while (this.checkValue('[')) {
        let depth = 0;
        while (!this.isAtEnd()) {
          const token = this.current();
          if (token.value === '[') depth++;
          if (token.value === ']') {
            depth--;
            end = token.range.end;
            this.advance();
            if (depth <= 0) break;
            continue;
          }
          this.advance();
        }
      }

      let semantic: string | undefined;
      if (this.checkValue(':')) {
        this.advance();
        if (this.current().kind === 'identifier') {
          semantic = this.current().value;
          end = this.current().range.end;
          this.advance();
        }
      }

      // 初期化子を含む宣言を、トップレベルのカンマ/セミコロンまで消費する。
      let parenDepth = 0;
      let bracketDepth = 0;
      let braceDepth = 0;
      while (!this.isAtEnd()) {
        const token = this.current();
        if (token.value === '(') parenDepth++;
        else if (token.value === ')') parenDepth--;
        else if (token.value === '[') bracketDepth++;
        else if (token.value === ']') bracketDepth--;
        else if (token.value === '{') braceDepth++;
        else if (token.value === '}') {
          if (braceDepth === 0) {
            this.index = startIndex;
            return [];
          }
          braceDepth--;
        }

        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && (token.value === ',' || token.value === ';')) {
          break;
        }
        end = token.range.end;
        this.advance();
      }

      variables.push({
        kind: 'HlslVariable',
        typeName: typeToken.value,
        name: nameToken.value,
        semantic,
        range: { start: typeToken.range.start, end },
      });

      if (this.checkValue(',')) {
        this.advance();
        first = false;
        continue;
      }
      if (this.checkValue(';')) {
        end = this.current().range.end;
        variables[variables.length - 1].range.end = end;
        this.advance();
        return variables;
      }
      this.index = startIndex;
      return [];
    }

    this.index = startIndex;
    return [];
  }

  private isDeclarationQualifier(value: string): boolean {
    return new Set([
      'const', 'static', 'uniform', 'volatile', 'precise', 'row_major', 'column_major',
      'nointerpolation', 'linear', 'centroid', 'noperspective', 'sample', 'in', 'out', 'inout',
      'groupshared', 'globallycoherent', 'shared', 'extern', 'inline', 'min16float', 'min16int',
      'min16uint',
    ]).has(value);
  }

  private isVariableDeclarationKeyword(value: string): boolean {
    return new Set([
      'if',
      'else',
      'for',
      'while',
      'do',
      'switch',
      'case',
      'default',
      'return',
      'break',
      'continue',
      'discard',
      'goto',
    ]).has(value);
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
    const safeOffset = Math.max(0, Math.min(offset, this.source.length));
    let low = 0;
    let high = this.lineStartOffsets.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.lineStartOffsets[middle] <= safeOffset) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const line = Math.max(0, high);
    return {
      offset,
      line,
      character: safeOffset - this.lineStartOffsets[line],
    };
  }
}
