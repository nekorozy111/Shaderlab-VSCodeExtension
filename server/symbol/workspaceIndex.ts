import { ParsedDocument } from '../parser/ast';
import { ShaderSymbol, SymbolKind } from './symbol';
import { SymbolExtractor } from './symbolExtractor';

export interface SymbolMatch {
  symbol: ShaderSymbol;

  uri: string;
}

export class WorkspaceIndex {
  private readonly documents = new Map<string, ParsedDocument>();

  private readonly symbols = new Map<string, ShaderSymbol[]>();

  /**
   * 正規化したシンボル名 -> 定義一覧。
   * F12 の完全一致検索で全ドキュメント/全ASTを走査しないための index。
   */
  private readonly symbolsByName = new Map<string, SymbolMatch[]>();

  private readonly prefixCache = new Map<string, SymbolMatch[]>();

  private readonly symbolExtractor = new SymbolExtractor();

  public update(document: ParsedDocument): void {
    // 同じ URI の古い symbol を先に除去する。
    this.remove(document.uri);
    this.prefixCache.clear();

    this.documents.set(document.uri, document);

    const extracted = this.symbolExtractor.extract(document);

    this.symbols.set(document.uri, extracted);
    this.addToNameIndex(document.uri, extracted);
  }

  public remove(uri: string): void {
    this.documents.delete(uri);

    const existingSymbols = this.symbols.get(uri);

    if (existingSymbols) {
      this.removeFromNameIndex(uri, existingSymbols);
    }

    this.symbols.delete(uri);
    this.prefixCache.clear();
  }

  public clear(): void {
    this.documents.clear();
    this.symbols.clear();
    this.symbolsByName.clear();
    this.prefixCache.clear();
  }

  public getDocument(uri: string): ParsedDocument | undefined {
    return this.documents.get(uri);
  }

  public getDocumentSymbols(uri: string): ShaderSymbol[] {
    return this.symbols.get(uri) ?? [];
  }

  public find(name: string): SymbolMatch[] {
    const normalized = name.toLowerCase();

    const results: SymbolMatch[] = [];

    for (const [uri, symbols] of this.symbols) {
      this.collectMatchingSymbols(uri, symbols, normalized, results);
    }

    return results;
  }

  public findExact(name: string): SymbolMatch[] {
    const normalized = name.toLowerCase();

    return [...(this.symbolsByName.get(normalized) ?? [])];
  }

  public findByKind(name: string, kind: SymbolKind): SymbolMatch[] {
    return this.findExact(name).filter((match) => match.symbol.kind === kind);
  }

  public getAllSymbols(): SymbolMatch[] {
    const results: SymbolMatch[] = [];

    for (const [uri, symbols] of this.symbols) {
      this.collectAllSymbols(uri, symbols, results);
    }

    return results;
  }

  public getSymbolCount(): number {
    let count = 0;

    for (const symbols of this.symbols.values()) {
      count += this.countSymbols(symbols);
    }

    return count;
  }

  public getDocumentCount(): number {
    return this.documents.size;
  }

  public getDocumentUris(): string[] {
    return Array.from(this.documents.keys());
  }

  public findPrefix(prefix: string): SymbolMatch[] {
    const normalized = prefix.toLowerCase();
    const cached = this.prefixCache.get(normalized);
    if (cached) {
      return [...cached];
    }

    const results: SymbolMatch[] = [];

    // ASTを再帰走査する代わりに、名前Indexだけを走査する。
    for (const [name, matches] of this.symbolsByName) {
      if (!name.startsWith(normalized)) {
        continue;
      }

      results.push(...matches);
    }

    this.prefixCache.set(normalized, results);
    return [...results];
  }

  private addToNameIndex(uri: string, symbols: ShaderSymbol[]): void {
    for (const symbol of symbols) {
      const normalized = symbol.name.toLowerCase();
      const matches = this.symbolsByName.get(normalized) ?? [];

      matches.push({ symbol, uri });
      this.symbolsByName.set(normalized, matches);

      if (symbol.children.length > 0) {
        this.addToNameIndex(uri, symbol.children);
      }
    }
  }

  private removeFromNameIndex(uri: string, symbols: ShaderSymbol[]): void {
    for (const symbol of symbols) {
      const normalized = symbol.name.toLowerCase();
      const matches = this.symbolsByName.get(normalized);

      if (matches) {
        const remaining = matches.filter((match) => match.uri !== uri || match.symbol !== symbol);

        if (remaining.length === 0) {
          this.symbolsByName.delete(normalized);
        } else {
          this.symbolsByName.set(normalized, remaining);
        }
      }

      if (symbol.children.length > 0) {
        this.removeFromNameIndex(uri, symbol.children);
      }
    }
  }

  private collectMatchingSymbols(uri: string, symbols: ShaderSymbol[], name: string, results: SymbolMatch[]): void {
    for (const symbol of symbols) {
      if (symbol.name.toLowerCase().includes(name)) {
        results.push({
          symbol,
          uri,
        });
      }

      if (symbol.children.length > 0) {
        this.collectMatchingSymbols(uri, symbol.children, name, results);
      }
    }
  }

  private collectPrefixSymbols(uri: string, symbols: ShaderSymbol[], prefix: string, results: SymbolMatch[]): void {
    for (const symbol of symbols) {
      if (prefix.length === 0 || symbol.name.toLowerCase().startsWith(prefix)) {
        results.push({
          symbol,
          uri,
        });
      }

      if (symbol.children.length > 0) {
        this.collectPrefixSymbols(uri, symbol.children, prefix, results);
      }
    }
  }

  private collectAllSymbols(uri: string, symbols: ShaderSymbol[], results: SymbolMatch[]): void {
    for (const symbol of symbols) {
      results.push({
        symbol,
        uri,
      });

      if (symbol.children.length > 0) {
        this.collectAllSymbols(uri, symbol.children, results);
      }
    }
  }

  private countSymbols(symbols: ShaderSymbol[]): number {
    let count = 0;

    for (const symbol of symbols) {
      count++;

      count += this.countSymbols(symbol.children);
    }

    return count;
  }
}
