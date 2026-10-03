import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParsedDocument } from './ast';
import { HlslParser } from './hlslParser';
import { ShaderLabParser } from './shaderlabParser';
import { getSourceLanguage } from '../language/languageId';
import { LexicalAnalysis, Tokenizer } from './tokenizer';

export class ParserService {
  private readonly lexicalCache = new Map<string, LexicalAnalysis>();
  private readonly maxLexicalCacheEntries = 32;

  public getLexicalAnalysis(document: TextDocument): LexicalAnalysis {
    const key = document.uri;
    const cached = this.lexicalCache.get(key);
    if (cached && cached.version === document.version && cached.sourceLength === document.getText().length) {
      return cached;
    }

    const lexical = new Tokenizer(document.getText()).analyze(document.version);
    this.lexicalCache.delete(key);
    this.lexicalCache.set(key, lexical);
    while (this.lexicalCache.size > this.maxLexicalCacheEntries) {
      const oldest = this.lexicalCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lexicalCache.delete(oldest);
    }
    return lexical;
  }

  public invalidate(uri: string): void {
    this.lexicalCache.delete(uri);
  }

  public clear(): void {
    this.lexicalCache.clear();
  }

  public parse(document: TextDocument): ParsedDocument {
    const source = document.getText();
    const lexical = this.getLexicalAnalysis(document);
    const sourceLanguage = getSourceLanguage(document.uri, document.languageId);
    if (sourceLanguage === 'shaderlab') {
      return {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        ast: new ShaderLabParser(source, lexical.tokens).parse(),
      };
    }

    return {
      uri: document.uri,
      languageId: document.languageId,
      version: document.version,
      ast: new HlslParser(source, lexical.tokens).parse(),
    };
  }
}
