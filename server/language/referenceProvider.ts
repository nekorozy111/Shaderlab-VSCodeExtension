import { Location, Position } from 'vscode-languageserver/node';
import { DocumentManager } from './documentManager';
import { DefinitionProvider } from './definitionProvider';
import { Tokenizer } from '../parser/tokenizer';

export class ReferenceProvider {
  public constructor(
    private readonly documentManager: DocumentManager,
    private readonly definitionProvider: DefinitionProvider,
  ) {}

  public async provideReferences(uri: string, position: Position, includeDeclaration: boolean): Promise<Location[]> {
    const document = this.documentManager.get(uri);
    if (!document) {
      return [];
    }

    const word = this.getWordAtPosition(document.getText(), document.offsetAt(position));
    if (!word) {
      return [];
    }

    const target = await this.definitionProvider.provideDefinition(uri, position);
    if (!target) {
      return [];
    }

    // 検索対象が構造体メンバの場合、定義元のシンボル情報を保持して型で絞り込む。
    const targetField = this.documentManager
      .getWorkspaceIndex()
      .findExact(word)
      .find(
        (match) =>
          match.symbol.kind === 'field' &&
          match.uri === target.uri &&
          this.rangesOverlap(match.symbol.location.range, target.range),
      )?.symbol;

    // 参照検索の範囲はInclude Rootsツリーで選択されたrootの解析スコープに統一する。
    // DocumentManagerは選択rootがある場合、getRelatedIncludeUris(uri)をそのrootの
    // 再帰的なincludeグラフへ解決するため、兄弟includeも検索対象に含まれる。
    await this.documentManager.prepareRelatedIncludeUris(uri);
    const relatedUris = new Set<string>(this.documentManager.getRelatedIncludeUris(uri));
    relatedUris.add(uri);
    const results: Location[] = [];
    const seen = new Set<string>();

    // Treeに含まれるファイルをすべてロードし、最新の解析内容を参照検索で利用する。
    await Promise.all(
      Array.from(relatedUris, async (relatedUri) => {
        await this.documentManager.ensureExternalDocument(relatedUri);
        await this.documentManager.prepareRelatedIncludeUris(relatedUri);
      }),
    );

    // 同じTree rootから到達できるファイルは同一の検索スコープとして扱う。
    const sharedRootScope = new Set(relatedUris);

    const targetFunction = this.documentManager
      .getWorkspaceIndex()
      .findExact(word)
      .some(
        (match) =>
          match.symbol.kind === 'function' &&
          match.uri === target.uri &&
          match.symbol.location.selectionRange.start.line === target.range.start.line &&
          match.symbol.location.selectionRange.start.character === target.range.start.character,
      );

    for (const relatedUri of relatedUris) {
      const source = this.documentManager.getSourceText(relatedUri);
      if (source === undefined) {
        continue;
      }

      const tokens = new Tokenizer(source).tokenize();
      for (const token of tokens) {
        if (token.kind !== 'identifier' || token.value !== word) {
          continue;
        }

        const tokenDocument = this.documentManager.get(relatedUri);
        if (!tokenDocument) {
          continue;
        }

        const tokenPosition = tokenDocument.positionAt(token.range.start.offset);
        const definition = await this.definitionProvider.provideDefinition(relatedUri, tokenPosition);
        let refersToTarget = !!definition && this.sameLocation(definition, target);

        if (targetField) {
          // メンバ参照は、宣言自身か「変数.メンバ」の形で親構造体型が一致する場合だけ許可する。
          // DefinitionProviderが同名メンバを誤って解決しても、この型チェックで除外する。
          const isTargetDeclaration =
            relatedUri === target.uri &&
            this.rangeContainsOffset(targetField.location.range, token.range.start.offset) &&
            this.rangeContainsOffset(targetField.location.range, token.range.end.offset);

          // フィールドは同名やDefinitionProviderの誤解決だけでは一致とみなさず、
          // 宣言そのもの、またはアクセス元の型が対象フィールドの親構造体と一致する場合だけ採用する。
          refersToTarget =
            isTargetDeclaration || this.memberAccessHasOwnerType(tokens, token, targetField, target.uri, relatedUri);
        }

        // 定義Providerはファイル単体では兄弟includeのシンボルを解決できない場合がある。
        // 関数呼び出しに限り、同じrootの翻訳単位に定義と使用箇所が含まれる場合を補完する。
        if (!refersToTarget && targetFunction && this.isFunctionCallAt(source, token.range.end.offset)) {
          refersToTarget = sharedRootScope.has(relatedUri) && sharedRootScope.has(target.uri);
        }

        if (!refersToTarget) {
          continue;
        }

        const isDeclaration =
          !!definition &&
          this.sameLocation(definition, {
            uri: relatedUri,
            range: {
              start: {
                line: token.range.start.line,
                character: token.range.start.character,
              },
              end: {
                line: token.range.end.line,
                character: token.range.end.character,
              },
            },
          });

        if (isDeclaration && !includeDeclaration) {
          continue;
        }

        const location: Location = {
          uri: relatedUri,
          range: {
            start: {
              line: token.range.start.line,
              character: token.range.start.character,
            },
            end: {
              line: token.range.end.line,
              character: token.range.end.character,
            },
          },
        };
        const key = this.locationKey(location);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push(location);
      }
    }

    // プロジェクト全体は上の共通経路で解析する。
    // 呼び出し形式だけを見て追加すると、同名の別関数や別スコープを誤検出するため、
    // 定義先が一致した候補だけを参照として採用する。

    return results;
  }

