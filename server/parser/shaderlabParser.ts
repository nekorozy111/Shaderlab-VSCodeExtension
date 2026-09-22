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

  private index = 0;

  public constructor(source: string) {
    this.source = source;

    this.tokens = new Tokenizer(source).tokenize();
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
     * Unity ShaderLab Property:
     *
     *   _Name ("Display Name", Type) = Default
     *
     *   [Attribute] _Name ("Display Name", Type) = Default
     *
     * Type can contain parentheses, for example:
     *
     *   Range(0, 1)
     *   Range(0, 8)
     *
     * Default value can also contain arbitrary characters:
     *
     *   (1,1,1,1)
     *   "white"
     *   0
     *   1
     *
     * Therefore, parsing the whole line with a single
     * greedy regex is fragile.
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
       * Match:
       *
       *   [Attribute] _Name ("Display Name", Type) = Default
       *
       * Attribute is optional.
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
       * Find the actual property start.
       *
       * We do not use the whole trimmed line because
       * the range should include an optional attribute.
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

        const localAst = new HlslParser(source).parse();

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

    const localAst = new HlslParser(source).parse();

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

  private shiftHlslDocument(
    document: ReturnType<HlslParser['parse']>,
    offset: number,
  ): ReturnType<HlslParser['parse']> {
    const shiftRange = (range: {
      start: SourcePosition;

      end: SourcePosition;
    }) => {
      return {
        start: this.positionFromOffset(range.start.offset + offset),

        end: this.positionFromOffset(range.end.offset + offset),
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
    let line = 0;
    let character = 0;

    const limit = Math.min(offset, this.source.length);

    for (let index = 0; index < limit; index++) {
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
