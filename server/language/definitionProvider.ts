import { Location, Position } from 'vscode-languageserver/node';
import { DocumentManager } from './documentManager';
import { ShaderSymbol } from '../symbol/symbol';
import { ParsedDocument } from '../parser/ast';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ShaderDocumentNode } from '../parser/ast';

export class DefinitionProvider {
  constructor(private readonly documentManager: DocumentManager) {}

  public provideDefinition(uri: string, position: Position): Location | null {
    const document = this.documentManager.get(uri);

    if (!document) {
      console.log(`[DefinitionProvider] Document not found: ${uri}`);

      return null;
    }

    const text = document.getText();

    const offset = document.offsetAt(position);

    const word = this.getWordAtPosition(text, offset);

    if (!word) {
      console.log(`[DefinitionProvider] No word at position`);

      return null;
    }

    /*
     * ---------------------------------------------------------
     * 0. Declaration self
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

      console.log(`[DefinitionProvider] Declaration self -> ` + `${match.symbol.kind} ` + `${match.symbol.name}`);

      return this.toLocation(match.symbol);
    }

    console.log(`[DefinitionProvider] Request "${word}" in ${uri}`);

    /*
     * ---------------------------------------------------------
     * 1. Built-in type / semantic
     * ---------------------------------------------------------
     */
    console.log(
      `[DefinitionProvider] builtin=${this.isBuiltinHlslType(word)} semantic=${this.isHlslSemantic(word)} word="${word}"`,
    );
    if (this.isBuiltinHlslType(word) || this.isHlslSemantic(word)) {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 2. Member access / swizzle
     *
     * color.rgb
     * data.position
     * a.position
     * ---------------------------------------------------------
     */

    const memberAccess = this.getMemberAccessAtPosition(text, offset);

    if (memberAccess) {
      console.log(`[DefinitionProvider] Member access: ` + `${memberAccess.objectName}.${memberAccess.memberName}`);

      /*
       * SwizzleならDefinition検索しない。
       */

      if (this.isHlslSwizzle(memberAccess.memberName)) {
        console.log(`[DefinitionProvider] Swizzle ignored: ` + `${memberAccess.memberName}`);

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
        console.log(`[DefinitionProvider] Local source variable: ` + `${localObject.name} : ${localObject.typeName}`);

        const member = this.findStructField(localObject.typeName, memberAccess.memberName, uri);

        if (member) {
          console.log(`[DefinitionProvider] Local member -> ` + `${member.location.uri} ` + `${member.name}`);

          return this.toLocation(member);
        }
      }

      /*
       * -----------------------------------------------------
       * WorkspaceIndex に登録されている variable / parameter
       * も調べる。
       * -----------------------------------------------------
       */

      const objectMatches = this.documentManager
        .getWorkspaceIndex()
        .findExact(memberAccess.objectName)
        .filter((match) => match.symbol.kind === 'variable' || match.symbol.kind === 'parameter');

      if (objectMatches.length > 0) {
        const objectSymbol = this.selectBestObjectSymbol(
          uri,
          offset,
          objectMatches.map((match) => match.symbol),
        );

        if (objectSymbol) {
          console.log(
            `[DefinitionProvider] Indexed object: ` +
              `${objectSymbol.name} : ` +
              `${objectSymbol.typeName ?? '<unknown>'}`,
          );

          if (objectSymbol.typeName) {
            const member = this.findStructField(objectSymbol.typeName, memberAccess.memberName, uri);

            if (member) {
              console.log(`[DefinitionProvider] Indexed member -> ` + `${member.location.uri} ` + `${member.name}`);

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

      this.loadIncludedDocuments(uri);

      /*
       * include先のstruct / fieldを検索
       */

      if (localObject) {
        const member = this.findStructField(localObject.typeName, memberAccess.memberName, uri);

        if (member) {
          return this.toLocation(member);
        }
      }

      /*
       * WorkspaceIndexのobjectを再検索
       */

      const externalObjectMatches = this.documentManager
        .getWorkspaceIndex()
        .findExact(memberAccess.objectName)
        .filter((match) => match.symbol.kind === 'variable' || match.symbol.kind === 'parameter');

      if (externalObjectMatches.length > 0) {
        const objectSymbol = this.selectBestObjectSymbol(
          uri,
          offset,
          externalObjectMatches.map((match) => match.symbol),
        );

        if (objectSymbol && objectSymbol.typeName) {
          const member = this.findStructField(objectSymbol.typeName, memberAccess.memberName, uri);

          if (member) {
            return this.toLocation(member);
          }
        }
      }

      /*
       * Memberとして解決できなかった場合、
       * 通常の名前検索には落とさない。
       *
       * 例えば
       *
       * data.unknown
       *
       * の unknown を別ファイルの同名functionへ
       * 飛ばしてしまうのを防ぐ。
       */

      return null;
    }
    /*
     * ---------------------------------------------------------
     * 3.5 ShaderLab Property
     *
     * 現在のShaderに同名Propertyが存在する場合、
     * Global WorkspaceIndexより優先する。
     * ---------------------------------------------------------
     */

    const currentProperty = this.findPropertyByName(document, word);

    if (currentProperty) {
      console.log(`[DefinitionProvider] ` + `Current Shader Property -> ` + `${currentProperty.name}`);

      const cbufferField = this.findCBufferFieldForProperty(uri, currentProperty);

      if (cbufferField) {
        console.log(
          `[DefinitionProvider] ` +
            `Property -> related CBuffer field: ` +
            `${cbufferField.name} ` +
            `parent=${cbufferField.parentName}`,
        );

        return this.toLocation(cbufferField);
      }

      /*
       * 現在のShaderから到達可能なCBufferがない場合、
       * Property自身へ移動する。
       */
      console.log(`[DefinitionProvider] ` + `Property -> declaration: ` + `${currentProperty.name}`);

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
      console.log(
        `[DefinitionProvider] Source variable -> ` + `${localVariable.name} : ` + `${localVariable.typeName}`,
      );

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

    console.log(`[DefinitionProvider] Local matches: ` + `${localMatches.length}`);

    if (localMatches.length > 0) {
      const localSymbols = localMatches.map((match) => match.symbol);

      const selected = this.selectBestDefinition(uri, localSymbols);

      if (selected) {
        console.log(`[DefinitionProvider] Local -> ` + `${selected.kind} ${selected.name}`);

        /*
         * -----------------------------------------------------
         * Property
         *
         * Propertyを現在ファイル内で発見できた場合、
         * Workspace全体の検索には絶対に進ませない。
         * -----------------------------------------------------
         */

        if (selected.kind === 'property') {
          const cbufferField = this.findCBufferFieldForProperty(uri, selected);

          if (cbufferField) {
            console.log(
              `[DefinitionProvider] ` +
                `Property -> related CBuffer field: ` +
                `${cbufferField.name} ` +
                `parent=${cbufferField.parentName}`,
            );

            return this.toLocation(cbufferField);
          }

          console.log(`[DefinitionProvider] ` + `Property has no same-file CBuffer field: ` + `${selected.name}`);

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

    console.log(`[DefinitionProvider] Loading includes from ${uri}`);

    this.loadIncludedDocuments(uri);

    console.log(`[DefinitionProvider] Finished loading includes`);

    /*
     * ---------------------------------------------------------
     * 6. Workspace全体
     * ---------------------------------------------------------
     */

    const relatedUris = new Set<string>();

    relatedUris.add(uri);
    this.collectRelatedIncludeUris(uri, relatedUris);

    const matches = this.documentManager
      .getWorkspaceIndex()
      .findExact(word)
      .filter((match) => relatedUris.has(match.symbol.location.uri) && match.symbol.kind !== 'parameter');

    console.log(
      `[DefinitionProvider] Related search "${word}" -> ` + `${matches.length} ` + `(related=${relatedUris.size})`,
    );

    for (const match of matches) {
      console.log(
        `[DefinitionProvider] Match: ` + `${match.symbol.kind} ` + `${match.symbol.name} @ ` + `${match.uri}`,
      );
    }

    if (matches.length === 0) {
      return null;
    }

    const symbols = matches.map((match) => match.symbol);

    const selected = this.selectBestDefinition(uri, symbols);

    if (!selected) {
      return null;
    }

    console.log(`[DefinitionProvider] Related -> ` + `${selected.kind} ${selected.name} @ ${selected.location.uri}`);

    return this.toLocation(selected);
  }

  private findPropertyByName(document: TextDocument, word: string): ShaderSymbol | null {
    const parsed = this.documentManager.getParsed(document.uri);

    console.log(`[DefinitionProvider] findPropertyByName: ` + `uri=${document.uri} ` + `word="${word}"`);

    if (!parsed) {
      console.log(`[DefinitionProvider] findPropertyByName: parsed=null`);
      return null;
    }

    console.log(`[DefinitionProvider] findPropertyByName: ` + `languageId=${parsed.languageId}`);

    if (parsed.languageId !== 'shaderlab') {
      console.log(`[DefinitionProvider] findPropertyByName: ` + `not shaderlab`);
      return null;
    }

    const ast = parsed.ast as ShaderDocumentNode;

    if (!ast) {
      console.log(`[DefinitionProvider] findPropertyByName: ast=null`);
      return null;
    }

    if (!ast.properties) {
      console.log(`[DefinitionProvider] findPropertyByName: ` + `properties=null`);
      return null;
    }

    console.log(`[DefinitionProvider] findPropertyByName: ` + `properties=${ast.properties.length}`);

    for (const property of ast.properties) {
      console.log(`[DefinitionProvider] Property candidate: ` + `"${property.name}"`);

      if (property.name !== word) {
        continue;
      }

      console.log(`[DefinitionProvider] Current Shader Property found: ` + `${property.name}`);

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

    console.log(`[DefinitionProvider] Current Shader Property NOT found: ` + `"${word}"`);

    return null;
  }
  private findCBufferFieldForProperty(uri: string, property: ShaderSymbol): ShaderSymbol | null {
    if (property.kind !== 'property') {
      return null;
    }

    /*
     * ---------------------------------------------------------
     * 現在のShaderと、そのinclude先をロードする。
     * ---------------------------------------------------------
     */
    this.loadIncludedDocuments(uri);

    /*
     * ---------------------------------------------------------
     * 現在Shaderから参照可能なURIを取得する。
     *
     * rootUri自身も含む。
     * ---------------------------------------------------------
     */
    const relatedUris = new Set<string>();

    relatedUris.add(uri);

    this.collectRelatedIncludeUris(uri, relatedUris);

    /*
     * ---------------------------------------------------------
     * Propertyと同名のCBuffer fieldを検索。
     *
     * ただし、
     *
     *   現在Shader
     *   +
     *   include先
     *
     * だけを対象にする。
     *
     * Workspaceで開いているだけの別Shaderは除外。
     * ---------------------------------------------------------
     */
    const matches = this.documentManager
      .getWorkspaceIndex()
      .findExact(property.name)
      .filter((match) => relatedUris.has(match.uri) && match.symbol.kind === 'field' && !!match.symbol.parentName);

    console.log(`[DefinitionProvider] ` + `Property CBuffer search "${property.name}" -> ` + `${matches.length}`);

    for (const match of matches) {
      const symbol = match.symbol;

      console.log(
        `[DefinitionProvider] ` +
          `Property -> related CBuffer field: ` +
          `${symbol.name} ` +
          `@ ${symbol.location.uri} ` +
          `parent=${symbol.parentName}`,
      );

      return symbol;
    }

    return null;
  }

  private collectRelatedIncludeUris(rootUri: string, result: Set<string>): void {
    const visited = new Set<string>();

    const parsed = this.documentManager.getParsed(rootUri);

    if (!parsed) {
      return;
    }

    this.collectRelatedIncludeUrisRecursive(rootUri, parsed, visited, result);
  }
  private collectRelatedIncludeUrisRecursive(
    uri: string,
    parsed: ParsedDocument,
    visited: Set<string>,
    result: Set<string>,
    source?: string,
  ): void {
    if (visited.has(uri)) {
      return;
    }

    visited.add(uri);

    let includePaths: string[];

    /*
     * HLSL外部ファイルの場合は、
     * 実ファイルのsourceからincludeを取得する。
     */
    if (parsed.languageId === 'hlsl' && source !== undefined) {
      includePaths = this.collectRawHlslIncludes(source);
    } else {
      includePaths = this.collectIncludes(parsed);
    }

    for (const includePath of includePaths) {
      const resolved = this.documentManager.getProjectService().resolveInclude(includePath, uri);

      if (!resolved) {
        continue;
      }

      /*
       * Include先のURIを関連ファイルとして登録。
       */
      result.add(resolved.uri);

      /*
       * Include先をWorkspaceIndexへ登録。
       */
      const externalDocument = this.documentManager.ensureExternalDocument(resolved.uri);

      if (!externalDocument) {
        continue;
      }

      /*
       * Include先の実ソースを取得。
       *
       * 次のincludeを再帰的に調べるために必要。
       */
      const externalSource = this.documentManager.getProjectService().readFile(resolved.resolvedPath);

      this.collectRelatedIncludeUrisRecursive(resolved.uri, externalDocument, visited, result, externalSource);
    }
  }

  public resolveSymbolAtPosition(uri: string, position: Position): ShaderSymbol | null {
    const document = this.documentManager.get(uri);

    if (!document) {
      return null;
    }

    const text = document.getText();

    const offset = document.offsetAt(position);

    const word = this.getWordAtPosition(text, offset);

    if (!word) {
      return null;
    }

    console.log(`[DefinitionProvider] Resolve symbol "${word}"`);

    /*
     * ---------------------------------------------------------
     * 1. Member access
     *
     * a.position
     * b.position
     * input.position
     * ---------------------------------------------------------
     */

    const memberAccess = this.getMemberAccessAtPosition(text, offset);

    if (memberAccess) {
      console.log(`[DefinitionProvider] Resolve member: ` + `${memberAccess.objectName}.${memberAccess.memberName}`);

      /*
       * HLSL swizzle は symbol ではない。
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
        console.log(`[DefinitionProvider] Hover local object: ` + `${localObject.name} : ${localObject.typeName}`);

        const member = this.findStructField(localObject.typeName, memberAccess.memberName, uri);

        if (member) {
          console.log(`[DefinitionProvider] Hover local member -> ` + `${member.location.uri} ` + `${member.name}`);

          return member;
        }
      }

      /*
       * -----------------------------------------------------
       * 1-2. WorkspaceIndex の variable / parameter
       * -----------------------------------------------------
       */

      const objectMatches = this.documentManager
        .getWorkspaceIndex()
        .findExact(memberAccess.objectName)
        .filter((match) => match.symbol.kind === 'variable' || match.symbol.kind === 'parameter');

      if (objectMatches.length > 0) {
        const objectSymbol = this.selectBestObjectSymbol(
          uri,
          offset,
          objectMatches.map((match) => match.symbol),
        );

        if (objectSymbol && objectSymbol.typeName) {
          console.log(
            `[DefinitionProvider] Hover indexed object: ` + `${objectSymbol.name} : ` + `${objectSymbol.typeName}`,
          );

          const member = this.findStructField(objectSymbol.typeName, memberAccess.memberName, uri);

          if (member) {
            console.log(`[DefinitionProvider] Hover indexed member -> ` + `${member.location.uri} ` + `${member.name}`);

            return member;
          }
        }
      }

      /*
       * -----------------------------------------------------
       * 1-3. include を読み込む
       * -----------------------------------------------------
       */

      this.loadIncludedDocuments(uri);

      /*
       * -----------------------------------------------------
       * 1-4. include 後に WorkspaceIndex を再検索
       * -----------------------------------------------------
       */

      const externalObjectMatches = this.documentManager
        .getWorkspaceIndex()
        .findExact(memberAccess.objectName)
        .filter((match) => match.symbol.kind === 'variable' || match.symbol.kind === 'parameter');

      if (externalObjectMatches.length > 0) {
        const objectSymbol = this.selectBestObjectSymbol(
          uri,
          offset,
          externalObjectMatches.map((match) => match.symbol),
        );

        if (objectSymbol && objectSymbol.typeName) {
          console.log(
            `[DefinitionProvider] Hover external object: ` + `${objectSymbol.name} : ` + `${objectSymbol.typeName}`,
          );

          const member = this.findStructField(objectSymbol.typeName, memberAccess.memberName, uri);

          if (member) {
            console.log(
              `[DefinitionProvider] Hover external member -> ` + `${member.location.uri} ` + `${member.name}`,
            );

            return member;
          }
        }
      }

      /*
       * Member access を通常の名前検索には
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
     * variable
     * parameter
     * struct
     * field
     * function
     * property
     * etc.
     * ---------------------------------------------------------
     */

    const relatedUris = new Set<string>();

    relatedUris.add(uri);
    this.collectRelatedIncludeUris(uri, relatedUris);

    const matches = this.documentManager
      .getWorkspaceIndex()
      .findExact(word)
      .filter((match) => relatedUris.has(match.symbol.location.uri) && match.symbol.kind !== 'parameter');

    if (matches.length === 0) {
      /*
       * include をロードしてから再検索。
       */
      this.loadIncludedDocuments(uri);

      const retryMatches = this.documentManager
        .getWorkspaceIndex()
        .findExact(word)
        .filter((match) => relatedUris.has(match.symbol.location.uri) && match.symbol.kind !== 'parameter');
      if (retryMatches.length === 0) {
        return null;
      }

      return this.selectBestSymbolAtPosition(
        retryMatches.map((match) => match.symbol),
        position,
      );
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
     * 2-2. Workspace 全体
     * ---------------------------------------------------------
     */

    return this.selectBestSymbolAtPosition(
      matches.map((match) => match.symbol),
      position,
    );
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
   * Member access取得
   *
   * cursorが
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

    // カーソル位置から member 名の範囲を探す
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

    // member の左側にある空白を飛ばす
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

    // object 名を探す
    let objectStart = objectEnd;

    while (objectStart > 0 && isIdentifierCharacter(text[objectStart - 1])) {
      objectStart--;
    }

    if (objectStart === objectEnd) {
      return null;
    }

    const objectName = text.substring(objectStart, objectEnd);

    console.log(`[DefinitionProvider] getMemberAccessAtPosition -> ${objectName}.${memberName}`);

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
    const text = document.getText();
    const functionScope = this.findFunctionScopeAtOffset(document, usageOffset);
    const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /*
     * ---------------------------------------------------------
     * 1. 通常の変数宣言
     *
     * float4 color;
     * float3 position;
     * MyStruct data;
     * const MyStruct data;
     * static MyStruct data;
     * ---------------------------------------------------------
     */

    const variablePattern = new RegExp(
      '\\b' +
        '(?:(?:const|static|uniform|volatile|in|out|inout)\\s+)*' +
        '([A-Za-z_][A-Za-z0-9_]*)' +
        '\\s+' +
        escapedName +
        '\\s*(?==|;|,|\\[|:)',
      'g',
    );

    let best: {
      name: string;
      typeName: string;
      startOffset: number;
      endOffset: number;
      blockDepth?: number;
    } | null = null;

    let match: RegExpExecArray | null;

    while ((match = variablePattern.exec(text)) !== null) {
      const startOffset = match.index;

      if (startOffset >= usageOffset) {
        continue;
      }
      if (functionScope) {
        if (startOffset < functionScope.startOffset || startOffset > functionScope.endOffset) {
          continue;
        }
      }
      const typeName = match[1];

      if (this.isVariableDeclarationKeyword(typeName)) {
        continue;
      }

      const nameStart = text.indexOf(variableName, startOffset);

      if (nameStart < 0) {
        continue;
      }

      if (!best || startOffset > best.startOffset) {
        const declarationBlock = this.findBlockScopeAtOffset(text, startOffset);

        if (!declarationBlock) {
          continue;
        }

        /*
         * 宣言を含むblockのスコープ内に
         * 使用位置が存在する必要がある。
         *
         * 外側block:
         *
         * {
         *     position;        // declarationBlock = 外側
         *
         *     {
         *         position;    // declarationBlock = 内側
         *     }
         *
         *     position;        // 内側positionはここでは不可
         * }
         */
        if (usageOffset < declarationBlock.startOffset || usageOffset > declarationBlock.endOffset) {
          continue;
        }

        /*
         * 同名変数が複数ある場合、
         * 使用位置を含む最も内側のblockを優先する。
         */
        if (
          !best ||
          best.blockDepth === undefined ||
          declarationBlock.depth > best.blockDepth ||
          (declarationBlock.depth === best.blockDepth && startOffset > best.startOffset)
        ) {
          best = {
            name: variableName,
            typeName,
            startOffset: nameStart,
            endOffset: nameStart + variableName.length,
            blockDepth: declarationBlock.depth,
          };
        }
      }
    }

    if (best) {
      return {
        name: best.name,

        typeName: best.typeName,

        uri: document.uri,

        range: this.rangeFromOffsets(document, best.startOffset, best.endOffset),
      };
    }

    /*
     * ---------------------------------------------------------
     * 2. 関数パラメータ
     *
     * float4 Test(MyStruct a, MyStruct b)
     *
     * a.position
     * b.position
     *
     * ここを現在の実装では拾えていなかった。
     * ---------------------------------------------------------
     */

    const parameterPattern = new RegExp(
      '\\b' + '([A-Za-z_][A-Za-z0-9_]*)' + '\\s+' + escapedName + '\\s*(?=[,)])',
      'g',
    );

    while ((match = parameterPattern.exec(text)) !== null) {
      const startOffset = match.index;

      if (startOffset >= usageOffset) {
        continue;
      }

      if (functionScope) {
        /*
         * parameter は function body の外側にある。
         *
         *     float2 GetUV(float2 uv)
         *     {
         *         return uv;
         *     }
         *
         *                 ^ functionScope.startOffset
         *
         * なので、
         *
         *   signatureStartOffset <= parameter < startOffset
         *
         * の範囲を parameter として扱う。
         */
        if (startOffset < functionScope.signatureStartOffset || startOffset >= functionScope.startOffset) {
          continue;
        }
      }

      const typeName = match[1];

      if (this.isVariableDeclarationKeyword(typeName)) {
        continue;
      }

      /*
       * structのフィールドなどを
       * parameterと誤認しないため、
       * 直前が "(" または "," のケースだけを
       * parameterとして扱う。
       */
      let before = startOffset - 1;

      while (before >= 0 && /\s/.test(text[before])) {
        before--;
      }

      if (before < 0) {
        continue;
      }

      const beforeChar = text[before];

      if (beforeChar !== '(' && beforeChar !== ',') {
        continue;
      }

      const nameStart = text.indexOf(variableName, startOffset);

      if (nameStart < 0) {
        continue;
      }

      if (!best || startOffset > best.startOffset) {
        best = {
          name: variableName,
          typeName,
          startOffset: nameStart,
          endOffset: nameStart + variableName.length,
        };
      }
    }

    if (!best) {
      return null;
    }

    return {
      name: best.name,

      typeName: best.typeName,

      uri: document.uri,

      range: this.rangeFromOffsets(document, best.startOffset, best.endOffset),
    };
  }

  /*
   * -------------------------------------------------------------
   * struct.field を検索
   * -------------------------------------------------------------
   */

  private findStructField(typeName: string, memberName: string, rootUri: string): ShaderSymbol | null {
    const normalizedType = typeName.replace(/\b(const|static|uniform|volatile|in|out|inout)\b/g, '').trim();

    const normalizedMember = memberName.toLowerCase();

    /*
     * ---------------------------------------------------------
     * 現在のファイルから到達可能なファイルだけを対象にする。
     *
     * rootUri
     *   ├─ include A
     *   │    └─ include B
     *   └─ include C
     *
     * なら、
     *
     * rootUri / A / B / C
     *
     * のStructだけが候補になる。
     *
     * Workspace上に存在するだけの別Shaderは対象外。
     * ---------------------------------------------------------
     */

    this.loadIncludedDocuments(rootUri);

    const relatedUris = new Set<string>();
    relatedUris.add(rootUri);

    this.collectRelatedIncludeUris(rootUri, relatedUris);

    const structMatches = this.documentManager
      .getWorkspaceIndex()
      .findByKind(normalizedType, 'struct')
      .filter((match) => relatedUris.has(match.symbol.location.uri));

    console.log(
      `[DefinitionProvider] Struct lookup: ` +
        `${normalizedType} -> ` +
        `${structMatches.length} ` +
        `(related=${relatedUris.size})`,
    );

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

      console.log(
        `[DefinitionProvider] Field resolved: ` + `${normalizedType}.${memberName} @ ` + `${field.location.uri}`,
      );

      return field;
    }

    console.log(`[DefinitionProvider] Field not found: ` + `${normalizedType}.${memberName}`);

    return null;
  }

  /*
   * -------------------------------------------------------------
   * ローカル / Workspace object選択
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
   * Include再帰
   * -------------------------------------------------------------
   */

  private loadIncludedDocuments(rootUri: string): void {
    const visited = new Set<string>();

    const parsed = this.documentManager.getParsed(rootUri);

    if (!parsed) {
      return;
    }

    this.loadIncludedDocumentsRecursive(rootUri, parsed, visited);
  }

  private loadIncludedDocumentsRecursive(
    uri: string,
    parsed: ParsedDocument,
    visited: Set<string>,
    source?: string,
  ): void {
    if (visited.has(uri)) {
      return;
    }

    visited.add(uri);

    let includePaths: string[];

    if (parsed.languageId === 'hlsl' && source !== undefined) {
      includePaths = this.collectRawHlslIncludes(source);
    } else {
      includePaths = this.collectIncludes(parsed);
    }

    for (const includePath of includePaths) {
      const resolved = this.documentManager.getProjectService().resolveInclude(includePath, uri);

      if (!resolved) {
        continue;
      }

      const externalDocument = this.documentManager.ensureExternalDocument(resolved.uri);

      if (!externalDocument) {
        continue;
      }

      const externalSource = this.documentManager.getProjectService().readFile(resolved.resolvedPath);

      this.loadIncludedDocumentsRecursive(resolved.uri, externalDocument, visited, externalSource);
    }
  }

  /*
   * -------------------------------------------------------------
   * Include収集
   * -------------------------------------------------------------
   */

  private collectIncludes(parsed: ParsedDocument): string[] {
    const result: string[] = [];

    if (parsed.ast.kind === 'ShaderDocument') {
      this.collectShaderLabIncludes(parsed.ast, result);
    } else {
      this.collectHlslIncludes(parsed.ast, result);
    }

    return result;
  }

  private collectHlslIncludes(ast: any, result: string[]): void {
    if (!ast || !Array.isArray(ast.declarations)) {
      return;
    }

    for (const declaration of ast.declarations) {
      if (declaration?.kind === 'HlslInclude' && typeof declaration.path === 'string') {
        result.push(declaration.path);
      }
    }
  }

  private collectShaderLabIncludes(ast: any, result: string[]): void {
    if (!ast) {
      return;
    }

    if (Array.isArray(ast.hlslBlocks)) {
      for (const block of ast.hlslBlocks) {
        this.collectHlslIncludes(block?.hlsl, result);
      }
    }

    if (!Array.isArray(ast.subShaders)) {
      return;
    }

    for (const subShader of ast.subShaders) {
      if (Array.isArray(subShader.hlslBlocks)) {
        for (const block of subShader.hlslBlocks) {
          this.collectHlslIncludes(block?.hlsl, result);
        }
      }

      if (!Array.isArray(subShader.passes)) {
        continue;
      }

      for (const pass of subShader.passes) {
        if (!Array.isArray(pass.hlslBlocks)) {
          continue;
        }

        for (const block of pass.hlslBlocks) {
          this.collectHlslIncludes(block?.hlsl, result);
        }
      }
    }
  }

  /*
   * -------------------------------------------------------------
   * Raw HLSL include
   * -------------------------------------------------------------
   */

  private collectRawHlslIncludes(source: string): string[] {
    const includes: string[] = [];

    const lines = source.split(/\r?\n/);

    for (const line of lines) {
      const match = line.match(/^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/);

      if (!match) {
        continue;
      }

      const includePath = match[1] ?? match[2];

      if (!includePath) {
        continue;
      }

      includes.push(includePath);
    }

    return includes;
  }

  /*
   * -------------------------------------------------------------
   * Definition選択
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
   * Built-in HLSL type
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
   * HLSL semantic
   * -------------------------------------------------------------
   */

  private isHlslSemantic(word: string): boolean {
    // HLSL semantic は大文字表記だけを対象にする。
    // "position" のような通常の変数名・field 名は semantic として扱わない。
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
   * HLSL Swizzle
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
   * 変数宣言として扱わないkeyword
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
   * Offset → Range
   * -------------------------------------------------------------
   */

  private rangeFromOffsets(document: TextDocument, startOffset: number, endOffset: number) {
    return {
      start: document.positionAt(startOffset),

      end: document.positionAt(endOffset),
    };
  }

  /*
   * -------------------------------------------------------------
   * ShaderSymbol → LSP Location
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
   * identifier取得
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
  private findBlockScopeAtOffset(
    text: string,
    offset: number,
  ): {
    startOffset: number;
    endOffset: number;
    depth: number;
  } | null {
    const stack: number[] = [];

    let bestStart = -1;
    let bestEnd = -1;
    let bestDepth = -1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '{') {
        stack.push(i);
        continue;
      }

      if (char !== '}') {
        continue;
      }

      if (stack.length === 0) {
        continue;
      }

      const startOffset = stack.pop()!;

      /*
       * このblockが使用位置を含むか確認。
       */
      if (offset >= startOffset && offset <= i + 1) {
        const depth = stack.length + 1;

        if (depth > bestDepth) {
          bestStart = startOffset;
          bestEnd = i + 1;
          bestDepth = depth;
        }
      }
    }

    if (bestStart < 0) {
      return null;
    }

    return {
      startOffset: bestStart,
      endOffset: bestEnd,
      depth: bestDepth,
    };
  }
  private findFunctionScopeAtOffset(
    document: TextDocument,
    offset: number,
  ): {
    signatureStartOffset: number;
    startOffset: number;
    endOffset: number;
  } | null {
    const text = document.getText();

    /*
     * 関数の { を探す。
     *
     * HLSLでは、
     *
     *     ReturnType FunctionName(...)
     *     {
     *         ...
     *     }
     *
     * という構造なので、カーソル位置より前にある
     * function body の開始位置を探す。
     */

    const functionPattern = /\b[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^{};]*\)\s*\{/g;

    let match: RegExpExecArray | null;
    let bestSignatureStart = -1;
    let bestStart = -1;
    let bestEnd = -1;

    while ((match = functionPattern.exec(text)) !== null) {
      const openBraceOffset = match.index + match[0].lastIndexOf('{');

      if (openBraceOffset >= offset) {
        continue;
      }

      /*
       * この { に対応する } を探す。
       */
      let depth = 0;
      let endOffset = -1;

      for (let i = openBraceOffset; i < text.length; i++) {
        const char = text[i];

        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;

          if (depth === 0) {
            endOffset = i + 1;
            break;
          }
        }
      }

      if (endOffset < 0) {
        continue;
      }

      /*
       * カーソルがこの関数内にある。
       *
       * ネストした関数はHLSLでは通常存在しないため、
       * 最も内側の一致を採用する。
       */
      if (offset >= openBraceOffset && offset <= endOffset) {
        if (bestStart < 0 || openBraceOffset > bestStart) {
          bestSignatureStart = match.index;
          bestStart = openBraceOffset;
          bestEnd = endOffset;
        }
      }
    }

    if (bestStart < 0) {
      return null;
    }

    return {
      signatureStartOffset: bestSignatureStart,
      startOffset: bestStart,
      endOffset: bestEnd,
    };
  }
}
