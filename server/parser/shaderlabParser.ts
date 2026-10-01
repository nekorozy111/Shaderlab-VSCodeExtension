import {
  ShaderDocumentNode,
  ShaderHlslBlockNode,
  ShaderPassNode,
  ShaderPropertyNode,
  ShaderSubShaderNode,
  ShaderTagEntryNode,
  ShaderTagsNode,
} from './ast';
import { SourcePosition, Token } from './token';
import { Tokenizer } from './tokenizer';
import { HlslParser } from './hlslParser';

export class ShaderLabParser {
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

  public parse(): ShaderDocumentNode {
    let shaderName: string | undefined;
    const properties: ShaderPropertyNode[] = [];
    const subShaders: ShaderSubShaderNode[] = [];
    const hlslBlocks: ShaderHlslBlockNode[] = [];
    if (this.checkIdentifier('Shader')) {
      this.advance();
      if (this.current().kind === 'string') {
        shaderName = this.current().value;
        this.advance();
      }
    }

    while (!this.isAtEnd()) {
      if (this.checkIdentifier('Properties')) {
        properties.push(...this.parseProperties());
        continue;
      }

      if (this.checkIdentifier('SubShader')) {
        const subShader = this.parseSubShader();
        if (subShader !== undefined) {
          subShaders.push(subShader);
        }

        continue;
      }

      if (this.isHlslStart()) {
        const block = this.parseHlslBlock();
        if (block !== undefined) {
          hlslBlocks.push(block);
        }

        continue;
      }

      this.advance();
    }

    return {
      kind: 'ShaderDocument',
      shaderName,
      properties,
      subShaders,
      hlslBlocks,
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

  private parseProperties(): ShaderPropertyNode[] {
    const result: ShaderPropertyNode[] = [];
    this.advance();
    if (!this.checkValue('{')) {
      return result;
    }

    const openingBrace = this.current();
    const closingIndex = this.findMatchingBrace(this.index);
    if (closingIndex < 0) {
      this.advance();
      return result;
    }

    const closingBrace = this.tokens[closingIndex];
    const contentStart = openingBrace.range.end.offset;
    const contentEnd = closingBrace.range.start.offset;
    const content = this.source.slice(contentStart, contentEnd);
    result.push(...this.parsePropertyText(content, contentStart));
    this.index = closingIndex + 1;
    return result;
  }

  private parsePropertyText(text: string, baseOffset: number): ShaderPropertyNode[] {
    const result: ShaderPropertyNode[] = [];
    /*
     * Unity ShaderLabのProperty:
     *
     *   _Name ("Display Name", Type) = Default
     *
     *   [Attribute] _Name ("Display Name", Type) = Default
     *
     * Typeには括弧を含めることができる。例:
     *
     *   Range(0, 1)
     *   Range(0, 8)
     *
     * Default値には任意の文字を含めることができる。
     *
     *   (1,1,1,1)
     *   "white"
     *   0
     *   1
     *
     * そのため、行全体を1つの
     * 貪欲な正規表現だけで解析する方法は不安定になる。
     */
    const lines = text.split(/\r?\n/);
    let offset = 0;
    for (const line of lines) {
      const lineStartOffset = baseOffset + offset;
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        offset += line.length + 1;
        continue;
      }

      /*
       * 一致対象:
       *
       *   [Attribute] _Name ("Display Name", Type) = Default
       *
       * Attributeは省略可能。
       */
      const match = line.match(
        /^\s*(?:\[([^\]]+)\]\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*(.+?)\s*\)\s*=\s*(.+?)\s*$/,
      );
      if (!match) {
        offset += line.length + 1;
        continue;
      }

      const attributesText = match[1];
      const name = match[2];
      const displayName = match[3];
      const propertyType = match[4].trim();
      const defaultValue = match[5].trim();
      const attributes =
        attributesText !== undefined
          ? attributesText
              .split(',')
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          : [];
      /*
       * 実際のProperty開始位置を探す。
       *
       * trim後の行全体は使用しない。これは
       * rangeに省略可能なAttributeも含める必要があるため。
       */
      const leadingWhitespaceLength = line.length - line.trimStart().length;
      const startOffset = lineStartOffset + leadingWhitespaceLength;
      const endOffset = lineStartOffset + line.length;
      result.push({
        kind: 'ShaderProperty',
        name,
        displayName,
        propertyType,
        defaultValue,
        attributes,
        range: {
          start: this.positionFromOffset(startOffset),
          end: this.positionFromOffset(endOffset),
        },
      });
      offset += line.length + 1;
    }

    return result;
  }

