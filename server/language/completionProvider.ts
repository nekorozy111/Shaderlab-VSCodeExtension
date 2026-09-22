import { CompletionItem, CompletionItemKind, Position } from 'vscode-languageserver/node';
import { DocumentManager } from './documentManager';
import { ShaderSymbol } from '../symbol/symbol';
import { IncludeResolver } from '../project/includeResolver';
export class CompletionProvider {
  public constructor(
    private readonly documentManager: DocumentManager,
    private readonly includeResolver: IncludeResolver,
  ) {}

  private readonly completionSource = 'ShaderLab IntelliSense';
  public provideCompletion(uri: string, position: Position): CompletionItem[] {
    const document = this.documentManager.get(uri);

    if (!document) {
      return [];
    }

    const text = document.getText();

    const offset = document.offsetAt(position);

    if (this.isInsideComment(text, offset)) {
      return [];
    }
    /*
     * ============================================================
     * #include Completion
     * ============================================================
     *
     * #include "..." の中は通常の string として扱われるため、
     * isInsideString() より前に判定する必要がある。
     */
    const includeContext = this.getIncludeCompletionContext(text, offset);

    if (includeContext) {
      return this.provideIncludeCompletion(uri, includeContext, offset);
    }

    /*
     * 通常の string 内では Completion を出さない。
     */
    if (this.isInsideString(text, offset)) {
      return [];
    }

    const word = this.getWordBeforeCursor(text, offset);

    if (!this.isInsideHlslContext(text, offset)) {
      return [];
    }

    const memberAccess = this.getMemberAccessAtPosition(text, offset);

    if (memberAccess) {
      return this.provideMemberCompletion(uri, memberAccess.objectName, memberAccess.prefix, offset);
    }

    const result: CompletionItem[] = [];

    /*
     * Local variables
     */
    result.push(...this.findLocalVariableCompletions(uri, word, offset));

    /*
     * Built-in HLSL types
     */
    for (const typeName of this.getBuiltinTypes()) {
      if (!typeName.startsWith(word)) {
        continue;
      }

      result.push({
        label: typeName,
        kind: CompletionItemKind.Keyword,
        detail: 'HLSL built-in type',
        documentation: this.completionSource,
      });
    }

    const builtinSemantics = this.getBuiltinSemantics();

    for (const semantic of builtinSemantics) {
      if (semantic.toLowerCase().startsWith(word.toLowerCase())) {
        result.push({
          label: semantic,
          kind: CompletionItemKind.Keyword,
          detail: 'HLSL Semantic',
          documentation: `${semantic} semantic`,
          sortText: `2_${semantic}`,
          data: {
            source: this.completionSource,
          },
        });
      }
    }

    /*
     * Workspace symbols
     *
     * Only symbols from the current file
     * and recursively related includes are
     * available.
     */
    const relatedUris = this.documentManager.getRelatedIncludeUris(uri);

    const matches = this.documentManager
      .getWorkspaceIndex()
      .findPrefix(word)
      .filter((match) => relatedUris.has(match.uri));

    this.addSymbolCompletions(result, matches, new Set<string>());

    return result;
  }

  private addSymbolCompletions(result: CompletionItem[], matches: any[], seen: Set<string>): void {
    for (const match of matches) {
      const symbol = match.symbol;

      if (!symbol) {
        continue;
      }

      const name = symbol.name;

      if (!name) {
        continue;
      }

      /*
       * 同じ名前の Completion は
       * 1件だけ表示する。
       */
      if (seen.has(name)) {
        continue;
      }

      seen.add(name);

      result.push({
        label: name,

        kind: this.getCompletionKind(symbol),

        detail: this.getSymbolDetail(symbol),

        documentation: {
          kind: 'markdown',
          value: this.getSymbolDocumentation(symbol),
        },

        sortText: this.getCompletionSortText(symbol),
      });
    }
  }

