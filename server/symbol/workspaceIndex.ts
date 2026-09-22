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

  private readonly symbolExtractor = new SymbolExtractor();

  public update(document: ParsedDocument): void {
    this.documents.set(document.uri, document);

    const extracted = this.symbolExtractor.extract(document);

    this.symbols.set(document.uri, extracted);
  }

  public remove(uri: string): void {
    this.documents.delete(uri);

    this.symbols.delete(uri);
  }

  public clear(): void {
    this.documents.clear();
    this.symbols.clear();
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

    return this.find(name).filter((match) => match.symbol.name.toLowerCase() === normalized);
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

    const results: SymbolMatch[] = [];

    for (const [uri, symbols] of this.symbols) {
      this.collectPrefixSymbols(uri, symbols, normalized, results);
    }

    return results;
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
