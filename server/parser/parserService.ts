import * as os from 'os';
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

type WorkerSlot = {
  worker: Worker;
  activeRequestId?: number;
  terminating: boolean;
};

export class ParserService {
  private readonly lexicalCache = new Map<string, LexicalAnalysis>();
  private readonly maxLexicalCacheEntries = 32;
  // CPUコア数に応じて2〜4本に制限し、過剰なWorker生成を防ぐ。
  private readonly workerCount = Math.min(4, Math.max(2, os.cpus().length));
  private readonly workers: WorkerSlot[] = [];
  private workerRequestId = 0;
  private readonly pending = new Map<number, PendingParse>();
  private readonly requests = new Map<number, { uri: string; document: TextDocument }>();
  private readonly queuedByUri = new Map<string, number>();
  private disposed = false;

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

    // 実行中の古いParseも止める。PromiseだけをrejectしてWorkerを走らせ続けると、
    // 大きなShaderの連続編集時にCPUと一時メモリを消費し続けるため、Workerごと再生成する。
    for (const slot of this.workers.slice()) {
      const activeRequestId = slot.activeRequestId;
      if (activeRequestId === undefined) {
        continue;
      }
      const request = this.requests.get(activeRequestId);
      if (request?.uri === uri) {
        this.cancelActiveWorker(slot, activeRequestId, new Error('Parse invalidated'));
      }
    }
  }

  public async parse(document: TextDocument): Promise<ParsedDocument> {
    if (this.disposed) {
      return Promise.reject(new Error('Parser service is disposed'));
    }

    const requestId = ++this.workerRequestId;
    const queuedRequestId = this.queuedByUri.get(document.uri);
    if (queuedRequestId !== undefined) {
      this.rejectPending(queuedRequestId, new Error('Parse superseded by a newer document version'));
    }

    // 同一URIで実行中の古いParseはWorkerごとキャンセルする。
    for (const slot of this.workers.slice()) {
      const activeRequestId = slot.activeRequestId;
      if (activeRequestId === undefined) {
        continue;
      }
      const request = this.requests.get(activeRequestId);
      if (request?.uri === document.uri) {
        this.cancelActiveWorker(slot, activeRequestId, new Error('Parse superseded by a newer document version'));
      }
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
    this.disposed = true;
    this.lexicalCache.clear();
    for (const [id, pending] of this.pending) {
      pending.reject(new Error('Parser service cleared'));
      this.pending.delete(id);
    }
    this.requests.clear();
    this.queuedByUri.clear();

    const slots = this.workers.splice(0, this.workers.length);
    for (const slot of slots) {
      slot.terminating = true;
      void slot.worker.terminate();
    }
  }

  private createWorkerSlot(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(require.resolve('./parserWorker')),
      terminating: false,
    };

    slot.worker.on('message', (response: ParseResponse) => {
      const requestId = response.id;
      if (slot.activeRequestId === requestId) {
        slot.activeRequestId = undefined;
      }

      const pending = this.pending.get(requestId);
      const request = this.requests.get(requestId);
      if (!pending || !request) {
        this.dispatchNext();
        return;
      }

      this.pending.delete(requestId);
      this.requests.delete(requestId);
      if (this.queuedByUri.get(request.uri) === requestId) {
        this.queuedByUri.delete(request.uri);
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

    const handleWorkerFailure = (error: Error): void => {
      if (slot.terminating) {
        return;
      }
      slot.terminating = true;
      const requestId = slot.activeRequestId;
      slot.activeRequestId = undefined;
      this.removeWorkerSlot(slot);
      if (requestId !== undefined) {
        this.rejectPending(requestId, error, false);
      }
      if (!this.disposed) {
        this.ensureWorkerPool();
        this.dispatchNext();
      }
    };

    slot.worker.on('error', handleWorkerFailure);
    slot.worker.on('exit', (code) => {
      if (slot.terminating || this.disposed) {
        this.removeWorkerSlot(slot);
        return;
      }
      if (code !== 0) {
        handleWorkerFailure(new Error(`Parser worker exited with code ${code}`));
      } else {
        const requestId = slot.activeRequestId;
        slot.activeRequestId = undefined;
        this.removeWorkerSlot(slot);
        if (requestId !== undefined) {
          this.rejectPending(requestId, new Error('Parser worker exited unexpectedly'), false);
        }
        this.ensureWorkerPool();
        this.dispatchNext();
      }
    });

    this.workers.push(slot);
    return slot;
  }

  private ensureWorkerPool(): void {
    if (this.disposed) {
      return;
    }
    while (this.workers.length < this.workerCount) {
      this.createWorkerSlot();
    }
  }

  private removeWorkerSlot(slot: WorkerSlot): void {
    const index = this.workers.indexOf(slot);
    if (index >= 0) {
      this.workers.splice(index, 1);
    }
  }

  private cancelActiveWorker(slot: WorkerSlot, requestId: number, error: Error): void {
    if (slot.activeRequestId !== requestId || slot.terminating) {
      return;
    }

    slot.activeRequestId = undefined;
    slot.terminating = true;
    this.removeWorkerSlot(slot);
    this.rejectPending(requestId, error, false);
    void slot.worker.terminate().finally(() => {
      if (!this.disposed) {
        this.ensureWorkerPool();
        this.dispatchNext();
      }
    });
  }

  private dispatchNext(): void {
    if (this.disposed) {
      return;
    }

    this.ensureWorkerPool();

    for (const slot of this.workers) {
      if (slot.terminating || slot.activeRequestId !== undefined) {
        continue;
      }

      const next = this.queuedByUri.entries().next().value as [string, number] | undefined;
      if (next === undefined) {
        return;
      }

      const [uri, nextId] = next;
      const request = this.requests.get(nextId);
      if (!request) {
        this.queuedByUri.delete(uri);
        continue;
      }

      this.queuedByUri.delete(uri);
      slot.activeRequestId = nextId;
      slot.worker.postMessage({
        id: nextId,
        uri: request.document.uri,
        languageId: request.document.languageId,
        version: request.document.version,
        source: request.document.getText(),
      });
    }
  }

  private rejectPending(id: number, error: Error, dispatch = true): void {
    const pending = this.pending.get(id);
    const request = this.requests.get(id);
    this.pending.delete(id);
    this.requests.delete(id);
    if (request && this.queuedByUri.get(request.uri) === id) {
      this.queuedByUri.delete(request.uri);
    }
    pending?.reject(error);
    if (dispatch) {
      this.dispatchNext();
    }
  }
}