  private parseSubShader(): ShaderSubShaderNode | undefined {
    const startToken = this.current();
    this.advance();
    if (!this.checkValue('{')) {
      return undefined;
    }

    this.advance();
    let tags: ShaderTagsNode | undefined;
    const passes: ShaderPassNode[] = [];
    const hlslBlocks: ShaderHlslBlockNode[] = [];
    let end = startToken.range.end;
    while (!this.isAtEnd()) {
      if (this.checkValue('}')) {
        end = this.current().range.end;
        this.advance();
        break;
      }

      if (this.checkIdentifier('Tags')) {
        tags = this.parseTags();
        continue;
      }

      if (this.checkIdentifier('Pass')) {
        const pass = this.parsePass();
        if (pass !== undefined) {
          passes.push(pass);
        }

        continue;
      }

      if (this.isHlslStart()) {
        const block = this.parseHlslBlock();
        if (block !== undefined) {
          hlslBlocks.push(block);
        }

        continue;
      }

      this.advance();
    }

    return {
      kind: 'ShaderSubShader',
      tags,
      passes,
      hlslBlocks,
      range: {
        start: startToken.range.start,
        end,
      },
    };
  }

  private parsePass(): ShaderPassNode | undefined {
    const startToken = this.current();
    this.advance();
    if (!this.checkValue('{')) {
      return undefined;
    }

    this.advance();
    let name: string | undefined;
    let tags: ShaderTagsNode | undefined;
    const hlslBlocks: ShaderHlslBlockNode[] = [];
    let end = startToken.range.end;
    while (!this.isAtEnd()) {
      if (this.checkValue('}')) {
        end = this.current().range.end;
        this.advance();
        break;
      }

      if (this.checkIdentifier('Name')) {
        this.advance();
        if (this.current().kind === 'string') {
          name = this.current().value;
          this.advance();
        }

        continue;
      }

      if (this.checkIdentifier('Tags')) {
        tags = this.parseTags();
        continue;
      }

      if (this.isHlslStart()) {
        const block = this.parseHlslBlock();
        if (block !== undefined) {
          hlslBlocks.push(block);
        }

        continue;
      }

      this.advance();
    }

    return {
      kind: 'ShaderPass',
      name,
      tags,
      hlslBlocks,
      range: {
        start: startToken.range.start,
        end,
      },
    };
  }

  private parseTags(): ShaderTagsNode | undefined {
    const startToken = this.current();
    this.advance();
    if (!this.checkValue('{')) {
      return undefined;
    }

    this.advance();
    const entries: ShaderTagEntryNode[] = [];
    let end = startToken.range.end;
    while (!this.isAtEnd()) {
      if (this.checkValue('}')) {
        end = this.current().range.end;
        this.advance();
        break;
      }

      const keyToken = this.current();
      if (keyToken.kind !== 'string') {
        this.advance();
        continue;
      }

      this.advance();
      if (this.checkValue('=')) {
        this.advance();
      }

      const valueToken = this.current();
      if (valueToken.kind !== 'string') {
        // 不正なタグ値でもカーソルを必ず進め、入力途中のShaderで無限ループしないようにする。
        if (valueToken.kind === 'eof' || this.checkValue('}')) {
          continue;
        }
        this.advance();
        continue;
      }

      this.advance();
      entries.push({
        kind: 'ShaderTagEntry',
        key: keyToken.value,
        value: valueToken.value,
        range: {
          start: keyToken.range.start,
          end: valueToken.range.end,
        },
      });
    }

    return {
      kind: 'ShaderTags',
      entries,
      range: {
        start: startToken.range.start,
        end,
      },
    };
  }

