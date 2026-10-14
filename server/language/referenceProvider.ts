import { Location, Position } from 'vscode-languageserver/node';
import { fileURLToPath } from 'url';
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

    const relatedUris = this.documentManager.getRelatedIncludeUris(uri);
    const results: Location[] = [];
    const seen = new Set<string>();

    // include先のファイル自身からさらにincludeしている場合も正しく解決できるよう、
    // 各候補ファイルのinclude graphを先に構築する。
    await Promise.all(
      Array.from(relatedUris, (relatedUri) => this.documentManager.prepareRelatedIncludeUris(relatedUri)),
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
        if (!definition || !this.sameLocation(definition, target)) {
          continue;
        }

        const isDeclaration = this.sameLocation(definition, {
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

    // include graph外のファイルもプロジェクト全体から検索する。
    // 関数呼び出し形式のトークンだけを追加し、構造体メンバの同名誤検出を避ける。
    if (this.isFunctionLikeTarget(target, word)) {
      const projectUris = await this.documentManager.getProjectService().listProjectSourceUris();
      const relatedKeys = new Set(Array.from(relatedUris, (relatedUri) => this.uriKey(relatedUri)));
      for (const projectUri of projectUris) {
        if (relatedKeys.has(this.uriKey(projectUri))) {
          continue;
        }

        let filePath: string;
        try {
          filePath = fileURLToPath(projectUri);
        } catch {
          continue;
        }
        const source = this.documentManager.getSourceText(projectUri)
          ?? await this.documentManager.getProjectService().readFileAsync(filePath);
        if (source === undefined) {
          continue;
        }

        const tokens = new Tokenizer(source).tokenize();
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index];
          if (token.kind !== 'identifier' || token.value !== word) {
            continue;
          }
          // 識別子の次が開き括弧の場合だけ関数参照候補として扱う。
          if (tokens[index + 1]?.value !== '(') {
            continue;
          }
          if (!includeDeclaration && this.isLikelyFunctionDeclaration(tokens, index)) {
            continue;
          }
          const location: Location = {
            uri: projectUri,
            range: {
              start: { line: token.range.start.line, character: token.range.start.character },
              end: { line: token.range.end.line, character: token.range.end.character },
            },
          };
          const key = this.locationKey(location);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(location);
          }
        }
      }
    }

    return results;
  }

  private isFunctionLikeTarget(target: Location, word: string): boolean {
    const source = this.documentManager.getSourceText(target.uri);
    if (source === undefined) {
      return false;
    }
    const lines = source.split(/\r?\n/);
    const line = lines[target.range.start.line] ?? '';
    const start = target.range.start.character;
    const end = target.range.end.character;
    return line.slice(start, end) === word && /^\s*\(/.test(line.slice(end));
  }

  private isLikelyFunctionDeclaration(tokens: ReturnType<Tokenizer['tokenize']>, index: number): boolean {
    // 関数宣言は名前の直前に戻り値型があり、引数リストの直後が本体または宣言終端になる。
    const previous = tokens[index - 1];
    if (!previous || previous.kind !== 'identifier') {
      return false;
    }
    let depth = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor].value === '(') depth++;
      else if (tokens[cursor].value === ')') {
        depth--;
        if (depth === 0) {
          const next = tokens[cursor + 1]?.value;
          return next === '{' || next === ';';
        }
      }
    }
    return false;
  }

  private uriKey(uri: string): string {
    return process.platform === 'win32' ? uri.toLowerCase() : uri;
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
