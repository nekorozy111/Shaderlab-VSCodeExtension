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

    return results;
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
