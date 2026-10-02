import { Location, Position } from 'vscode-languageserver/node';
import { DocumentManager } from './documentManager';
import { ShaderSymbol } from '../symbol/symbol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HlslDocumentNode, ShaderDocumentNode, HlslFunctionNode, HlslVariableNode } from '../parser/ast';
import { isShaderLabDocument } from './languageId';
import { getSourceLexicalContextAtOffset } from '../parser/lexicalUtils';

export class DefinitionProvider {
  public constructor(private readonly documentManager: DocumentManager) {}
  public provideDefinition(uri: string, position: Position): Location | null {
    const document = this.documentManager.get(uri);
    if (!document) {
      return null;
    }

    // 編集直後はdebounce済みの直前ASTを利用し、requestごとの同期Parseを避ける。
    const text = document.getText();
    const offset = document.offsetAt(position);
    /*
     * ---------------------------------------------------------
     * #include のパス内では 定義 を提供しない
     *
     * 例:
     *
     * #include "TestInput.hlsl"
     *           ^^^^^^^^^^^^^
     *
     * この範囲では通常の HLSL シンボル 検索を行わない。
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

    /*
     * ---------------------------------------------------------
     * コメント内では 定義 を提供しない
     * ---------------------------------------------------------
     */
    if (this.isInsideComment(uri, offset)) {
      return null;
    }

    if (!word) {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 0. 宣言自身
     * ---------------------------------------------------------
     */
    const declarationMatches = this.documentManager
      .getWorkspaceIndex()
      .findExact(word)
      .filter((match) => match.symbol.location.uri === uri);
    for (const match of declarationMatches) {
      const range = match.symbol.location.range;
      const inside = offset >= range.start.offset && offset <= range.end.offset;
      if (!inside) {
        continue;
      }

      return this.toLocation(match.symbol);
    }

    /*
     * ---------------------------------------------------------
     * 1. 組み込み型 / セマンティクス
     * ---------------------------------------------------------
     */
    if (this.isBuiltinHlslType(word) || this.isHlslSemantic(word)) {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 2. メンバーアクセス / スウィズル
     *
     * color.rgb
     * data.position
     * a.position
     * ---------------------------------------------------------
     */
    const memberAccess = this.getMemberAccessAtPosition(text, offset);
    if (memberAccess) {
      /*
       * Swizzleなら定義検索しない。
       */
      if (this.isHlslSwizzle(memberAccess.memberName)) {
        return null;
      }

      /*
       * -----------------------------------------------------
       * まず現在のファイルのローカル変数を
       * ソースから探す。
       * -----------------------------------------------------
       */
      const localObject = this.findVariableDeclarationInSource(document, memberAccess.objectName, offset);
      if (localObject) {
        const member = this.findStructField(localObject.typeName, memberAccess.memberName, uri);
        if (member) {
          return this.toLocation(member);
        }
      }

      /*
       * -----------------------------------------------------
       * ワークスペースIndex に登録されている 変数 / パラメータ
       * も調べる。
       * -----------------------------------------------------
       */
      const objectMatches = this.documentManager
        .findExactInRelated(uri, memberAccess.objectName)
        .filter((match) => match.symbol.kind === 'variable' || match.symbol.kind === 'parameter');
      if (objectMatches.length > 0) {
        const objectSymbol = this.selectBestObjectSymbol(
          uri,
          offset,
          objectMatches.map((match) => match.symbol),
        );
        if (objectSymbol) {
          if (objectSymbol.typeName) {
            const member = this.findStructField(objectSymbol.typeName, memberAccess.memberName, uri);
            if (member) {
              return this.toLocation(member);
            }
          }
        }
      }

      /*
       * -----------------------------------------------------
       * includeを読み込んでからもう一度検索。
       * -----------------------------------------------------
       */
      /*
       * include先のstruct / フィールドを検索
       *
       * findStructField() / findExactInRelated() 側で includeグラフ を
       * 必要時に構築するため、ここで別途ロードしない。
       */
      if (localObject) {
        const member = this.findStructField(localObject.typeName, memberAccess.memberName, uri);
        if (member) {
          return this.toLocation(member);
        }
      }

      /*
       * メンバーとして解決できなかった場合、
       * 通常の名前検索には落とさない。
       *
       * 例えば
       *
       * data.unknown
       *
       * の unknown を別ファイルの同名関数へ
       * 飛ばしてしまうのを防ぐ。
       */
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 3.5 ShaderLab Property
     *
     * 現在のShaderに同名Propertyが存在する場合、
     * Global ワークスペースIndexより優先する。
     * ---------------------------------------------------------
     */
    const currentProperty = this.findPropertyByName(document, word);
    if (currentProperty) {
      const cbufferField = this.findCBufferFieldForProperty(uri, currentProperty);
      if (cbufferField) {
        return this.toLocation(cbufferField);
      }

      /*
       * 現在のShaderから到達可能なCBufferがない場合、
       * Property自身へ移動する。
       */
      return this.toLocation(currentProperty);
    }

    /*
     * ---------------------------------------------------------
     * 3. 通常のローカル変数
     *
     * float4 color = ...;
     *
     * color;
     * ---------------------------------------------------------
     */
    const localVariable = this.findVariableDeclarationInSource(document, word, offset);
    if (localVariable) {
      return {
        uri: localVariable.uri,
        range: localVariable.range,
      };
    }

    /*
     * ---------------------------------------------------------
     * 4. 現在のファイル
     * ---------------------------------------------------------
     */
    const localMatches = this.documentManager
      .getWorkspaceIndex()
      .findExact(word)
      .filter((match) => match.uri === uri && match.symbol.kind !== 'parameter');
    if (localMatches.length > 0) {
      const localSymbols = localMatches.map((match) => match.symbol);
      const selected = this.selectBestDefinition(uri, localSymbols);
      if (selected) {
        /*
         * -----------------------------------------------------
         * Property
         *
         * Propertyを現在ファイル内で発見できた場合、
         * ワークスペース全体の検索には絶対に進ませない。
         * -----------------------------------------------------
         */
        if (selected.kind === 'property') {
          const cbufferField = this.findCBufferFieldForProperty(uri, selected);
          if (cbufferField) {
            return this.toLocation(cbufferField);
          }

          /*
           * 同じファイルにCBUFFERがない場合も、
           * 他ファイルには絶対にフォールバックしない。
           */
          return this.toLocation(selected);
        }

        return this.toLocation(selected);
      }
    }

    /*
     * ---------------------------------------------------------
     * 5. includeを再帰的にロード
     * ---------------------------------------------------------
     */
    // findExactInRelated() が必要時にincludeグラフを構築する。
    /*
     * ---------------------------------------------------------
     * 6. ワークスペース全体
     * ---------------------------------------------------------
     */
    const matches = this.documentManager
      .findExactInRelated(uri, word)
      .filter((match) => match.symbol.kind !== 'parameter');
    for (const match of matches) {
    }

    if (matches.length === 0) {
      return null;
    }

    const symbols = matches.map((match) => match.symbol);
    const selected = this.selectBestDefinition(uri, symbols);
    if (!selected) {
      return null;
    }

    return this.toLocation(selected);
  }

  public resolveSymbolAtPosition(uri: string, position: Position): ShaderSymbol | null {
    const document = this.documentManager.get(uri);
    if (!document) {
      return null;
    }

    // Hoverから呼ばれる場合も、debounce済みのASTを共有する。
    const text = document.getText();
    const offset = document.offsetAt(position);
    const word = this.getWordAtPosition(text, offset);
    if (!word) {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 1. メンバーアクセス
     *
     * a.position
     * b.position
     * input.position
     * ---------------------------------------------------------
     */
    const memberAccess = this.getMemberAccessAtPosition(text, offset);
    if (memberAccess) {
      /*
       * HLSL スウィズル は symbol ではない。
       */
      if (this.isHlslSwizzle(memberAccess.memberName)) {
        return null;
      }

      /*
       * -----------------------------------------------------
       * 1-1. 現在のソースから object を探す
       * -----------------------------------------------------
       */
      const localObject = this.findVariableDeclarationInSource(document, memberAccess.objectName, offset);
      if (localObject) {
        const member = this.findStructField(localObject.typeName, memberAccess.memberName, uri);
        if (member) {
          return member;
        }
      }

      /*
       * -----------------------------------------------------
       * 1-2. ワークスペースIndex の 変数 / パラメータ
       * -----------------------------------------------------
       */
      const objectMatches = this.documentManager
        .findExactInRelated(uri, memberAccess.objectName)
        .filter((match) => match.symbol.kind === 'variable' || match.symbol.kind === 'parameter');
      if (objectMatches.length > 0) {
        const objectSymbol = this.selectBestObjectSymbol(
          uri,
          offset,
          objectMatches.map((match) => match.symbol),
        );
        if (objectSymbol && objectSymbol.typeName) {
          const member = this.findStructField(objectSymbol.typeName, memberAccess.memberName, uri);
          if (member) {
            return member;
          }
        }
      }

      /*
       * メンバーアクセス を通常の名前検索には
       * 落とさない。
       *
       * 例:
       *
       * data.unknown
       *
       * の unknown を別の同名 symbol に
       * 誤って解決しないため。
       */
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 2. 通常の symbol
     *
     * 変数
     * パラメータ
     * struct
     * フィールド
     * 関数
     * プロパティ
     * など。
     * ---------------------------------------------------------
     */
    const localVariable = this.findVariableDeclarationInSource(document, word, offset);
    if (localVariable) {
      const start = localVariable.range.start;
      const end = localVariable.range.end;
      return {
        name: localVariable.name,
        kind: 'variable',
        location: {
          uri: localVariable.uri,
          range: {
            start: {
              line: start.line,
              character: start.character,
              offset: document.offsetAt(start),
            },
            end: {
              line: end.line,
              character: end.character,
              offset: document.offsetAt(end),
            },
          },
          selectionRange: {
            start: {
              line: start.line,
              character: start.character,
              offset: document.offsetAt(start),
            },
            end: {
              line: end.line,
              character: end.character,
              offset: document.offsetAt(end),
            },
          },
        },
        typeName: localVariable.typeName,
        children: [],
      };
    }

    const matches = this.documentManager
      .findExactInRelated(uri, word)
      .filter((match) => match.symbol.kind !== 'parameter');
    if (matches.length === 0) {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 2-1. 現在ファイルの symbol を優先
     * ---------------------------------------------------------
     */
    const currentFileMatches = matches.filter((match) => match.symbol.location.uri === uri);
    if (currentFileMatches.length > 0) {
      const selected = this.selectBestSymbolAtPosition(
        currentFileMatches.map((match) => match.symbol),
        position,
      );
      if (selected) {
        return selected;
      }
    }

    /*
     * ---------------------------------------------------------
     * 2-2. ワークスペース全体
     * ---------------------------------------------------------
     */
    return this.selectBestSymbolAtPosition(
      matches.map((match) => match.symbol),
      position,
    );
  }

  private findPropertyByName(document: TextDocument, word: string): ShaderSymbol | null {
    const parsed = this.documentManager.getParsed(document.uri);
    if (!parsed) {
      return null;
    }

    if (!isShaderLabDocument(parsed.uri, parsed.languageId)) {
      return null;
    }

    const ast = parsed.ast as ShaderDocumentNode;
    if (!ast) {
      return null;
    }

    if (!ast.properties) {
      return null;
    }

    for (const property of ast.properties) {
      if (property.name !== word) {
        continue;
      }

      return {
        name: property.name,
        kind: 'property',
        location: {
          uri: document.uri,
          range: property.range,
          selectionRange: property.range,
        },
        children: [],
      };
    }

    return null;
  }

  private findCBufferFieldForProperty(uri: string, property: ShaderSymbol): ShaderSymbol | null {
    if (property.kind !== 'property') {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * Propertyと同名のCBuffer フィールドを検索。
     *
     * ただし、
     *
     *   現在Shader
     *   +
     *   include先
     *
     * だけを対象にする。
     *
     * ワークスペースで開いているだけの別Shaderは除外。
     * ---------------------------------------------------------
     */
    const matches = this.documentManager
      .findExactInRelated(uri, property.name)
      .filter((match) => match.symbol.kind === 'field' && !!match.symbol.parentName);
    for (const match of matches) {
      const symbol = match.symbol;
      return symbol;
    }

    return null;
  }

  private selectBestSymbolAtPosition(symbols: ShaderSymbol[], position: Position): ShaderSymbol | null {
    /*
     * まずカーソル位置が symbol の range 内に
     * 入っているものを探す。
     *
     * これが最優先。
     */
    for (const symbol of symbols) {
      const range = symbol.location.range;
      if (position.line < range.start.line || position.line > range.end.line) {
        continue;
      }

      if (position.line === range.start.line && position.character < range.start.character) {
        continue;
      }

      if (position.line === range.end.line && position.character > range.end.character) {
        continue;
      }

      return symbol;
    }

    /*
     * range に入っていない場合は、
     * 現在位置より前にある symbol を候補にする。
     */
    let best: ShaderSymbol | null = null;
    let bestLineDistance = Number.MAX_SAFE_INTEGER;
    for (const symbol of symbols) {
      const line = symbol.location.range.start.line;
      if (line > position.line) {
        continue;
      }

      const distance = position.line - line;
      if (distance < bestLineDistance) {
        bestLineDistance = distance;
        best = symbol;
      }
    }

    return best;
  }

  /*
   * -------------------------------------------------------------
   * メンバーアクセス取得
   *
   * カーソルが
   *
   * data.position
   *      ^^^^^^^^
   *
   * のどこにあっても、
   *
   * data
   *
   * と
   *
   * position
   *
   * を取得する。
   * -------------------------------------------------------------
   */
  private getMemberAccessAtPosition(
    text: string,
    offset: number,
  ): {
    objectName: string;
    memberName: string;
  } | null {
    if (text.length === 0) {
      return null;
    }

    offset = Math.max(0, Math.min(offset, text.length));
    const isIdentifierCharacter = (char: string): boolean => {
      return /[A-Za-z0-9_]/.test(char);
    };
    // カーソル位置から メンバー名の範囲を探す
    let memberStart = offset;
    while (memberStart > 0 && isIdentifierCharacter(text[memberStart - 1])) {
      memberStart--;
    }

    let memberEnd = offset;
    while (memberEnd < text.length && isIdentifierCharacter(text[memberEnd])) {
      memberEnd++;
    }

    if (memberStart === memberEnd) {
      return null;
    }

    const memberName = text.substring(memberStart, memberEnd);
    // メンバーの左側にある空白を飛ばす
    let dotOffset = memberStart;
    while (dotOffset > 0 && /\s/.test(text[dotOffset - 1])) {
      dotOffset--;
    }

    // "." がなければメンバーアクセスではない
    if (dotOffset <= 0 || text[dotOffset - 1] !== '.') {
      return null;
    }

    dotOffset--;
    // "." の左側の空白を飛ばす
    let objectEnd = dotOffset;
    while (objectEnd > 0 && /\s/.test(text[objectEnd - 1])) {
      objectEnd--;
    }

    // オブジェクト名を探す
    let objectStart = objectEnd;
    while (objectStart > 0 && isIdentifierCharacter(text[objectStart - 1])) {
      objectStart--;
    }

    if (objectStart === objectEnd) {
      return null;
    }

    const objectName = text.substring(objectStart, objectEnd);
    return {
      objectName,
      memberName,
    };
  }

  /*
   * -------------------------------------------------------------
   * ソースから変数宣言を探す
   *
   * float4 color = ...
   * float3 position;
   * MyStruct data;
   *
   * -------------------------------------------------------------
   */
  private findVariableDeclarationInSource(
    document: TextDocument,
    variableName: string,
    usageOffset: number,
  ): {
    name: string;
    typeName: string;
    uri: string;
    range: {
      start: {
        line: number;
        character: number;
      };
      end: {
        line: number;
        character: number;
      };
    };
  } | null {
    const parsed = this.documentManager.getParsed(document.uri);
    if (!parsed) {
      return null;
    }

    let best: { variable: HlslVariableNode; depth: number } | null = null;
    const visitFunction = (fn: HlslFunctionNode): void => {
      if (usageOffset < fn.range.start.offset || usageOffset > fn.range.end.offset) {
        return;
      }

      // 関数パラメータは関数本体から参照できるため、AST上の宣言位置を直接利用する。
      for (const parameter of fn.parameters) {
        if (parameter.name !== variableName || parameter.range.start.offset >= usageOffset) {
          continue;
        }
        const variable: HlslVariableNode = {
          kind: 'HlslVariable',
          typeName: parameter.typeName,
          name: parameter.name,
          semantic: parameter.semantic,
          range: parameter.range,
        };
        if (!best || best.depth < 0 || parameter.range.start.offset > best.variable.range.start.offset) {
          best = { variable, depth: 0 };
        }
      }

      for (const local of fn.locals) {
        if (local.name !== variableName || local.range.start.offset >= usageOffset || !local.scope) {
          continue;
        }
        if (usageOffset < local.scope.start.offset || usageOffset > local.scope.end.offset) {
          continue;
        }

        const depth = local.scope.start.offset;
        if (
          !best ||
          best.depth < depth ||
          (best.depth === depth && local.range.start.offset > best.variable.range.start.offset)
        ) {
          best = { variable: local, depth };
        }
      }
    };

    const visitHlslDocument = (hlsl: HlslDocumentNode): void => {
      for (const declaration of hlsl.declarations) {
        if (declaration.kind === 'HlslFunction') {
          visitFunction(declaration);
        }
      }
    };

    const visitShaderDocument = (shader: ShaderDocumentNode): void => {
      for (const block of shader.hlslBlocks) {
        visitHlslDocument(block.hlsl);
      }
      for (const subShader of shader.subShaders) {
        for (const block of subShader.hlslBlocks) {
          visitHlslDocument(block.hlsl);
        }
        for (const pass of subShader.passes) {
          for (const block of pass.hlslBlocks) {
            visitHlslDocument(block.hlsl);
          }
        }
      }
    };

    if (parsed.ast.kind === 'HlslDocument') {
      visitHlslDocument(parsed.ast);
    } else {
      visitShaderDocument(parsed.ast);
    }

    // クロージャ内で更新している変数はTypeScriptの制御フロー解析上、
    // 到達後にneverへ狭められることがあるため、ここで明示的に確定させる。
    const selectedBest = best as { variable: HlslVariableNode; depth: number } | null;
    if (!selectedBest) {
      return null;
    }

    return {
      name: selectedBest.variable.name,
      typeName: selectedBest.variable.typeName,
      uri: document.uri,
      range: selectedBest.variable.range,
    };
  }

  /*
   * -------------------------------------------------------------
   * struct.フィールド を検索
   * -------------------------------------------------------------
   */
  private findStructField(typeName: string, memberName: string, rootUri: string): ShaderSymbol | null {
    const normalizedType = typeName.replace(/\b(const|static|uniform|volatile|in|out|inout)\b/g, '').trim();
    const normalizedMember = memberName.toLowerCase();
    /*
     * ---------------------------------------------------------
     * 現在のファイルから到達可能なファイルだけを対象にする。
     *
     * ルートURI
     *   ├─ include A
     *   │    └─ include B
     *   └─ include C
     *
     * なら、
     *
     * ルートURI / A / B / C
     *
     * のStructだけが候補になる。
     *
     * ワークスペース上に存在するだけの別Shaderは対象外。
     * ---------------------------------------------------------
     */
    const structMatches = this.documentManager.findByKindInRelated(rootUri, normalizedType, 'struct');
    /*
     * ---------------------------------------------------------
     * 現在のファイルに同名Structがある場合は、
     * それを最優先する。
     *
     * 例:
     *
     * TestShader
     *   struct TestInput
     *
     * TestCommonHlsl
     *   struct TestInput
     *
     * の場合、TestShaderからの
     *
     *   input.uv
     *
     * は TestShader 側を優先する。
     * ---------------------------------------------------------
     */
    const orderedMatches = [
      ...structMatches.filter((match) => match.symbol.location.uri === rootUri),
      ...structMatches.filter((match) => match.symbol.location.uri !== rootUri),
    ];
    for (const match of orderedMatches) {
      const struct = match.symbol;
      const field = struct.children.find(
        (child) => child.kind === 'field' && child.name.toLowerCase() === normalizedMember,
      );
      if (!field) {
        continue;
      }

      return field;
    }

    return null;
  }

  /*
   * -------------------------------------------------------------
   * ローカル / ワークスペース object選択
   * -------------------------------------------------------------
   */
  private selectBestObjectSymbol(
    currentUri: string,
    currentOffset: number,
    symbols: ShaderSymbol[],
  ): ShaderSymbol | null {
    const localSymbols = symbols.filter((symbol) => symbol.location.uri === currentUri);
    if (localSymbols.length === 0) {
      return symbols[0] ?? null;
    }

    const beforeCursor = localSymbols.filter((symbol) => symbol.location.range.start.offset <= currentOffset);
    if (beforeCursor.length > 0) {
      beforeCursor.sort((a, b) => b.location.range.start.offset - a.location.range.start.offset);
      return beforeCursor[0];
    }

    return localSymbols[0];
  }

  /*
   * -------------------------------------------------------------
   * 定義選択
   * -------------------------------------------------------------
   */
  private selectBestDefinition(currentUri: string, symbols: ShaderSymbol[]): ShaderSymbol | null {
    if (symbols.length === 0) {
      return null;
    }

    const localSymbols = symbols.filter((symbol) => symbol.location.uri === currentUri);
    if (localSymbols.length > 0) {
      const priority: ShaderSymbol['kind'][] = [
        'parameter',
        'variable',
        'field',
        'function',
        'struct',
        'cbuffer',
        'property',
        'pass',
        'subShader',
        'shader',
        'macro',
        'include',
      ];
      const selected = this.selectByPriority(localSymbols, priority);
      if (selected) {
        return selected;
      }
    }

    const externalPriority: ShaderSymbol['kind'][] = [
      'function',
      'struct',
      'field',
      'variable',
      'cbuffer',
      'macro',
      'property',
      'parameter',
      'include',
    ];
    return this.selectByPriority(symbols, externalPriority);
  }

  private selectByPriority(symbols: ShaderSymbol[], priority: ShaderSymbol['kind'][]): ShaderSymbol | null {
    for (const kind of priority) {
      const found = symbols.find((symbol) => symbol.kind === kind);
      if (found) {
        return found;
      }
    }

    return symbols[0] ?? null;
  }

  /*
   * -------------------------------------------------------------
   * HLSL組み込み型
   * -------------------------------------------------------------
   */
  private isBuiltinHlslType(word: string): boolean {
    const builtinTypes = new Set([
      'void',
      'bool',
      'bool2',
      'bool3',
      'bool4',
      'int',
      'int2',
      'int3',
      'int4',
      'uint',
      'uint2',
      'uint3',
      'uint4',
      'half',
      'half2',
      'half3',
      'half4',
      'float',
      'float2',
      'float3',
      'float4',
      'double',
      'double2',
      'double3',
      'double4',
      'min16float',
      'min16float2',
      'min16float3',
      'min16float4',
      'min16int',
      'min16int2',
      'min16int3',
      'min16int4',
      'min16uint',
      'min16uint2',
      'min16uint3',
      'min16uint4',
    ]);
    return builtinTypes.has(word);
  }

  /*
   * -------------------------------------------------------------
   * HLSLセマンティクス
   * -------------------------------------------------------------
   */
  private isHlslSemantic(word: string): boolean {
    // HLSLセマンティクス は大文字表記だけを対象にする。
    // "position" のような通常の変数名・フィールド 名は セマンティクス として扱わない。
    if (word !== word.toUpperCase()) {
      return false;
    }

    return (
      /^SV_[A-Z0-9_]+$/.test(word) ||
      /^POSITION\d*$/.test(word) ||
      /^NORMAL\d*$/.test(word) ||
      /^TANGENT\d*$/.test(word) ||
      /^BINORMAL\d*$/.test(word) ||
      /^BLENDINDICES\d*$/.test(word) ||
      /^BLENDWEIGHT\d*$/.test(word) ||
      /^TEXCOORD\d*$/.test(word) ||
      /^COLOR\d*$/.test(word) ||
      /^PSIZE\d*$/.test(word) ||
      /^FOG\d*$/.test(word)
    );
  }

  /*
   * -------------------------------------------------------------
   * HLSLのSwizzle
   * -------------------------------------------------------------
   */
  private isHlslSwizzle(word: string): boolean {
    if (word.length < 1 || word.length > 4) {
      return false;
    }

    const lower = word.toLowerCase();
    const swizzleCharacters = new Set(['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a', 's', 't', 'p', 'q']);
    for (const character of lower) {
      if (!swizzleCharacters.has(character)) {
        return false;
      }
    }

    return true;
  }

  /*
   * -------------------------------------------------------------
   * 変数宣言として扱わないキーワード
   * -------------------------------------------------------------
   */
  private isVariableDeclarationKeyword(word: string): boolean {
    return new Set([
      'if',
      'else',
      'for',
      'while',
      'switch',
      'case',
      'return',
      'struct',
      'class',
      'cbuffer',
      'tbuffer',
      'SamplerState',
      'SamplerComparisonState',
      'Texture1D',
      'Texture2D',
      'Texture3D',
      'TextureCube',
      'RWTexture1D',
      'RWTexture2D',
      'RWTexture3D',
      'Buffer',
      'StructuredBuffer',
      'RWStructuredBuffer',
      'ByteAddressBuffer',
      'RWByteAddressBuffer',
    ]).has(word);
  }

  /*
   * -------------------------------------------------------------
   * Shaderシンボル → LSPのLocation
   * -------------------------------------------------------------
   */
  private toLocation(symbol: ShaderSymbol): Location {
    return {
      uri: symbol.location.uri,
      range: {
        start: {
          line: symbol.location.selectionRange.start.line,
          character: symbol.location.selectionRange.start.character,
        },
        end: {
          line: symbol.location.selectionRange.end.line,
          character: symbol.location.selectionRange.end.character,
        },
      },
    };
  }

  /*
   * -------------------------------------------------------------
   * 識別子取得
   * -------------------------------------------------------------
   */
  private getWordAtPosition(text: string, offset: number): string | null {
    if (text.length === 0) {
      return null;
    }

    offset = Math.max(0, Math.min(offset, text.length));
    let start = offset;
    let end = offset;
    const isIdentifierCharacter = (char: string): boolean => {
      return /[A-Za-z0-9_]/.test(char);
    };
    while (start > 0 && isIdentifierCharacter(text[start - 1])) {
      start--;
    }

    while (end < text.length && isIdentifierCharacter(text[end])) {
      end++;
    }

    if (start === end) {
      return null;
    }

    return text.substring(start, end);
  }

  private isInsideComment(uri: string, offset: number): boolean {
    const document = this.documentManager.get(uri);
    return document ? getSourceLexicalContextAtOffset(document.getText(), offset).inComment : false;
  }
}
