import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParsedDocument } from './ast';
import { HlslParser } from './hlslParser';
import { ShaderLabParser } from './shaderlabParser';
import { getSourceLanguage } from '../language/languageId';

export class ParserService {
  public parse(document: TextDocument): ParsedDocument {
    const source = document.getText();
    const sourceLanguage = getSourceLanguage(document.uri, document.languageId);
    if (sourceLanguage === 'shaderlab') {
      return {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        ast: new ShaderLabParser(source).parse(),
      };
    }

    return {
      uri: document.uri,
      languageId: document.languageId,
      version: document.version,
      ast: new HlslParser(source).parse(),
    };
  }
}
