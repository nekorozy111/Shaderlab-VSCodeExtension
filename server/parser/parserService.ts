import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParsedDocument } from './ast';
import { HlslParser } from './hlslParser';
import { ShaderLabParser } from './shaderlabParser';

export class ParserService {
  public parse(document: TextDocument): ParsedDocument {
    const source = document.getText();

    if (document.languageId === 'shaderlab') {
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
