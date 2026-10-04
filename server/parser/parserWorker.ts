import { parentPort } from 'worker_threads';
import { HlslParser } from './hlslParser';
import { ShaderLabParser } from './shaderlabParser';
import { Tokenizer } from './tokenizer';
import { ParsedDocument } from './ast';
import { getSourceLanguage } from '../language/languageId';

if (!parentPort) {
  throw new Error('Parser worker requires parentPort');
}

type ParseRequest = {
  id: number;
  uri: string;
  languageId: string;
  version: number;
  source: string;
};

type ParseResponse = {
  id: number;
  result?: ParsedDocument;
  error?: string;
};

parentPort.on('message', (request: ParseRequest) => {
  try {
    const lexical = new Tokenizer(request.source).analyze(request.version);
    const sourceLanguage = getSourceLanguage(request.uri, request.languageId);
    const ast =
      sourceLanguage === 'shaderlab'
        ? new ShaderLabParser(request.source, lexical.tokens).parse()
        : new HlslParser(request.source, lexical.tokens).parse();

    const response: ParseResponse = {
      id: request.id,
      result: {
        uri: request.uri,
        languageId: request.languageId,
        version: request.version,
        ast,
      },
    };
    parentPort?.postMessage(response);
  } catch (error) {
    const response: ParseResponse = {
      id: request.id,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
    parentPort?.postMessage(response);
  }
});