  private getCompletionKind(symbol: ShaderSymbol): CompletionItemKind {
    switch (symbol.kind) {
      case 'shader':
        return CompletionItemKind.Class;

      case 'property':
        return CompletionItemKind.Property;

      case 'struct':
        return CompletionItemKind.Struct;

      case 'field':
        return CompletionItemKind.Field;

      case 'function':
        return CompletionItemKind.Function;

      case 'parameter':
        return CompletionItemKind.Variable;

      case 'variable':
        return CompletionItemKind.Variable;

      case 'cbuffer':
        return CompletionItemKind.Struct;

      case 'macro':
        return CompletionItemKind.Constant;

      case 'include':
        return CompletionItemKind.File;

      case 'subShader':
      case 'pass':
        return CompletionItemKind.Module;

      default:
        return CompletionItemKind.Text;
    }
  }

  private getSymbolDetail(symbol: ShaderSymbol): string {
    switch (symbol.kind) {
      case 'function':
        return symbol.returnType ? `function ${symbol.returnType}` : 'function';

      case 'struct':
        return 'struct';

      case 'field':
        return symbol.typeName ? `field ${symbol.typeName}` : 'field';

      case 'parameter':
        return symbol.typeName ? `parameter ${symbol.typeName}` : 'parameter';

      case 'variable':
        return symbol.typeName ? `variable ${symbol.typeName}` : 'variable';

      case 'cbuffer':
        return 'cbuffer';

      case 'property':
        return symbol.typeName ? `property ${symbol.typeName}` : 'property';

      case 'macro':
        return 'macro';

      case 'include':
        return 'include';

      case 'shader':
        return 'shader';

      case 'subShader':
        return 'SubShader';

      case 'pass':
        return 'Pass';

      default:
        return symbol.kind;
    }
  }

  private provideMemberCompletion(uri: string, objectName: string, prefix: string, offset: number): CompletionItem[] {
    const index = this.documentManager.getWorkspaceIndex();

    let typeName: string | undefined;

    /*
     * ============================================================
     * 1. 現在位置のローカル変数を探す
     * ============================================================
     *
     * 例:
     *
     * Varyings output;
     *
     * output.
     *
     * → output = Varyings
     */
    const localVariable = this.findLocalVariableDeclaration(uri, objectName, offset);

    if (localVariable) {
      typeName = localVariable.typeName;
    }

    /*
     * ============================================================
     * 2. WorkspaceIndex から探す
     * ============================================================
     *
     * local variable が見つからない場合、
     * parameter / variable を探す。
     *
     * これで input. も従来通り動く。
     */
    if (!typeName) {
      const relatedUris = this.documentManager.getRelatedIncludeUris(uri);

      const objectMatches = index.findExact(objectName).filter((match) => relatedUris.has(match.uri));

      /*
       * 現在のファイルを優先。
       */
      for (const match of objectMatches) {
        if (match.uri !== uri) {
          continue;
        }

        if (match.symbol.kind !== 'variable' && match.symbol.kind !== 'parameter') {
          continue;
        }

        typeName = match.symbol.typeName;

        if (typeName) {
          break;
        }
      }

      /*
       * 現在のファイルになければ
       * Workspace 全体から探す。
       */
      if (!typeName) {
        for (const match of objectMatches) {
          if (match.symbol.kind !== 'variable' && match.symbol.kind !== 'parameter') {
            continue;
          }

          typeName = match.symbol.typeName;

          if (typeName) {
            break;
          }
        }
      }
    }
    // 関数戻り値
    if (!typeName) {
      const relatedUris = this.documentManager.getRelatedIncludeUris(uri);

      const functionMatches = this.documentManager
        .getWorkspaceIndex()
        .findExact(objectName)
        .filter((match) => relatedUris.has(match.uri));

      const functionMatch = functionMatches.find((match) => match.symbol.kind === 'function');

      if (functionMatch && functionMatch.symbol.returnType) {
        typeName = functionMatch.symbol.returnType;
      }
    }

    /*
     * ============================================================
     * 3. 型が見つからなければ終了
     * ============================================================
     */
    if (!typeName) {
      const propertyType = this.findPropertyType(uri, objectName);

      if (propertyType) {
        typeName = propertyType;
      }
    }

    if (!typeName) {
      return [];
    }

    /*
     * ============================================================
     * 4. HLSL 組み込み vector 型
     * ============================================================
     *
     * float2 / float3 / float4
     * half2  / half3  / half4
     * double2 / double3 / double4
     *
     * 例:
     *
     * float4 color;
     * color.
     *
     * → x
     * → y
     * → z
     * → w
     */
    /*
     * Swizzle:
     *
     *     color.xy.
     *     color.xyz.
     *
     * のようなケースでは、
     * swizzle 結果の型を推論する。
     */
    const builtinMembers = this.getBuiltinTypeMembers(typeName);

    if (builtinMembers) {
      const items: CompletionItem[] = [];

      for (const member of builtinMembers) {
        if (prefix.length > 0 && !member.toLowerCase().startsWith(prefix.toLowerCase())) {
          continue;
        }

        items.push({
          label: member,
          kind: CompletionItemKind.Field,
          detail: `${this.completionSource} • ` + `HLSL built-in type member`,
        });
      }

      return items;
    }

    /*
     * ============================================================
     * 5. 型名から struct / cbuffer を探す
     * ============================================================
     */
    const relatedUris = this.documentManager.getRelatedIncludeUris(uri);

    const typeMatches = index.findExact(typeName).filter((match) => relatedUris.has(match.uri));

    const items: CompletionItem[] = [];

    const seen = new Set<string>();

    for (const match of typeMatches) {
      const symbol = match.symbol;

      if (symbol.kind !== 'struct' && symbol.kind !== 'cbuffer') {
        continue;
      }

      /*
       * struct / cbuffer の children が
       * field になっている。
       */
      for (const field of symbol.children) {
        if (field.kind !== 'field') {
          continue;
        }

        /*
         * prefix がある場合は
         * field 名でフィルタする。
         *
         * 例:
         *
         * output.po
         *
         * → positionCS
         */
        if (prefix.length > 0 && !field.name.toLowerCase().startsWith(prefix.toLowerCase())) {
          continue;
        }

        if (seen.has(field.name)) {
          continue;
        }

        seen.add(field.name);

        items.push({
          label: field.name,

          kind: CompletionItemKind.Field,

          detail: field.typeName
            ? `${this.completionSource} • ` + `field: ${field.typeName}`
            : `${this.completionSource} • ` + `HLSL field`,
        });
      }
    }

    return items;
  }

