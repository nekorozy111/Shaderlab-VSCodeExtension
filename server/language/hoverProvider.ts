import { Hover, MarkupContent, Position } from 'vscode-languageserver/node';
import { DocumentManager } from './documentManager';
import { ShaderSymbol } from '../symbol/symbol';
import { DefinitionProvider } from './definitionProvider';
import { HlslStructNode, ShaderHlslBlockNode } from '../parser/ast';
import { SourceRange } from '../parser/token';

import { getSourceLexicalContextAtOffset } from '../parser/lexicalUtils';

export class HoverProvider {
  public constructor(
    private readonly documentManager: DocumentManager,
    private readonly definitionProvider: DefinitionProvider,
  ) {}

  public invalidateDocument(_uri: string): void {}

  public clear(): void {}
  public provideHover(uri: string, position: Position): Hover | null {
    const document = this.documentManager.get(uri);
    if (!document) {
      return null;
    }

    // 編集直後はdebounce済みの直前ASTを利用し、requestごとの同期Parseを避ける。
    const offset = document.offsetAt(position);
    const text = document.getText();
    /*
     * ---------------------------------------------------------
     * #include のパス内では Hover を表示しない
     *
     * 例:
     *
     * #include "TestInput.hlsl"
     *           ^^^^^^^^^^^^^
     *
     * この範囲では通常の HLSL Symbol 検索を行わない。
     * ---------------------------------------------------------
     */
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const lineEndIndex = text.indexOf('\n', offset);
    const lineEnd = lineEndIndex >= 0 ? lineEndIndex : text.length;
    const line = text.substring(lineStart, lineEnd);
    const cursorInLine = offset - lineStart;
    const textBeforeCursor = line.substring(0, cursorInLine);
    const includeMatch = /^\s*#\s*include\s*(?:"[^"]*|<[^>]*)$/.test(textBeforeCursor);
    if (includeMatch) {
      return null;
    }

    const word = this.getWordAtPosition(text, offset);
    if (!word) {
      return null;
    }

    // ShaderLab Propertyの表示名・型・既定値などはSymbolではない。
    // ここで通常のHLSL Symbol検索へ進ませないことで、同名Struct等への誤Hoverを防ぐ。
    if (this.definitionProvider.isShaderPropertySyntaxAtPosition(uri, position)) {
      return null;
    }

    // メンバーアクセスでは、解決できた型のメンバーだけをHover対象にする。
    // 解決失敗時に名前だけでWorkspace検索すると、別Structの同名fieldを誤表示するため、
    // member accessのときは通常のinclude/global fallbackへ進ませない。
    const memberAccess = this.getMemberAccessAtPosition(text, offset);
    if (memberAccess && !this.isHlslSwizzle(memberAccess.memberName)) {
      const resolved = this.definitionProvider.resolveSymbolAtPosition(uri, position);
      if (!resolved) {
        return null;
      }
      return { contents: this.createHoverContents(resolved, uri) };
    }

    /*
     * ---------------------------------------------------------
     * コメント内では Hover を表示しない
     * ---------------------------------------------------------
     */
    if (this.isInsideComment(uri, offset)) {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * Semantic上ではfield Symbolを解決しない。
     * field.rangeは `float3 position : POSITION` 全体を含むため、
     * semanticRangeを持たずに通常のSymbol検索を先に行うと
     * POSITIONのHoverがposition fieldとして表示されてしまう。
     * ---------------------------------------------------------
     */
    const semanticAtPosition = this.findSemanticAtPosition(uri, offset);
    if (semanticAtPosition) {
      const semanticDescription = this.getSemanticDescription(semanticAtPosition);
      return {
        contents: {
          kind: 'markdown',
          value: `**${semanticAtPosition}**\n\n` + (semanticDescription ?? 'HLSL semantic.'),
        },
      };
    }

    /*
     * ---------------------------------------------------------
     * 1. 関数ローカル変数
     *
     * ローカル変数は、同名のstruct field / cbuffer field
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
    let symbol = this.findFieldDeclarationAtPosition(uri, offset, word);
    if (!symbol) {
      symbol = this.findLocalVariableSymbol(uri, word, offset);
    }

    /*
     * ---------------------------------------------------------
     * 2. DefinitionProviderの通常のSymbol
     * ---------------------------------------------------------
     */
    if (!symbol) {
      symbol = this.definitionProvider.resolveSymbolAtPosition(uri, position);
    }

    /*
     * ---------------------------------------------------------
     * 3. includeスコープ内のSymbol
     * ---------------------------------------------------------
     */
    if (!symbol) {
      symbol = this.findIncludedSymbol(uri, word);
    }

    /*
     * ---------------------------------------------------------
     * Symbolが見つかった場合
     *
     * Semantic より Symbol を優先する。
     * ---------------------------------------------------------
     */
    if (symbol) {
      return {
        contents: this.createHoverContents(symbol, uri),
      };
    }

    /*
     * ---------------------------------------------------------
     * 4. Semanticへのフォールバック
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
    return null;
  }

  private findLocalVariableSymbol(uri: string, name: string, offset: number): ShaderSymbol | null {
    const local = this.documentManager.findLocalVariable(uri, name, offset);
    if (!local) return null;
    return {
      name: local.name,
      kind: 'variable',
      location: {
        uri,
        range: local.range,
        selectionRange: local.range,
      },
      typeName: local.typeName,
      children: [],
    };
  }

  private createHoverContents(symbol: ShaderSymbol, uri: string): MarkupContent {
    const lines: string[] = [];
    lines.push(`**${symbol.kind}**`);

    if (symbol.kind === 'function') {
      const overloads = this.getFunctionOverloads(uri, symbol);
      for (const overload of overloads.slice(0, 3)) {
        lines.push(`\`${this.formatFunctionSignature(overload)}\``);
      }

      const remaining = overloads.length - 3;
      if (remaining > 0) {
        lines.push(`... and ${remaining} more overrides`);
      }
    } else {
      lines.push(`\`${symbol.name}\``);
    }

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

  private getFunctionOverloads(uri: string, symbol: ShaderSymbol): ShaderSymbol[] {
    const matches = this.documentManager
      .findExactInRelated(uri, symbol.name)
      .filter((match) => match.symbol.kind === 'function')
      .map((match) => match.symbol);

    const ordered: ShaderSymbol[] = [symbol];
    const seen = new Set<string>([this.getFunctionSignatureKey(symbol)]);

    for (const candidate of matches) {
      const key = this.getFunctionSignatureKey(candidate);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      ordered.push(candidate);
    }

    return ordered;
  }

  private getFunctionSignatureKey(symbol: ShaderSymbol): string {
    return `${symbol.name}(${symbol.children
      .filter((child) => child.kind === 'parameter')
      .map((child) => `${child.typeName ?? ''}:${child.name}`)
      .join(',')})`;
  }

  private formatFunctionSignature(symbol: ShaderSymbol): string {
    const parameters = symbol.children
      .filter((child) => child.kind === 'parameter')
      .map((parameter) => `${parameter.typeName ?? 'unknown'}: ${parameter.name}`)
      .join(', ');

    return `${symbol.name}(${parameters})`;
  }

  private getMemberAccessAtPosition(text: string, offset: number): { objectName: string; memberName: string } | null {
    const isIdentifierCharacter = (char: string): boolean => /[A-Za-z0-9_]/.test(char);
    let memberStart = offset;
    while (memberStart > 0 && isIdentifierCharacter(text[memberStart - 1])) {
      memberStart--;
    }
    let memberEnd = offset;
    while (memberEnd < text.length && isIdentifierCharacter(text[memberEnd])) {
      memberEnd++;
    }
    if (memberStart === memberEnd) return null;

    let dotOffset = memberStart;
    while (dotOffset > 0 && /\s/.test(text[dotOffset - 1])) dotOffset--;
    if (dotOffset <= 0 || text[dotOffset - 1] !== '.') return null;
    dotOffset--;

    let objectEnd = dotOffset;
    while (objectEnd > 0 && /\s/.test(text[objectEnd - 1])) objectEnd--;
    let objectStart = objectEnd;
    while (objectStart > 0 && isIdentifierCharacter(text[objectStart - 1])) objectStart--;
    if (objectStart === objectEnd) return null;

    return {
      objectName: text.substring(objectStart, objectEnd),
      memberName: text.substring(memberStart, memberEnd),
    };
  }

  private isHlslSwizzle(name: string): boolean {
    if (name.length < 1 || name.length > 4) return false;
    return [...name.toLowerCase()].every((character) => 'xyzwrgba'.includes(character));
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

  private findSemanticAtPosition(uri: string, offset: number): string | undefined {
    const parsed = this.documentManager.getParsed(uri);
    if (!parsed) {
      return undefined;
    }

    const findInHlsl = (hlsl: HlslStructNode | ShaderHlslBlockNode['hlsl']): string | undefined => {
      for (const declaration of hlsl.kind === 'HlslStruct' ? [hlsl] : hlsl.declarations) {
        if (declaration.kind === 'HlslStruct') {
          for (const field of declaration.fields) {
            if (
              field.semantic &&
              field.semanticRange &&
              offset >= field.semanticRange.start.offset &&
              offset <= field.semanticRange.end.offset
            ) {
              return field.semantic;
            }
          }
        } else if (declaration.kind === 'HlslFunction') {
          for (const parameter of declaration.parameters) {
            if (
              parameter.semantic &&
              parameter.semanticRange &&
              offset >= parameter.semanticRange.start.offset &&
              offset <= parameter.semanticRange.end.offset
            ) {
              return parameter.semantic;
            }
          }
        } else if (declaration.kind === 'HlslVariable' && declaration.semanticRange) {
          if (offset >= declaration.semanticRange.start.offset && offset <= declaration.semanticRange.end.offset) {
            return declaration.semantic;
          }
        }
      }
      return undefined;
    };

    if (parsed.ast.kind === 'HlslDocument') {
      return findInHlsl(parsed.ast);
    }

    const ast = parsed.ast;
    for (const block of ast.hlslBlocks) {
      const semantic = findInHlsl(block.hlsl);
      if (semantic) return semantic;
    }
    for (const subShader of ast.subShaders) {
      for (const block of subShader.hlslBlocks) {
        const semantic = findInHlsl(block.hlsl);
        if (semantic) return semantic;
      }
      for (const pass of subShader.passes) {
        for (const block of pass.hlslBlocks) {
          const semantic = findInHlsl(block.hlsl);
          if (semantic) return semantic;
        }
      }
    }
    return undefined;
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
    const matches = this.documentManager.findExactInRelated(uri, name);
    if (matches.length === 0) {
      return null;
    }

    /*
     * 最も具体的なSymbol種別を優先する。
     * 通常はHLSL宣言を表すもの。
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

  private findFieldDeclarationAtPosition(uri: string, offset: number, name: string): ShaderSymbol | null {
    // 宣言位置のfieldはWorkspace indexの名前検索ではなく、現在ファイルのASTを
    // 直接見る。別HLSL blockに同名fieldがある場合でも、現在位置のfieldを一意に
    // 解決できるようにする。
    const parsed = this.documentManager.getParsed(uri);
    if (parsed) {
      const findInHlsl = (hlsl: ShaderHlslBlockNode['hlsl']): ShaderSymbol | null => {
        for (const declaration of hlsl.declarations) {
          if (declaration.kind !== 'HlslStruct') {
            continue;
          }
          for (const field of declaration.fields) {
            if (field.name !== name) {
              continue;
            }
            if (offset < field.range.start.offset || offset > field.range.end.offset) {
              continue;
            }
            return {
              name: field.name,
              kind: 'field',
              location: {
                uri,
                range: field.range,
                selectionRange: field.range,
              },
              typeName: field.typeName,
              semantic: field.semantic,
              parentName: declaration.name,
              children: [],
            };
          }
        }
        return null;
      };

      if (parsed.ast.kind === 'HlslDocument') {
        // HLSL単体ではstruct宣言を直接走査する。
        for (const declaration of parsed.ast.declarations) {
          if (declaration.kind !== 'HlslStruct') continue;
          for (const field of declaration.fields) {
            if (field.name === name && offset >= field.range.start.offset && offset <= field.range.end.offset) {
              return {
                name: field.name,
                kind: 'field',
                location: { uri, range: field.range, selectionRange: field.range },
                typeName: field.typeName,
                semantic: field.semantic,
                parentName: declaration.name,
                children: [],
              };
            }
          }
        }
      } else {
        for (const block of parsed.ast.hlslBlocks) {
          const found = findInHlsl(block.hlsl);
          if (found) return found;
        }
        for (const subShader of parsed.ast.subShaders) {
          for (const block of subShader.hlslBlocks) {
            const found = findInHlsl(block.hlsl);
            if (found) return found;
          }
          for (const pass of subShader.passes) {
            for (const block of pass.hlslBlocks) {
              const found = findInHlsl(block.hlsl);
              if (found) return found;
            }
          }
        }
      }
    }

    const matches = this.documentManager.getWorkspaceIndex().findExact(name);
    for (const match of matches) {
      const symbol = match.symbol;
      if (symbol.location.uri !== uri) {
        continue;
      }

      if (symbol.kind !== 'field') {
        continue;
      }

      const range = symbol.location.range;
      if (offset >= range.start.offset && offset <= range.end.offset) {
        return symbol;
      }
    }

    return null;
  }

  private isInsideComment(uri: string, offset: number): boolean {
    const document = this.documentManager.get(uri);
    return document ? getSourceLexicalContextAtOffset(document.getText(), offset).inComment : false;
  }
}