  private parseHlslBlock(): ShaderHlslBlockNode | undefined {
    const startToken = this.current();
    const blockType = startToken.value;
    if (blockType !== 'HLSLPROGRAM' && blockType !== 'HLSLINCLUDE' && blockType !== 'CGPROGRAM') {
      return undefined;
    }

    const contentStart = startToken.range.end.offset;
    this.advance();
    const blockEndToken = blockType === 'CGPROGRAM' ? 'ENDCG' : 'ENDHLSL';
    while (!this.isAtEnd()) {
      if (this.checkIdentifier(blockEndToken)) {
        const endToken = this.current();
        const contentEnd = endToken.range.start.offset;
        const source = this.source.slice(contentStart, contentEnd);
        const localAst = new HlslParser(source, this.createLocalHlslTokens(contentStart, contentEnd)).parse();
        const hlsl = this.shiftHlslDocument(localAst, contentStart);
        this.advance();
        return {
          kind: 'ShaderHlslBlock',
          blockType,
          source,
          hlsl,
          range: {
            start: startToken.range.start,
            end: endToken.range.end,
          },
        };
      }

      this.advance();
    }

    const source = this.source.slice(contentStart);
    const localAst = new HlslParser(source, this.createLocalHlslTokens(contentStart, this.source.length)).parse();
    const hlsl = this.shiftHlslDocument(localAst, contentStart);
    return {
      kind: 'ShaderHlslBlock',
      blockType,
      source,
      hlsl,
      range: {
        start: startToken.range.start,
        end: this.positionFromOffset(this.source.length),
      },
    };
  }

  private createLocalHlslTokens(contentStart: number, contentEnd: number): Token[] {
    const basePosition = this.positionFromOffset(contentStart);
    const localTokens: Token[] = [];
    for (const token of this.tokens) {
      if (token.kind === 'eof') continue;
      if (token.range.start.offset < contentStart || token.range.end.offset > contentEnd) continue;
      const toLocal = (position: SourcePosition): SourcePosition => ({
        offset: position.offset - contentStart,
        line: position.line - basePosition.line,
        character: position.line === basePosition.line
          ? position.character - basePosition.character
          : position.character,
      });
      localTokens.push({
        kind: token.kind,
        value: token.value,
        range: { start: toLocal(token.range.start), end: toLocal(token.range.end) },
      });
    }
    const end = this.positionFromOffset(contentEnd);
    const localEnd: SourcePosition = {
      offset: contentEnd - contentStart,
      line: end.line - basePosition.line,
      character: end.line === basePosition.line ? end.character - basePosition.character : end.character,
    };
    localTokens.push({ kind: 'eof', value: '', range: { start: localEnd, end: localEnd } });
    return localTokens;
  }

  private shiftHlslDocument(
    document: ReturnType<HlslParser['parse']>,
    offset: number,
  ): ReturnType<HlslParser['parse']> {
    /*
     * HLSL側のPositionは、ブロック単体のソースを基準にしている。
     * 以前は各rangeについてShaderLab全体を先頭から走査して
     * positionFromOffset()を呼んでいたため、宣言数が増えるほど
     * O(宣言数 × ソースサイズ)に近いコストが発生していた。
     *
     * HLSLブロック開始位置を1回だけ求め、line/characterを直接加算する。
     */
    const basePosition = this.positionFromOffset(offset);
    const shiftPosition = (position: SourcePosition): SourcePosition => {
      return {
        offset: position.offset + offset,
        line: basePosition.line + position.line,
        character: position.line === 0 ? basePosition.character + position.character : position.character,
      };
    };
    const shiftRange = (range: { start: SourcePosition; end: SourcePosition }) => {
      return {
        start: shiftPosition(range.start),
        end: shiftPosition(range.end),
      };
    };
    for (const declaration of document.declarations) {
      declaration.range = shiftRange(declaration.range);
      if (declaration.kind === 'HlslStruct') {
        for (const field of declaration.fields) {
          field.range = shiftRange(field.range);
        }
      }

      if (declaration.kind === 'HlslFunction') {
        for (const parameter of declaration.parameters) {
          parameter.range = shiftRange(parameter.range);
        }
        for (const local of declaration.locals) {
          local.range = shiftRange(local.range);
          if (local.scope) {
            local.scope = shiftRange(local.scope);
          }
        }
      }

      if (declaration.kind === 'HlslCBuffer') {
        for (const field of declaration.fields) {
          field.range = shiftRange(field.range);
        }
      }
    }

    document.range = shiftRange(document.range);
    return document;
  }

  private findMatchingBrace(openingBraceIndex: number): number {
    let depth = 0;
    for (let index = openingBraceIndex; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (token.value === '{') {
        depth++;
      }

      if (token.value === '}') {
        depth--;
        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  private isHlslStart(): boolean {
    return (
      this.checkIdentifier('HLSLPROGRAM') || this.checkIdentifier('HLSLINCLUDE') || this.checkIdentifier('CGPROGRAM')
    );
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