  private memberAccessHasOwnerType(
    tokens: ReturnType<Tokenizer['tokenize']>,
    memberToken: ReturnType<Tokenizer['tokenize']>[number],
    targetField: import('../symbol/symbol').ShaderSymbol,
    targetFieldUri: string,
    currentUri: string,
  ): boolean {
    const parentTypeName = targetField.parentName;
    if (!parentTypeName || targetField.kind !== 'field') {
      return false;
    }

    const memberIndex = tokens.findIndex(
      (candidate) =>
        candidate.range.start.offset === memberToken.range.start.offset &&
        candidate.range.end.offset === memberToken.range.end.offset,
    );
    if (memberIndex < 2 || tokens[memberIndex - 1]?.value !== '.') {
      return false;
    }

    const objectToken = tokens[memberIndex - 2];
    if (objectToken.kind !== 'identifier') {
      return false;
    }

    const index = this.documentManager.getWorkspaceIndex();
    const relatedUris = new Set(this.documentManager.getRelatedIncludeUris(currentUri));
    relatedUris.add(currentUri);

    // 対象メンバの宣言元から、実際にそのメンバを含む構造体宣言を特定する。
    // 検索中のファイルではなく対象フィールドのURIを使い、兄弟include間でも型を比較する。
    const targetStructs = index
      .findExact(parentTypeName)
      .filter(
        (match) =>
          match.symbol.kind === 'struct' &&
          match.uri === targetFieldUri &&
          match.symbol.children.some(
            (field) =>
              field.kind === 'field' &&
              field.name === targetField.name &&
              field.location.selectionRange.start.line === targetField.location.selectionRange.start.line &&
              field.location.selectionRange.start.character === targetField.location.selectionRange.start.character,
          ),
      );

    // アクセス元の変数・引数は、現在のファイルで宣言され、使用位置より前にあるものに限定する。
    const objectMatches = index
      .findExact(objectToken.value)
      .filter(
        (match) =>
          match.uri === currentUri &&
          (match.symbol.kind === 'variable' || match.symbol.kind === 'parameter') &&
          match.symbol.typeName === parentTypeName,
      )
      .sort((a, b) => {
        // ASTのoffsetはShaderLab内の埋め込みHLSLでは元文書のoffsetと
        // 基準が異なる場合があるため、同じ基準である保証のないoffsetで
        // 宣言順を決めず、行・列を優先して比較する。
        const aPos = a.symbol.location.selectionRange.start;
        const bPos = b.symbol.location.selectionRange.start;
        if (aPos.line !== bPos.line) return bPos.line - aPos.line;
        return bPos.character - aPos.character;
      });

    if (targetStructs.length === 0) {
      return false;
    }

    // 通常はシンボルIndexの型情報を利用する。ShaderLab内の埋め込みHLSLでは
    // 宣言offsetの基準がずれてローカル変数がIndex照合から漏れることがあるため、
    // ソース上の宣言も確認して補完する。
    const sourcePrefix = this.documentManager.getSourceText(currentUri)?.slice(0, objectToken.range.start.offset) ?? '';
    const escapedName = objectToken.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declarationPattern = new RegExp(String.raw`\b([A-Za-z_]\w*)\s+${escapedName}\s*(?=;|=|,|\)|\[|:)`, 'g');
    let inferredType: string | undefined;
    let declarationMatch: RegExpExecArray | null;
    while ((declarationMatch = declarationPattern.exec(sourcePrefix)) !== null) {
      inferredType = declarationMatch[1];
    }
    const objectTypeName = objectMatches[0]?.symbol.typeName ?? inferredType;
    if (objectTypeName !== parentTypeName) {
      return false;
    }

    // 同名構造体が複数ある場合は、候補ファイル内で一意に解決できる場合だけ
    // 型名による補完を許可し、別ファイルの同名構造体を誤って混ぜない。
    const objectTypeStructs = index
      .findExact(objectTypeName)
      .filter(
        (match) =>
          match.symbol.kind === 'struct' &&
          relatedUris.has(match.uri) &&
          match.symbol.children.some((field) => field.kind === 'field' && field.name === targetField.name),
      );

    const matchingTargets = objectTypeStructs.filter((candidate) =>
      targetStructs.some(
        (target) =>
          candidate.uri === target.uri &&
          candidate.symbol.location.selectionRange.start.line === target.symbol.location.selectionRange.start.line &&
          candidate.symbol.location.selectionRange.start.character ===
            target.symbol.location.selectionRange.start.character,
      ),
    );

    return matchingTargets.length > 0 && (objectTypeStructs.length === 1 || objectMatches.length > 0);
  }

