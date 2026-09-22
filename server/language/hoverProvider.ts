import { Hover, MarkupContent, Position } from 'vscode-languageserver/node';
import { DocumentManager } from './documentManager';
import { ShaderSymbol } from '../symbol/symbol';
import { DefinitionProvider } from './definitionProvider';
import { HlslStructNode, ShaderHlslBlockNode } from '../parser/ast';
import { SourceRange } from '../parser/token';

export class HoverProvider {
  constructor(
    private readonly documentManager: DocumentManager,
    private readonly definitionProvider: DefinitionProvider,
  ) {}

  public provideHover(uri: string, position: Position): Hover | null {
    const document = this.documentManager.get(uri);

    if (!document) {
      return null;
    }

    const offset = document.offsetAt(position);

    const text = document.getText();

    const word = this.getWordAtPosition(text, offset);

    if (!word) {
      return null;
    }

    console.log(`[HoverProvider] Request "${word}" in ${uri}`);

    /*
     * ---------------------------------------------------------
     * 1. Function-local variable
     *
     * Local variable は、同名の struct field / cbuffer field
     * より優先する。
     *
     * 例:
     *
     *     float4 color;
     *
     * というローカル変数が存在する場合、
     *
     *     LightData.color
     *
     * よりも
     *
     *     variable color
     *
     * を優先する。
     * ---------------------------------------------------------
     */

    let symbol = this.findLocalVariableSymbol(uri, word, offset);

    /*
     * ---------------------------------------------------------
     * 2. DefinitionProvider の通常の Symbol
     * ---------------------------------------------------------
     */

    if (!symbol) {
      symbol = this.definitionProvider.resolveSymbolAtPosition(uri, position);
    }

    /*
     * ---------------------------------------------------------
     * 3. Include scope 内の Symbol
     * ---------------------------------------------------------
     */

    if (!symbol) {
      symbol = this.findIncludedSymbol(uri, word);
    }

    /*
     * ---------------------------------------------------------
     * Symbol が見つかった場合
     *
     * Semantic より Symbol を優先する。
     * ---------------------------------------------------------
     */

    if (symbol) {
      console.log(`[HoverProvider] Symbol found: ` + `${symbol.name} (${symbol.kind})`);

      return {
        contents: this.createHoverContents(symbol),
      };
    }

    /*
     * ---------------------------------------------------------
     * 4. Semantic fallback
     *
     * Symbol が見つからなかった場合だけ、
     * POSITION / NORMAL / COLOR / TEXCOORD などを
     * Semantic として扱う。
     * ---------------------------------------------------------
     */

    const semanticDescription = this.getSemanticDescription(word);

    if (semanticDescription) {
      const field = this.findFieldBySemantic(uri, offset, word);

      if (field) {
        return {
          contents: {
            kind: 'markdown',
            value:
              `**${field.name}**\n\n` + `\`${field.typeName}\` ` + `\`${field.semantic}\`\n\n` + semanticDescription,
          },
        };
      }

      return {
        contents: {
          kind: 'markdown',
          value: `**${word}**\n\n` + semanticDescription,
        },
      };
    }

    /*
     * ---------------------------------------------------------
     * Symbol も Semantic も見つからない
     * ---------------------------------------------------------
     */

    console.log(`[HoverProvider] Symbol not found: "${word}"`);

    return null;
  }