  private findLocalVariableCompletions(uri: string, prefix: string, offset: number): CompletionItem[] {
    const document = this.documentManager.get(uri);

    if (!document) {
      return [];
    }

    const text = document.getText();

    const sourceBeforeCursor = text.substring(0, Math.max(0, Math.min(offset, text.length)));

    const maskedSource = this.maskComments(sourceBeforeCursor);

    const result: CompletionItem[] = [];

    const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|=|\[|,)/g;

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(maskedSource)) !== null) {
      const typeName = match[1];

      const variableName = match[2];

      if (!variableName.startsWith(prefix)) {
        continue;
      }

      result.push({
        label: variableName,
        kind: CompletionItemKind.Variable,
        detail: `${typeName} ${variableName}`,
        documentation: this.completionSource,
      });
    }

    return result;
  }

  private findLocalVariableDeclaration(
    uri: string,
    variableName: string,
    offset: number,
  ): {
    name: string;
    typeName: string;
    range: {
      start: {
        line: number;
        character: number;
        offset: number;
      };
      end: {
        line: number;
        character: number;
        offset: number;
      };
    };
  } | null {
    const document = this.documentManager.get(uri);

    if (!document) {
      return null;
    }

    const source = document.getText();

    const safeOffset = Math.max(0, Math.min(offset, source.length));

    /*
     * カーソルより前だけを検索する。
     */
    const beforeCursor = source.substring(0, safeOffset);

    /*
     * コメントを除去する。
     *
     * 改行・文字数は維持する。
     */
    const cleanSource = this.maskComments(beforeCursor);

    const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /*
     * 例:
     *
     * A a;
     * B b;
     * Varyings output;
     * Varyings output = ...;
     * float3 position;
     */
    const pattern = new RegExp(
      `\\b` +
        `(?:(?:const|static|uniform|volatile|inline)\\s+)*` +
        `([A-Za-z_][A-Za-z0-9_]*)\\s+` +
        `${escapedName}\\s*` +
        `(?:;|=|\\[|,)`,
      'g',
    );

    let lastMatch: RegExpExecArray | null = null;

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(cleanSource)) !== null) {
      lastMatch = match;
    }

    if (!lastMatch) {
      return null;
    }

    const typeName = lastMatch[1];

    const declarationStart = lastMatch.index;

    const declarationEnd = declarationStart + lastMatch[0].length;

    const startPosition = document.positionAt(declarationStart);

    const endPosition = document.positionAt(declarationEnd);

    const range = {
      start: {
        line: startPosition.line,
        character: startPosition.character,
        offset: declarationStart,
      },

      end: {
        line: endPosition.line,
        character: endPosition.character,
        offset: declarationEnd,
      },
    };

    return {
      name: variableName,
      typeName,
      range,
    };
  }

  private maskComments(source: string): string {
    let result = '';
    let i = 0;

    let inBlockComment = false;
    let inLineComment = false;

    while (i < source.length) {
      const current = source[i];

      const next = i + 1 < source.length ? source[i + 1] : '';

      /*
       * // コメント
       */
      if (!inBlockComment && !inLineComment && current === '/' && next === '/') {
        result += ' ';
        result += ' ';
        i += 2;
        inLineComment = true;
        continue;
      }

      /*
       * /* コメント開始
       */
      if (!inLineComment && !inBlockComment && current === '/' && next === '*') {
        result += ' ';
        result += ' ';
        i += 2;
        inBlockComment = true;
        continue;
      }

      /*
       * 行コメント終了
       */
      if (inLineComment && current === '\n') {
        result += '\n';
        i++;
        inLineComment = false;
        continue;
      }

      /*
       * ブロックコメント終了
       */
      if (inBlockComment && current === '*' && next === '/') {
        result += ' ';
        result += ' ';
        i += 2;
        inBlockComment = false;
        continue;
      }

      /*
       * コメント内部は空白にする。
       * 改行だけは維持する。
       */
      if (inLineComment || inBlockComment) {
        result += current === '\n' ? '\n' : ' ';

        i++;
        continue;
      }

      result += current;
      i++;
    }

    return result;
  }

  private isInsideComment(text: string, offset: number): boolean {
    const safeOffset = Math.max(0, Math.min(offset, text.length));

    let inBlockComment = false;

    for (let i = 0; i < safeOffset; i++) {
      const current = text[i];

      const next = i + 1 < safeOffset ? text[i + 1] : '';

      /*
       * Block comment:
       *
       * /*
       *    ...
       * *\/
       */
      if (!inBlockComment && current === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }

      if (inBlockComment && current === '*' && next === '/') {
        inBlockComment = false;
        i++;
        continue;
      }

      /*
       * Line comment:
       *
       * // ...
       *
       * 改行までコメント。
       */
      if (!inBlockComment && current === '/' && next === '/') {
        const lineEnd = text.indexOf('\n', i + 2);

        if (lineEnd === -1 || safeOffset <= lineEnd) {
          return true;
        }

        i = lineEnd - 1;
      }
    }

    return inBlockComment;
  }

  private isInsideString(text: string, offset: number): boolean {
    let inString = false;
    let quote = '';

    let escaped = false;

    for (let index = 0; index < offset; index++) {
      const char = text[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (!inString) {
        if (char === '"' || char === "'") {
          inString = true;
          quote = char;
        }

        continue;
      }

      if (char === quote) {
        inString = false;
        quote = '';
      }
    }

    return inString;
  }

  private getMemberAccessAtPosition(
    text: string,
    offset: number,
  ): {
    objectName: string;
    prefix: string;
  } | null {
    const beforeCursor = text.substring(0, Math.max(0, Math.min(offset, text.length)));

    /*
     * ---------------------------------------------------------
     * Function call:
     *
     *     GetColor().
     *     GetColor(uv).
     *     GetColor(GetUV()).
     *     GetColor(GetUV(uv)).
     *     GetColor(a, GetUV()).
     *
     * ---------------------------------------------------------
     */

    const functionMemberMatch = beforeCursor.match(/\.([A-Za-z0-9_]*)$/);

    if (functionMemberMatch) {
      const prefix = functionMemberMatch[1];

      const dotIndex = beforeCursor.length - prefix.length - 1;

      let closeParenIndex = dotIndex - 1;

      while (closeParenIndex >= 0 && /\s/.test(beforeCursor[closeParenIndex])) {
        closeParenIndex--;
      }

      if (closeParenIndex >= 0 && beforeCursor[closeParenIndex] === ')') {
        const openParenIndex = this.findMatchingOpenParen(beforeCursor, closeParenIndex);

        if (openParenIndex >= 0) {
          const functionPrefix = beforeCursor.substring(0, openParenIndex);

          const functionMatch = functionPrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);

          if (functionMatch) {
            return {
              objectName: functionMatch[1],
              prefix,
            };
          }
        }
      }
    }

    /*
     * ---------------------------------------------------------
     * Variable / array:
     *
     *     output.
     *     color[1].
     *     color[1].xy
     *     color[1][2].
     *
     * ---------------------------------------------------------
     */

    const variableMatch = beforeCursor.match(
      /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*[^\]]+\s*\])*\s*\.\s*([A-Za-z0-9_]*)$/,
    );

    if (!variableMatch) {
      return null;
    }

    return {
      objectName: variableMatch[1],
      prefix: variableMatch[2],
    };
  }

  private findMatchingOpenParen(text: string, closeParenIndex: number): number {
    let depth = 0;

    let inString = false;
    let quote = '';
    let escaped = false;

    for (let index = closeParenIndex; index >= 0; index--) {
      const char = text[index];

      /*
       * 文字列中の括弧は無視する。
       */
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\') {
          escaped = true;
          continue;
        }

        if (char === quote) {
          inString = false;
          quote = '';
        }

        continue;
      }

      /*
       * 逆方向に読むので、
       * quote の開始位置を見つけたら
       * 文字列中として扱う。
       */
      if (char === '"' || char === "'") {
        inString = true;
        quote = char;
        continue;
      }

      if (char === ')') {
        depth++;
        continue;
      }

      if (char === '(') {
        depth--;

        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  private getCompletionSortText(symbol: ShaderSymbol): string {
    switch (symbol.kind) {
      case 'variable':
        return `1_${symbol.name}`;

      case 'parameter':
        return `1_${symbol.name}`;

      case 'field':
        return `2_${symbol.name}`;

      case 'property':
        return `2_${symbol.name}`;

      case 'cbuffer':
        return `3_${symbol.name}`;

      case 'struct':
        return `3_${symbol.name}`;

      case 'function':
        return `3_${symbol.name}`;

      case 'macro':
        return `3_${symbol.name}`;

      case 'include':
        return `4_${symbol.name}`;

      default:
        return `5_${symbol.name}`;
    }
  }

  private getSymbolDocumentation(symbol: ShaderSymbol): string {
    const lines: string[] = [];

    switch (symbol.kind) {
      case 'function':
        lines.push(`**Function**`);

        lines.push(`\`${symbol.name}\``);

        if (symbol.returnType) {
          lines.push(`Return type: \`${symbol.returnType}\``);
        }

        break;

      case 'struct':
        lines.push(`**Struct**`);

        lines.push(`\`${symbol.name}\``);

        break;

      case 'field':
        lines.push(`**Field**`);

        lines.push(`\`${symbol.name}\``);

        if (symbol.typeName) {
          lines.push(`Type: \`${symbol.typeName}\``);
        }

        if (symbol.parentName) {
          lines.push(`Parent: \`${symbol.parentName}\``);
        }

        if (symbol.semantic) {
          lines.push(`Semantic: \`${symbol.semantic}\``);
        }

        break;

      case 'parameter':
        lines.push(`**Parameter**`);

        lines.push(`\`${symbol.name}\``);

        if (symbol.typeName) {
          lines.push(`Type: \`${symbol.typeName}\``);
        }

        break;

      case 'variable':
        lines.push(`**Variable**`);

        lines.push(`\`${symbol.name}\``);

        if (symbol.typeName) {
          lines.push(`Type: \`${symbol.typeName}\``);
        }

        break;

      case 'cbuffer':
        lines.push(`**Constant Buffer**`);

        lines.push(`\`${symbol.name}\``);

        break;

      case 'property':
        lines.push(`**Shader Property**`);

        lines.push(`\`${symbol.name}\``);

        if (symbol.typeName) {
          lines.push(`Type: \`${symbol.typeName}\``);
        }

        break;

      case 'macro':
        lines.push(`**Macro**`);

        lines.push(`\`${symbol.name}\``);

        break;

      case 'include':
        lines.push(`**Include**`);

        lines.push(`\`${symbol.name}\``);

        break;

      default:
        lines.push(`**${symbol.kind}**`);

        lines.push(`\`${symbol.name}\``);

        break;
    }

    return lines.join('\n\n');
  }

  private getWordBeforeCursor(text: string, offset: number): string {
    let start = Math.max(0, Math.min(offset, text.length));

    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
      start--;
    }

    return text.substring(start, offset);
  }

  private isInsideHlslContext(text: string, offset: number): boolean {
    const beforeCursor = text.substring(0, Math.max(0, Math.min(offset, text.length)));

    const hlslStart = beforeCursor.lastIndexOf('HLSLPROGRAM');

    const hlslEnd = beforeCursor.lastIndexOf('ENDHLSL');

    const cgStart = beforeCursor.lastIndexOf('CGPROGRAM');

    const cgEnd = beforeCursor.lastIndexOf('ENDCG');

    const hlslIncludeStart = beforeCursor.lastIndexOf('HLSLINCLUDE');

    const hlslIncludeEnd = beforeCursor.lastIndexOf('ENDHLSL');

    const insideHlslProgram = hlslStart > hlslEnd;

    const insideCgProgram = cgStart > cgEnd;

    const insideHlslInclude = hlslIncludeStart > hlslIncludeEnd;

    return insideHlslProgram || insideCgProgram || insideHlslInclude;
  }

  private getBuiltinTypes(): string[] {
    return [
      'bool',
      'bool1',
      'bool2',
      'bool3',
      'bool4',

      'int',
      'int1',
      'int2',
      'int3',
      'int4',

      'uint',
      'uint1',
      'uint2',
      'uint3',
      'uint4',

      'half',
      'half1',
      'half2',
      'half3',
      'half4',

      'float',
      'float1',
      'float2',
      'float3',
      'float4',

      'double',
      'double1',
      'double2',
      'double3',
      'double4',

      'min16float',
      'min16float2',
      'min16float3',
      'min16float4',

      'min10float',
      'min10float2',
      'min10float3',
      'min10float4',

      'float2x2',
      'float2x3',
      'float2x4',
      'float3x2',
      'float3x3',
      'float3x4',
      'float4x2',
      'float4x3',
      'float4x4',
    ];
  }
  private getBuiltinTypeMembers(typeName: string): string[] | null {
    const normalizedType = typeName.toLowerCase();

    /*
     * ============================================================
     * HLSL numeric base types
     * ============================================================
     */

    const baseTypes = [
      'float',
      'half',
      'double',
      'int',
      'uint',
      'bool',

      'min10float',
      'min16float',

      'min12int',
      'min16int',

      'min16uint',
    ];

    /*
     * ============================================================
     * Matrix
     *
     * float4x4
     * float3x4
     * int2x3
     * min16float4x4
     * ...
     * ============================================================
     */

    for (const baseType of baseTypes) {
      const matrixPattern = new RegExp(`^${baseType}([1-4])x([1-4])$`);

      const matrixMatch = normalizedType.match(matrixPattern);

      if (!matrixMatch) {
        continue;
      }

      const rows = Number(matrixMatch[1]);

      const columns = Number(matrixMatch[2]);

      return this.generateMatrixMembers(rows, columns);
    }

    /*
     * ============================================================
     * Vector
     *
     * float2
     * float3
     * float4
     * int2
     * uint4
     * min16float3
     * ...
     * ============================================================
     */

    for (const baseType of baseTypes) {
      const vectorPattern = new RegExp(`^${baseType}([1-4])$`);

      const vectorMatch = normalizedType.match(vectorPattern);

      if (!vectorMatch) {
        continue;
      }

      const dimension = Number(vectorMatch[1]);

      return this.generateVectorMembers(dimension);
    }

    return null;
  }
  private generateVectorMembers(dimension: number): string[] {
    const components = ['x', 'y', 'z', 'w'].slice(0, dimension);

    const colorComponents = ['r', 'g', 'b', 'a'].slice(0, dimension);

    const result = new Set<string>();

    const generate = (source: string[], length: number, current: string): void => {
      if (current.length === length) {
        result.add(current);
        return;
      }

      for (const component of source) {
        generate(source, length, current + component);
      }
    };

    /*
     * x / y / z / w
     */
    for (let length = 1; length <= 4; length++) {
      generate(components, length, '');
    }

    /*
     * r / g / b / a
     */
    for (let length = 1; length <= 4; length++) {
      generate(colorComponents, length, '');
    }

    return Array.from(result);
  }
  private generateMatrixMembers(rows: number, columns: number): string[] {
    const result: string[] = [];

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        result.push(`_m${row}${column}`);
      }
    }

    return result;
  }
  private findPropertyType(uri: string, propertyName: string): string | undefined {
    const parsed = this.documentManager.getParsed(uri);

    if (!parsed) {
      return undefined;
    }

    const ast = parsed.ast;

    if (ast.kind !== 'ShaderDocument') {
      return undefined;
    }

    const property = ast.properties.find((value) => value.name === propertyName);

    if (!property) {
      return undefined;
    }

    const propertyType = property.propertyType;

    if (!propertyType) {
      return undefined;
    }

    switch (propertyType.toLowerCase()) {
      case 'color':
      case 'vector':
        return 'float4';

      case 'float':
      case 'range':
        return 'float';

      case 'int':
        return 'int';

      case '2d':
      case '2darray':
      case '3d':
      case 'cube':
        return undefined;

      default:
        return undefined;
    }
  }
  private getBuiltinSemantics(): string[] {
    return [
      'POSITION',
      'NORMAL',
      'TANGENT',
      'COLOR',

      'TEXCOORD0',
      'TEXCOORD1',
      'TEXCOORD2',
      'TEXCOORD3',
      'TEXCOORD4',
      'TEXCOORD5',
      'TEXCOORD6',
      'TEXCOORD7',

      'SV_POSITION',

      'SV_TARGET',
      'SV_Target0',
      'SV_Target1',
      'SV_Target2',
      'SV_Target3',
      'SV_Target4',
      'SV_Target5',
      'SV_Target6',
      'SV_Target7',

      'SV_DEPTH',
      'SV_VERTEXID',
      'SV_INSTANCEID',
      'SV_PRIMITIVEID',
      'SV_ISFRONTFACE',
      'SV_SAMPLEINDEX',
    ];
  }
  private getIncludeCompletionContext(
    text: string,
    offset: number,
  ): {
    path: string;
    prefix: string;
  } | null {
    const beforeCursor = text.substring(0, offset);

    /*
     * 現在行だけを見る。
     */
    const lineStart = beforeCursor.lastIndexOf('\n') + 1;
    const line = beforeCursor.substring(lineStart);

    /*
     * #include "..."
     *
     * まだ閉じる " がない状態だけを対象にする。
     */
    const match = line.match(/^\s*#\s*include\s*(?:"([^"]*)|<([^>]*)?)$/);

    if (!match) {
      return null;
    }

    const includePath = match[1] ?? match[2] ?? '';

    /*
     * 最後の / より後ろを prefix とする。
     *
     * 例:
     *
     * Packages/com.unity.render-pipelines.universal/ShaderLibrary/Co
     *
     * path:
     * Packages/com.unity.render-pipelines.universal/ShaderLibrary/
     *
     * prefix:
     * Co
     */
    const slashIndex = Math.max(includePath.lastIndexOf('/'), includePath.lastIndexOf('\\'));

    if (slashIndex < 0) {
      return {
        path: '',
        prefix: includePath,
      };
    }

    return {
      path: includePath.substring(0, slashIndex + 1),
      prefix: includePath.substring(slashIndex + 1),
    };
  }
  private provideIncludeCompletion(
    uri: string,
    context: { path: string; prefix: string },
    offset: number,
  ): CompletionItem[] {
    const includePath = `${context.path}${context.prefix}`;

    const candidates = this.includeResolver.getCompletionCandidates(includePath, uri);

    const document = this.documentManager.get(uri);

    if (!document) {
      return [];
    }

    const includeStartOffset = offset - includePath.length;

    const startPosition = document.positionAt(includeStartOffset);

    const endPosition = document.positionAt(offset);

    const result: CompletionItem[] = [];

    for (const candidate of candidates) {
      result.push({
        label: candidate.includePath,
        filterText: context.prefix,
        kind: CompletionItemKind.File,
        detail: 'include',

        textEdit: {
          range: {
            start: startPosition,
            end: endPosition,
          },
          newText: candidate.includePath,
        },

        sortText: candidate.includePath,
      });
    }

    return result;
  }
}
