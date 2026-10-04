import { Worker } from 'worker_threads';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParsedDocument } from './ast';
import { LexicalAnalysis, Tokenizer } from './tokenizer';

type PendingParse = {
  resolve: (result: ParsedDocument) => void;
  reject: (error: Error) => void;
};

type ParseResponse = {
  id: number;
  result?: ParsedDocument;
  error?: string;
};

export class ParserService {
  private readonly lexicalCache = new Map<string, LexicalAnalysis>();
  private readonly maxLexicalCacheEntries = 32;
  private worker: Worker | undefined;
  private workerRequestId = 0;
  private readonly pending = new Map<number, PendingParse>();
  private readonly requests = new Map<number, { uri: string; document: TextDocument }>();
  private readonly queuedByUri = new Map<string, number>();
  private activeRequestId: number | undefined;

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
    const queuedRequestId = this.queuedByUri.get(uri);
    if (queuedRequestId !== undefined) {
      this.rejectPending(queuedRequestId, new Error('Parse invalidated'));
    }
  }

  public async parse(document: TextDocument): Promise<ParsedDocument> {
    const requestId = ++this.workerRequestId;

    // 同じURIでWorker待ちになっている古いParseは捨て、最新の内容だけをキューに残す。
    const queuedRequestId = this.queuedByUri.get(document.uri);
    if (queuedRequestId !== undefined) {
      this.rejectPending(queuedRequestId, new Error('Parse superseded by a newer document version'));
    }

    this.requests.set(requestId, { uri: document.uri, document });
    this.queuedByUri.set(document.uri, requestId);

    const result = new Promise<ParsedDocument>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    this.dispatchNext();
    return result;
  }

  public clear(): void {
    this.lexicalCache.clear();
    for (const [id, pending] of this.pending) {
      pending.reject(new Error('Parser service cleared'));
      this.pending.delete(id);
    }
    this.requests.clear();
    this.queuedByUri.clear();
    this.activeRequestId = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      void worker.terminate();
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(require.resolve('./parserWorker'));
    worker.on('message', (response: ParseResponse) => {
      const pending = this.pending.get(response.id);
      const request = this.requests.get(response.id);
      if (!pending || !request) {
        return;
      }

      this.pending.delete(response.id);
      this.requests.delete(response.id);
      if (this.activeRequestId === response.id) {
        this.activeRequestId = undefined;
          }

      if (response.error) {
        pending.reject(new Error(response.error));
      } else if (!response.result) {
        pending.reject(new Error('Parser worker returned no result'));
      } else {
        pending.resolve(response.result);
      }
      this.dispatchNext();
    });
    worker.on('error', (error) => {
      if (this.worker === worker) {
        this.worker = undefined;
      }
      if (this.activeRequestId !== undefined) {
        const id = this.activeRequestId;
        this.activeRequestId = undefined;
        this.rejectPending(id, error);
      }
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.worker = undefined;
      }
      if (code !== 0 && this.activeRequestId !== undefined) {
        const id = this.activeRequestId;
        this.activeRequestId = undefined;
        this.rejectPending(id, new Error(`Parser worker exited with code ${code}`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private dispatchNext(): void {
    if (this.activeRequestId !== undefined) {
      return;
    }

    const nextId = this.queuedByUri.values().next().value as number | undefined;
    if (nextId === undefined) {
      return;
    }

    const request = this.requests.get(nextId);
    if (!request) {
      this.queuedByUri.delete(request?.uri ?? '');
      return;
    }

    this.queuedByUri.delete(request.uri);
    this.activeRequestId = nextId;
    this.ensureWorker().postMessage({
      id: nextId,
      uri: request.document.uri,
      languageId: request.document.languageId,
      version: request.document.version,
      source: request.document.getText(),
    });
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    const request = this.requests.get(id);
    this.pending.delete(id);
    this.requests.delete(id);
    if (request && this.queuedByUri.get(request.uri) === id) {
      this.queuedByUri.delete(request.uri);
    }
    if (this.activeRequestId === id) {
      this.activeRequestId = undefined;
      }
    pending?.reject(error);
    this.dispatchNext();
  }
}