  private isFunctionCallAt(source: string, endOffset: number): boolean {
    let offset = endOffset;
    while (offset < source.length && /\\s/.test(source[offset])) {
      offset++;
    }
    return source[offset] === '(';
  }

  private getWordAtPosition(text: string, offset: number): string | null {
    if (text.length === 0) {
      return null;
    }

    const safeOffset = Math.max(0, Math.min(offset, text.length));
    const isIdentifierCharacter = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

    let start = safeOffset;
    let end = safeOffset;
    while (start > 0 && isIdentifierCharacter(text[start - 1])) {
      start--;
    }
    while (end < text.length && isIdentifierCharacter(text[end])) {
      end++;
    }

    return start === end ? null : text.substring(start, end);
  }

  private rangesOverlap(
    left: { start: { line: number; character: number }; end: { line: number; character: number } },
    right: { start: { line: number; character: number }; end: { line: number; character: number } },
  ): boolean {
    const compare = (a: { line: number; character: number }, b: { line: number; character: number }): number =>
      a.line === b.line ? a.character - b.character : a.line - b.line;
    return compare(left.start, right.end) <= 0 && compare(right.start, left.end) <= 0;
  }

  private rangeContainsOffset(range: { start: { offset: number }; end: { offset: number } }, offset: number): boolean {
    return range.start.offset <= offset && offset <= range.end.offset;
  }

  private sameLocation(left: Location, right: Location): boolean {
    return (
      left.uri === right.uri &&
      left.range.start.line === right.range.start.line &&
      left.range.start.character === right.range.start.character &&
      left.range.end.line === right.range.end.line &&
      left.range.end.character === right.range.end.character
    );
  }

  private locationKey(location: Location): string {
    return [
      location.uri,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
    ].join(':');
  }
}