  private findLocalVariableSymbol(uri: string, name: string, offset: number): ShaderSymbol | null {
    const document = this.documentManager.get(uri);

    if (!document) {
      return null;
    }

    const text = document.getText();
    const maskedText = this.maskComments(text);

    // ------------------------------------------------------------
    // ローカル変数の宣言を検索
    //
    // 例:
    //     float4 color = ...
    //           ^^^^^
    //
    // カーソルが color の途中にあっても検出する。
    // ------------------------------------------------------------

    const declarationPattern =
      /\b(?:(?:const|static|uniform|volatile|inline)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|=|\[|,)/g;

    let match: RegExpExecArray | null;
    let bestMatch: RegExpExecArray | null = null;

    while ((match = declarationPattern.exec(maskedText)) !== null) {
      const typeName = match[1];
      const variableName = match[2];

      if (variableName !== name) {
        continue;
      }

      const variableNameOffset = match.index + match[0].lastIndexOf(variableName);

      const variableEnd = variableNameOffset + variableName.length;

      // カーソルが変数名そのものにある
      if (offset >= variableNameOffset && offset <= variableEnd) {
        bestMatch = match;
        break;
      }

      // カーソルより前にある宣言を記録
      if (variableNameOffset < offset) {
        bestMatch = match;
      }
    }

    if (!bestMatch) {
      return null;
    }

    const typeName = bestMatch[1];
    const variableName = bestMatch[2];

    if (variableName !== name) {
      return null;
    }

    // ------------------------------------------------------------
    // ここでは「関数スコープ」の判定はまだ行わない。
    //
    // 今回の目的はまず
    //
    //     float4 color = ...
    //
    // の color 宣言を DefinitionProvider より優先して
    // local variable として取得すること。
    // ------------------------------------------------------------

    const variableNameOffset = bestMatch.index + bestMatch[0].lastIndexOf(variableName);

    const variableEnd = variableNameOffset + variableName.length;

    const startPosition = document.positionAt(variableNameOffset);

    const endPosition = document.positionAt(variableEnd);

    const range: SourceRange = {
      start: {
        line: startPosition.line,
        character: startPosition.character,
        offset: variableNameOffset,
      },
      end: {
        line: endPosition.line,
        character: endPosition.character,
        offset: variableEnd,
      },
    };

    // ------------------------------------------------------------
    // 型の解決
    //
    // include の探索は既存の findIncludedSymbol() に任せる。
    // ------------------------------------------------------------

    let typeSymbol: ShaderSymbol | null = null;

    const exactMatches = this.documentManager.getWorkspaceIndex().findExact(typeName);

    for (const match of exactMatches) {
      if (match.symbol.kind === 'struct' || match.symbol.kind === 'cbuffer') {
        typeSymbol = match.symbol;
        break;
      }
    }

    // ------------------------------------------------------------
    // include 側にある型も探す
    // ------------------------------------------------------------

    if (!typeSymbol) {
      const includedSymbol = this.findIncludedSymbol(uri, typeName);

      if (includedSymbol) {
        typeSymbol = includedSymbol;
      }
    }

    // ------------------------------------------------------------
    // ローカル変数 Symbol
    // ------------------------------------------------------------

    return {
      name: variableName,
      kind: 'variable',
      location: {
        uri,
        range,
        selectionRange: range,
      },
      typeName,
      parentName: typeSymbol?.name,
      children: [],
    };
  }

  private maskComments(text: string): string {
    return text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ' '));
  }

  private positionFromOffset(text: string, offset: number) {
    let line = 0;
    let character = 0;

    const limit = Math.min(Math.max(0, offset), text.length);

    for (let index = 0; index < limit; index++) {
      if (text[index] === '\n') {
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

  private createHoverContents(symbol: ShaderSymbol): MarkupContent {
    const lines: string[] = [];

    lines.push(`**${symbol.kind}**`);

    lines.push(`\`${symbol.name}\``);

    if (symbol.typeName) {
      lines.push(`Type: \`${symbol.typeName}\``);
    }

    if (symbol.returnType) {
      lines.push(`Return type: \`${symbol.returnType}\``);
    }

    if (symbol.semantic) {
      lines.push(`Semantic: \`${symbol.semantic}\``);
    }

    if (symbol.parentName) {
      lines.push(`Parent: \`${symbol.parentName}\``);
    }

    return {
      kind: 'markdown',
      value: lines.join('\n\n'),
    };
  }

  private getWordAtPosition(text: string, offset: number): string | null {
    if (offset < 0 || offset > text.length) {
      return null;
    }

    const isIdentifierCharacter = (char: string): boolean => {
      return /[A-Za-z0-9_]/.test(char);
    };

    let start = offset;

    while (start > 0 && isIdentifierCharacter(text[start - 1])) {
      start--;
    }

    let end = offset;

    while (end < text.length && isIdentifierCharacter(text[end])) {
      end++;
    }

    if (start === end) {
      return null;
    }

    return text.substring(start, end);
  }
  private getSemanticDescription(semantic: string): string | undefined {
    const descriptions: Record<string, string> = {
      POSITION: 'Vertex position input/output.',

      NORMAL: 'Vertex normal input/output.',

      TANGENT: 'Vertex tangent input/output.',

      COLOR: 'Vertex color input/output.',

      TEXCOORD0: 'Texture coordinate 0.',

      TEXCOORD1: 'Texture coordinate 1.',

      TEXCOORD2: 'Texture coordinate 2.',

      TEXCOORD3: 'Texture coordinate 3.',

      TEXCOORD4: 'Texture coordinate 4.',

      TEXCOORD5: 'Texture coordinate 5.',

      TEXCOORD6: 'Texture coordinate 6.',

      TEXCOORD7: 'Texture coordinate 7.',

      SV_POSITION: 'System-value semantic for vertex position.',

      SV_TARGET: 'System-value semantic for render-target output.',

      SV_TARGET0: 'System-value semantic for render-target 0.',

      SV_TARGET1: 'System-value semantic for render-target 1.',

      SV_TARGET2: 'System-value semantic for render-target 2.',

      SV_TARGET3: 'System-value semantic for render-target 3.',

      SV_TARGET4: 'System-value semantic for render-target 4.',

      SV_TARGET5: 'System-value semantic for render-target 5.',

      SV_TARGET6: 'System-value semantic for render-target 6.',

      SV_TARGET7: 'System-value semantic for render-target 7.',

      SV_DEPTH: 'System-value semantic for depth output.',

      SV_VERTEXID: 'System-value semantic containing the vertex ID.',

      SV_INSTANCEID: 'System-value semantic containing the instance ID.',

      SV_PRIMITIVEID: 'System-value semantic containing the primitive ID.',

      SV_ISFRONTFACE: 'System-value semantic indicating whether the primitive is front-facing.',

      SV_SAMPLEINDEX: 'System-value semantic containing the sample index.',
    };

    return descriptions[semantic.toUpperCase()];
  }

  private findFieldBySemantic(
    uri: string,
    offset: number,
    semantic: string,
  ):
    | {
        name: string;
        typeName: string;
        semantic: string;
      }
    | undefined {
    const parsed = this.documentManager.getParsed(uri);

    if (!parsed) {
      return undefined;
    }

    const ast = parsed.ast;

    if (ast.kind !== 'ShaderDocument') {
      return undefined;
    }

    const target = semantic.toUpperCase();

    const isInsideRange = (range: {
      start: {
        offset: number;
      };
      end: {
        offset: number;
      };
    }): boolean => {
      return offset >= range.start.offset && offset <= range.end.offset;
    };

    const searchStruct = (structNode: HlslStructNode) => {
      for (const field of structNode.fields) {
        if (!field.semantic) {
          continue;
        }

        if (field.semantic.toUpperCase() !== target) {
          continue;
        }

        if (!isInsideRange(field.range)) {
          continue;
        }

        return {
          name: field.name,
          typeName: field.typeName,
          semantic: field.semantic,
        };
      }

      return undefined;
    };

    const searchHlslBlock = (hlslBlock: ShaderHlslBlockNode) => {
      for (const declaration of hlslBlock.hlsl.declarations) {
        if (declaration.kind !== 'HlslStruct') {
          continue;
        }

        if (!isInsideRange(declaration.range)) {
          continue;
        }

        const field = searchStruct(declaration);

        if (field) {
          return field;
        }
      }

      return undefined;
    };

    // ShaderDocument直下のHLSL
    for (const hlslBlock of ast.hlslBlocks) {
      const field = searchHlslBlock(hlslBlock);

      if (field) {
        return field;
      }
    }

    // SubShader / Pass 内のHLSL
    for (const subShader of ast.subShaders) {
      for (const hlslBlock of subShader.hlslBlocks) {
        const field = searchHlslBlock(hlslBlock);

        if (field) {
          return field;
        }
      }

      for (const pass of subShader.passes) {
        for (const hlslBlock of pass.hlslBlocks) {
          const field = searchHlslBlock(hlslBlock);

          if (field) {
            return field;
          }
        }
      }
    }

    return undefined;
  }

  private findIncludedSymbol(uri: string, name: string): ShaderSymbol | null {
    const relatedUris = this.documentManager.getRelatedIncludeUris(uri);

    const matches = this.documentManager
      .getWorkspaceIndex()
      .findExact(name)
      .filter((match) => relatedUris.has(match.uri));

    if (matches.length === 0) {
      return null;
    }

    /*
     * Prefer the most specific symbol kinds
     * that normally represent HLSL declarations.
     */
    const preferred = matches.find(
      (match) =>
        match.symbol.kind === 'function' ||
        match.symbol.kind === 'struct' ||
        match.symbol.kind === 'cbuffer' ||
        match.symbol.kind === 'macro',
    );

    return preferred?.symbol ?? matches[0].symbol;
  }
}
