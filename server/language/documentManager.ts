import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HlslFunctionNode, ParsedDocument } from '../parser/ast';
import { ParserService } from '../parser/parserService';
import { WorkspaceIndex, SymbolMatch } from '../symbol/workspaceIndex';
import { ProjectService } from '../project/projectService';
import { isHlslDocument } from './languageId';

type LocalSymbolEntry = {
  name: string;
  typeName: string;
  range: import('../parser/token').SourceRange;
  scope?: import('../parser/token').SourceRange;
};

type LocalFunctionIndex = {
  range: import('../parser/token').SourceRange;
  parameters: LocalSymbolEntry[];
  locals: LocalSymbolEntry[];
};

export class DocumentManager {
  private readonly documents = new Map<string, TextDocument>();
  private readonly parsedDocuments = new Map<string, ParsedDocument>();
  /** 関数単位のローカルシンボル索引。Completion/Hover時のAST全走査を避ける。 */
  private readonly localFunctionIndexes = new Map<string, LocalFunctionIndex[]>();
  /**
   * URIごとの直前のソース内容ハッシュ。
   * LSP versionだけが変わって内容が同一になった場合、ASTを再生成しない。
   */
  private readonly documentContentHashes = new Map<string, number>();
  private readonly parserService = new ParserService();
  private readonly workspaceIndex = new WorkspaceIndex();
  private readonly projectService = new ProjectService();
  /**
   * 外部 include から生成した ParsedDocument。
   * VS Code の open/close lifecycle には属さないため、
   * open document とは分離して管理する。
   */
  private readonly externalDocuments = new Map<string, ParsedDocument>();
  /**
   * root document -> その document から到達可能な外部 include URI。
   * F12 / Completion のたびに include tree を再構築しないための cache。
   */
  private readonly includeDependencies = new Map<string, Set<string>>();
  /**
   * root -> root自身を含む到達可能URI集合。
   * includeDependenciesとは別に保持し、F12/Completion/Hoverのたびに
   * Setをコピーするコストを避ける。読み取り専用として内部利用する。
   */
  private readonly relatedIncludeUrisCache = new Map<string, Set<string>>();
  /**
   * 外部 document を何個の open/root document が参照しているか。
   */
  private readonly externalReferenceCounts = new Map<string, number>();
  /**
   * include URI -> root document URI。
   * 外部ファイルが変更されたとき、そのファイルに依存する root だけを
   * include graph cache から無効化するために使用する。
   */
  private readonly includeDependents = new Map<string, Set<string>>();
  private readonly externalSources = new Map<string, string>();
  /** 同一rootへの非同期include解析を一本化する。 */
  private readonly pendingIncludePreparations = new Map<string, Promise<void>>();
  // 同じ外部includeを同時に要求した場合は、Parse処理を1本にまとめる。
  private readonly pendingExternalDocuments = new Map<string, Promise<ParsedDocument | undefined>>();
  // include解析の世代はrootごとに管理し、無関係な編集で別rootの解析を無効化しない。
  private readonly includePreparationGenerations = new Map<string, number>();
  // 外部ファイルの読み込み世代はURIごとに管理する。
  private readonly externalDocumentGenerations = new Map<string, number>();
  // 全external documentを一括無効化した世代。in-flight Promiseの復活を防ぐ。
  private externalDocumentGenerationEpoch = 0;
  // debounce中のrootは旧include graphを保持し、最新ASTが確定するまで再構築しない。
  private readonly staleIncludeRoots = new Set<string>();
  // root単位のinclude traversal全体で共有する同時実行数を制限する。
  private readonly includeTraversalConcurrency = 24;
  /**
   * 同一versionの再解析を防ぐための世代管理。
   * Parseは編集イベントのdebounce後に行い、LSP requestからは同期再Parseしない。
   */
  private readonly parsingVersions = new Map<string, number>();
  public initializeProject(params: Parameters<ProjectService['initialize']>[0]): void {
    this.projectService.initialize(params);
  }

  public getProjectService(): ProjectService {
    return this.projectService;
  }

  public open(document: TextDocument): ParsedDocument | undefined {
    if (!this.isProjectDocument(document.uri)) {
      this.documents.delete(document.uri);
      this.parserService.invalidate(document.uri);
      this.parsedDocuments.delete(document.uri);
      this.localFunctionIndexes.delete(document.uri);
      this.documentContentHashes.delete(document.uri);
      this.parsingVersions.delete(document.uri);
      this.workspaceIndex.remove(document.uri);
      return undefined;
    }

    // openしたファイルの内容を正として扱うため、以前このファイルを
    // includeしていたrootの関連URI cacheを無効化する。
    this.invalidateIncludeDependents([document.uri]);
    // include経由で保持していた同じURIの外部ASTを、open documentへ昇格させる。
    this.externalDocuments.delete(document.uri);
    this.externalSources.delete(document.uri);
    this.documents.set(document.uri, document);
    return this.parseDocument(document);
  }

  /**
   * VS Codeから受け取った最新Documentを保持する。
   * Parseは呼び出し側のdebounce後に行う。
   */
  public set(document: TextDocument): void {
    if (!this.isProjectDocument(document.uri)) {
      this.documents.delete(document.uri);
      this.parserService.invalidate(document.uri);
      this.parsedDocuments.delete(document.uri);
      this.localFunctionIndexes.delete(document.uri);
      this.documentContentHashes.delete(document.uri);
      this.parsingVersions.delete(document.uri);
      this.workspaceIndex.remove(document.uri);
      return;
    }

    // 編集直後は古いinclude ASTを保持し、debounce後のupdate()で差分を確定する。
    // これによりキー入力のたびにinclude ASTを解放・再ロードするのを防ぐ。
    this.invalidateRootIncludeCache(document.uri);
    // include先を直接編集した場合、そのファイルを参照しているrootの
    // 関連URI cacheも即時に無効化する。ASTの更新自体はdebounce後に行う。
    this.invalidateIncludeDependents([document.uri]);
    // open documentを外部includeキャッシュと二重保持しない。
    this.externalDocuments.delete(document.uri);
    this.externalSources.delete(document.uri);
    this.documents.set(document.uri, document);
  }

  public update(document: TextDocument): ParsedDocument {
    if (!this.isProjectDocument(document.uri)) {
      this.documents.delete(document.uri);
      this.parsedDocuments.delete(document.uri);
      this.documentContentHashes.delete(document.uri);
      this.parsingVersions.delete(document.uri);
      this.workspaceIndex.remove(document.uri);
      throw new Error('Document is outside the initialized project');
    }

    const source = document.getText();
    const contentHash = this.hashSource(source);
    const previousHash = this.documentContentHashes.get(document.uri);
    const previousParsed = this.parsedDocuments.get(document.uri);
    const parsingVersion = this.parsingVersions.get(document.uri);
    if (previousParsed && parsingVersion === document.version) {
      return previousParsed;
    }
    // versionだけが進んで内容が同じ場合はAST / Symbol Index / include graphを再構築しない。
    // undo/redoや同一内容のchange通知で無駄なParseを発生させない。
    if (previousParsed && previousHash === contentHash) {
      const versionedParsed: ParsedDocument = {
        ...previousParsed,
        version: document.version,
      };
      this.documents.set(document.uri, document);
      this.parsedDocuments.set(document.uri, versionedParsed);
      this.parsingVersions.set(document.uri, document.version);
      // 内容が同じならinclude graphもそのまま再利用できる。
      this.staleIncludeRoots.delete(document.uri);
      return versionedParsed;
    }

    // 内容が変わった場合だけ、古い include graph をParse直前に破棄する。
    // 先に世代を進めてin-flight解析を無効化し、その後に旧参照を解放する。
    this.invalidateIncludeDependents([document.uri]);
    this.invalidateRootIncludeCache(document.uri);
    this.releaseIncludeDependencies(document.uri);
    this.externalDocuments.delete(document.uri);
    this.externalSources.delete(document.uri);
    this.documents.set(document.uri, document);
    return this.parseDocument(document, contentHash);
  }

  public close(document: TextDocument): void {
    // このファイルをincludeしているrootも、open documentが消えるため再構築対象にする。
    this.invalidateIncludeDependents([document.uri]);
    this.invalidateRootIncludeCache(document.uri);
    this.documents.delete(document.uri);
    this.parserService.invalidate(document.uri);
    this.parsedDocuments.delete(document.uri);
    this.localFunctionIndexes.delete(document.uri);
    this.documentContentHashes.delete(document.uri);
    this.parsingVersions.delete(document.uri);
    this.workspaceIndex.remove(document.uri);
    // このroot documentが保持していたexternal includeの参照を解放する。
    this.releaseIncludeDependencies(document.uri);
    // close済みrootの世代情報は不要。in-flight処理中なら世代不一致で破棄される。
    this.staleIncludeRoots.delete(document.uri);
    this.includePreparationGenerations.delete(document.uri);
    this.cleanupExternalDocumentGeneration(document.uri);
  }

  public get(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  public getParsed(uri: string): ParsedDocument | undefined {
    // LSP requestから同期Parseすると、入力中のCompletion/Hover/F12ごとに
    // 重いParser/Index更新が走ってイベントループをブロックする。
    // 編集イベント側のdebounceで更新されたASTを返し、更新中は直前のASTを再利用する。
    return this.parsedDocuments.get(uri);
  }

  /**
   * 必要な場合だけ明示的に最新ASTへ更新する。
   * 通常のLSP requestでは呼ばず、open/debounce更新など管理側から使用する。
   */
  public ensureParsed(uri: string): ParsedDocument | undefined {
    const document = this.documents.get(uri);
    const parsed = this.parsedDocuments.get(uri);
    if (document && (!parsed || parsed.version !== document.version)) {
      return this.update(document);
    }
    return parsed;
  }

  public getLexicalAnalysis(uri: string) {
    const document = this.documents.get(uri);
    if (!document) {
      return undefined;
    }
    return this.parserService.getLexicalAnalysis(document);
  }

  public getWorkspaceIndex(): WorkspaceIndex {
    return this.workspaceIndex;
  }

  /**
   * Language Server内部の保持量とNodeプロセスのメモリ使用量を取得する。
   * デバッグ用のLSP requestから呼び出して、編集・include解決前後を比較できる。
   */
  public getMemoryStats(): {
    process: NodeJS.MemoryUsage;
    documents: number;
    parsedDocuments: number;
    externalDocuments: number;
    externalSources: number;
    includeDependencies: number;
    relatedIncludeCaches: number;
    externalReferenceCounts: number;
    includeDependents: number;
    includePreparationGenerations: number;
    externalDocumentGenerations: number;
    workspaceSymbols: number;
    fileSystemStatCache: number;
    fileSystemDirectoryCache: number;
  } {
    return {
      process: process.memoryUsage(),
      documents: this.documents.size,
      parsedDocuments: this.parsedDocuments.size,
      externalDocuments: this.externalDocuments.size,
      externalSources: this.externalSources.size,
      includeDependencies: this.includeDependencies.size,
      relatedIncludeCaches: this.relatedIncludeUrisCache.size,
      externalReferenceCounts: this.externalReferenceCounts.size,
      includeDependents: this.includeDependents.size,
      includePreparationGenerations: this.includePreparationGenerations.size,
      externalDocumentGenerations: this.externalDocumentGenerations.size,
      workspaceSymbols: this.workspaceIndex.getSymbolCount(),
      fileSystemStatCache: this.projectService.getFileSystemCacheStats().statEntries,
      fileSystemDirectoryCache: this.projectService.getFileSystemCacheStats().directoryEntries,
    };
  }

  /**
   * 現在のrootから到達可能なincludeだけを対象に完全一致検索する。
   * 各Providerでrelated URIの作成とfilterを重複させないための共通入口。
   */
  public findExactInRelated(rootUri: string, name: string): SymbolMatch[] {
    const relatedUris = this.getRelatedIncludeUris(rootUri);
    const globalMatches = this.workspaceIndex.findExact(name);
    // 同名symbolが少ない場合はWorkspace index側の検索が最も安い。
    // 関連Documentが非常に少ない場合だけURI側を直接走査する。
    const relatedSymbolCount = this.workspaceIndex.getDocumentSymbolCount(relatedUris);
    if (relatedSymbolCount < globalMatches.length) {
      return this.workspaceIndex.findExactInUris(name, relatedUris);
    }

    return globalMatches.filter((match) => relatedUris.has(match.uri));
  }

  public findPrefixInRelated(rootUri: string, prefix: string): SymbolMatch[] {
    const relatedUris = this.getRelatedIncludeUris(rootUri);
    const globalMatches = this.workspaceIndex.findPrefix(prefix);
    const relatedSymbolCount = this.workspaceIndex.getDocumentSymbolCount(relatedUris);
    // PackageCache全体に対するprefix候補が大量でも、現在のShaderが
    // 少数のincludeだけを持つなら、そのincludeだけを走査した方が速い。
    if (relatedSymbolCount < globalMatches.length) {
      return this.workspaceIndex.findPrefixInUris(prefix, relatedUris);
    }

    return globalMatches.filter((match) => relatedUris.has(match.uri));
  }

  public findByKindInRelated(
    rootUri: string,
    name: string,
    kind: Parameters<WorkspaceIndex['findByKind']>[1],
  ): SymbolMatch[] {
    const relatedUris = this.getRelatedIncludeUris(rootUri);
    const globalMatches = this.workspaceIndex.findByKind(name, kind);
    const relatedSymbolCount = this.workspaceIndex.getDocumentSymbolCount(relatedUris);
    if (relatedSymbolCount < globalMatches.length) {
      return this.workspaceIndex.findExactInUris(name, relatedUris).filter((match) => match.symbol.kind === kind);
    }

    return globalMatches.filter((match) => relatedUris.has(match.uri));
  }

  public has(uri: string): boolean {
    return this.documents.has(uri);
  }

  public all(): TextDocument[] {
    return Array.from(this.documents.values());
  }

  public allParsed(): ParsedDocument[] {
    return Array.from(this.parsedDocuments.values());
  }

  /**
   * LSPサーバー終了時に、保持しているDocument/AST/include graphを全て解放する。
   * Nodeプロセス終了時にはGC対象になるが、明示的に破棄して終了時の保持期間を短くする。
   */
  public dispose(): void {
    this.clear();
  }

  public clear(): void {
    // clear中のin-flight external document読み込みを全て古い世代として扱う。
    this.externalDocumentGenerationEpoch++;
    this.documents.clear();
    this.parsedDocuments.clear();
    this.localFunctionIndexes.clear();
    this.documentContentHashes.clear();
    this.parsingVersions.clear();
    this.parserService.clear();
    this.externalDocuments.clear();
    this.externalSources.clear();
    this.includeDependencies.clear();
    this.relatedIncludeUrisCache.clear();
    this.includeDependents.clear();
    this.externalReferenceCounts.clear();
    this.pendingIncludePreparations.clear();
    this.pendingExternalDocuments.clear();
    this.includePreparationGenerations.clear();
    this.externalDocumentGenerations.clear();
    this.staleIncludeRoots.clear();
    this.workspaceIndex.clear();
  }

  /**
   * 外部 include のキャッシュを無効化する。
   *
   * Unity の PackageCache / HLSL が変更された場合、古い AST を
   * WorkspaceIndex に残さないよう external document と依存関係を全て捨てる。
   * open document 自体は保持する。
   */
  public invalidateExternalIncludeCache(): void {
    // 全体invalidaton前に世代を進め、実行中のPromiseが古いASTを再登録できないようにする。
    this.externalDocumentGenerationEpoch++;
    for (const uri of this.externalDocuments.keys()) {
      this.workspaceIndex.remove(uri);
    }

    this.externalDocuments.clear();
    this.externalSources.clear();
    this.includeDependencies.clear();
    this.relatedIncludeUrisCache.clear();
    this.includeDependents.clear();
    this.externalReferenceCounts.clear();
    this.pendingIncludePreparations.clear();
    this.pendingExternalDocuments.clear();
    this.externalDocumentGenerations.clear();
    for (const rootUri of this.documents.keys()) {
      this.bumpIncludePreparationGeneration(rootUri);
    }
    this.staleIncludeRoots.clear();
  }

  /**
   * 変更された HLSL/HLSLI/CGINC に依存する root だけを無効化する。
   *
   * 従来の invalidateExternalIncludeCache() は1ファイル変更するだけで
   * プロジェクト全体の include AST を捨てていた。大規模な Unity project では
   * 次の F12/Completion で全て再解析されるため、不要な遅延が発生する。
   */
  public invalidateChangedExternalIncludes(changedUris: string[]): void {
    if (changedUris.length === 0) {
      return;
    }

    // ファイル監視経由では外部AST自体も古くなるため、依存rootの無効化に加えて
    // 変更ファイルのexternal documentを破棄する。
    this.invalidateIncludeDependents(changedUris);
    for (const changedUri of changedUris) {
      this.bumpExternalDocumentGeneration(changedUri);
      if (this.externalDocuments.has(changedUri)) {
        this.externalDocuments.delete(changedUri);
        this.externalSources.delete(changedUri);
        this.workspaceIndex.remove(changedUri);
      }
      this.cleanupExternalDocumentGeneration(changedUri);
    }
  }

  /**
   * open documentとして編集中のinclude先が変更されたときに、
   * そのファイルを参照するrootだけを関連URI cacheから無効化する。
   *
   * ここでは変更ファイル自身のASTを破棄しない。VS Codeの編集イベント直後は
   * debounce前でparsedDocumentsがまだ旧版だからであり、update()が実際にParseする
   * 直前に自身のinclude graphも破棄する。
   */
  private invalidateIncludeDependents(changedUris: string[]): void {
    if (changedUris.length === 0) {
      return;
    }

    const affectedRoots = new Set<string>();
    for (const changedUri of changedUris) {
      const dependents = this.includeDependents.get(changedUri);
      if (!dependents) {
        continue;
      }

      for (const rootUri of dependents) {
        affectedRoots.add(rootUri);
      }
    }

    for (const rootUri of affectedRoots) {
      // debounce前は旧ASTを有効なまま残し、関連URI cacheだけを無効化する。
      this.invalidateRootIncludeCache(rootUri);
    }
  }

  public async ensureExternalDocument(uri: string): Promise<ParsedDocument | undefined> {
    for (;;) {
      const openDocument = this.parsedDocuments.get(uri);
      if (openDocument) {
        return openDocument;
      }

      const existing = this.externalDocuments.get(uri);
      if (existing) {
        return existing;
      }

      const pending = this.pendingExternalDocuments.get(uri);
      if (pending) {
        const result = await pending;
        // 別rootの変更で古い世代の読み込みが破棄された場合は、現世代で再試行する。
        if (result || this.externalDocuments.has(uri) || this.parsedDocuments.has(uri)) {
          return result ?? this.parsedDocuments.get(uri) ?? this.externalDocuments.get(uri);
        }
        continue;
      }

      const preparationGeneration = this.getExternalDocumentGeneration(uri);
      const preparation = this.loadExternalDocument(uri, preparationGeneration);
      this.pendingExternalDocuments.set(uri, preparation);
      try {
        const result = await preparation;
        if (result) {
          return result;
        }
        if (preparationGeneration !== this.getExternalDocumentGeneration(uri)) {
          continue;
        }
        return undefined;
      } finally {
        if (this.pendingExternalDocuments.get(uri) === preparation) {
          this.pendingExternalDocuments.delete(uri);
        }
        this.cleanupExternalDocumentGeneration(uri);
      }
    }
  }

  private async loadExternalDocument(uri: string, preparationGeneration: string): Promise<ParsedDocument | undefined> {
    const filePath = this.uriToPath(uri);
    if (!filePath) {
      return undefined;
    }

    const text = await this.projectService.readFileAsync(filePath);
    if (text === undefined || preparationGeneration !== this.getExternalDocumentGeneration(uri)) {
      return undefined;
    }

    const languageId = this.detectLanguageId(filePath);
    if (!languageId) {
      return undefined;
    }

    const document = TextDocument.create(uri, languageId, 0, text);
    const parsed = this.parserService.parse(document);
    // 読み込み中にinclude graphが変更された結果は登録しない。
    if (preparationGeneration !== this.getExternalDocumentGeneration(uri)) {
      return undefined;
    }
    // 非同期中に同じURIがopenされた場合は、open側を正として外部ASTを登録しない。
    if (!this.parsedDocuments.has(uri)) {
      this.externalDocuments.set(uri, parsed);
      this.externalSources.set(uri, text);
      this.workspaceIndex.update(parsed);
    }
    return this.parsedDocuments.get(uri) ?? parsed;
  }

  public async prepareRelatedIncludeUris(rootUri: string): Promise<void> {
    if (this.relatedIncludeUrisCache.has(rootUri)) {
      return;
    }

    const pending = this.pendingIncludePreparations.get(rootUri);
    if (pending) {
      await pending;
      return;
    }

    const preparation = this.buildRelatedIncludeUris(rootUri);
    this.pendingIncludePreparations.set(rootUri, preparation);
    try {
      await preparation;
    } finally {
      if (this.pendingIncludePreparations.get(rootUri) === preparation) {
        this.pendingIncludePreparations.delete(rootUri);
      }
      this.cleanupIncludePreparationGeneration(rootUri);
    }
  }

  private async buildRelatedIncludeUris(rootUri: string): Promise<void> {
    if (this.relatedIncludeUrisCache.has(rootUri)) {
      return;
    }

    // staleなrootでは旧include graphを再利用せず、変更後のincludeを再走査する。
    const isStale = this.staleIncludeRoots.has(rootUri);
    const cachedDependencies = this.includeDependencies.get(rootUri);
    if (cachedDependencies && !isStale) {
      this.relatedIncludeUrisCache.set(rootUri, new Set([rootUri, ...cachedDependencies]));
      return;
    }

    if (isStale) {
      // 旧graphの参照カウント/dependentsを解除してから新graphを構築する。
      this.releaseIncludeDependencies(rootUri);
    }

    const rootDocument = this.documents.get(rootUri);
    const preparationGeneration = this.getIncludePreparationGeneration(rootUri);
    const parsed = this.getParsed(rootUri);
    if (!parsed) {
      this.relatedIncludeUrisCache.set(rootUri, new Set([rootUri]));
      return;
    }

    const result = new Set<string>();
    const visited = new Set<string>();
    await this.collectRelatedIncludeUrisRecursive(rootUri, parsed, visited, result);
    result.delete(rootUri);
    // 非同期解析中にDocumentがclose/changeされた場合、古いgraphを公開しない。
    if (
      this.documents.get(rootUri) !== rootDocument ||
      this.getIncludePreparationGeneration(rootUri) !== preparationGeneration
    ) {
      for (const uri of result) {
        if ((this.externalReferenceCounts.get(uri) ?? 0) > 0 || this.documents.has(uri)) {
          continue;
        }
        this.externalDocuments.delete(uri);
        this.externalSources.delete(uri);
        this.workspaceIndex.remove(uri);
      }
      return;
    }

    this.includeDependencies.set(rootUri, result);
    this.staleIncludeRoots.delete(rootUri);
    const relatedUris = new Set([rootUri, ...result]);
    this.relatedIncludeUrisCache.set(rootUri, relatedUris);
    for (const uri of result) {
      this.externalReferenceCounts.set(uri, (this.externalReferenceCounts.get(uri) ?? 0) + 1);
      const dependents = this.includeDependents.get(uri) ?? new Set<string>();
      dependents.add(rootUri);
      this.includeDependents.set(uri, dependents);
    }
  }

  /**
   * ASTから現在位置に有効なローカル変数/パラメータを取得する。
   * ソース全文を正規表現で再走査せず、Parserが保持するscope/rangeを利用する。
   */
  public findLocalVariableDeclarations(
    uri: string,
    prefix: string,
    offset: number,
  ): Array<{ name: string; typeName: string; range: import('../parser/token').SourceRange }> {
    const functionIndex = this.findContainingLocalFunction(uri, offset);
    if (!functionIndex) {
      return [];
    }

    const result: Array<{ name: string; typeName: string; range: import('../parser/token').SourceRange }> = [];
    const seen = new Set<string>();
    for (const parameter of functionIndex.parameters) {
      if (!parameter.name.startsWith(prefix) || seen.has(`parameter:${parameter.name}`)) {
        continue;
      }
      seen.add(`parameter:${parameter.name}`);
      result.push({ name: parameter.name, typeName: parameter.typeName, range: parameter.range });
    }

    for (const local of functionIndex.locals) {
      if (!local.name.startsWith(prefix) || local.range.start.offset > offset) {
        continue;
      }
      if (local.scope && !this.rangeContainsOffset(local.scope, offset)) {
        continue;
      }
      const key = `local:${local.name}:${local.range.start.offset}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ name: local.name, typeName: local.typeName, range: local.range });
    }

    return result;
  }

  public findLocalVariable(
    uri: string,
    name: string,
    offset: number,
  ):
    | {
        name: string;
        typeName: string;
        range: import('../parser/token').SourceRange;
      }
    | undefined {
    const functionIndex = this.findContainingLocalFunction(uri, offset);
    if (!functionIndex) {
      return undefined;
    }

    let best:
      | { name: string; typeName: string; range: import('../parser/token').SourceRange; span: number }
      | undefined;

    for (const parameter of functionIndex.parameters) {
      if (parameter.name !== name || parameter.range.start.offset > offset) {
        continue;
      }
      best = {
        name: parameter.name,
        typeName: parameter.typeName,
        range: parameter.range,
        span: functionIndex.range.end.offset - functionIndex.range.start.offset,
      };
    }

    for (const local of functionIndex.locals) {
      if (local.name !== name || local.range.start.offset > offset) {
        continue;
      }
      if (local.scope && !this.rangeContainsOffset(local.scope, offset)) {
        continue;
      }
      const span = local.scope
        ? local.scope.end.offset - local.scope.start.offset
        : functionIndex.range.end.offset - functionIndex.range.start.offset;
      if (!best || span <= best.span) {
        best = { name: local.name, typeName: local.typeName, range: local.range, span };
      }
    }

    if (!best) return undefined;
    return { name: best.name, typeName: best.typeName, range: best.range };
  }

  private findContainingLocalFunction(uri: string, offset: number): LocalFunctionIndex | undefined {
    const functions = this.localFunctionIndexes.get(uri);
    if (!functions || functions.length === 0) {
      return undefined;
    }

    // 開始位置で二分探索し、offset以前で最も後ろにある関数だけを候補にする。
    let low = 0;
    let high = functions.length - 1;
    let candidate = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (functions[mid].range.start.offset <= offset) {
        candidate = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (candidate < 0) {
      return undefined;
    }

    const functionIndex = functions[candidate];
    return this.rangeContainsOffset(functionIndex.range, offset) ? functionIndex : undefined;
  }

  private rangeContainsOffset(range: import('../parser/token').SourceRange, offset: number): boolean {
    return range.start.offset <= offset && offset <= range.end.offset;
  }

  public getRelatedIncludeUris(rootUri: string): Set<string> {
    const cachedRelatedUris = this.relatedIncludeUrisCache.get(rootUri);
    if (cachedRelatedUris) {
      return cachedRelatedUris;
    }

    if (this.staleIncludeRoots.has(rootUri)) {
      return new Set([rootUri]);
    }

    const cachedDependencies = this.includeDependencies.get(rootUri);
    if (cachedDependencies) {
      const relatedUris = new Set([rootUri, ...cachedDependencies]);
      this.relatedIncludeUrisCache.set(rootUri, relatedUris);
      return relatedUris;
    }

    // 非同期のinclude解析はprepareRelatedIncludeUris()で先に完了させる。
    return new Set([rootUri]);
  }

  private getIncludePreparationGeneration(rootUri: string): number {
    return this.includePreparationGenerations.get(rootUri) ?? 0;
  }

  private bumpIncludePreparationGeneration(rootUri: string): void {
    this.includePreparationGenerations.set(rootUri, this.getIncludePreparationGeneration(rootUri) + 1);
  }

  private getExternalDocumentGeneration(uri: string): string {
    // 全体世代とURI単位の世代を別々に保持し、連結した値で比較する。
    // 単純加算するとclear後の新世代と古いURI世代が同じ値になり得る。
    return `${this.externalDocumentGenerationEpoch}:${this.externalDocumentGenerations.get(uri) ?? 0}`;
  }

  private bumpExternalDocumentGeneration(uri: string): void {
    const generation = this.externalDocumentGenerations.get(uri) ?? 0;
    this.externalDocumentGenerations.set(uri, generation + 1);
  }

  // close済みrootで不要になったinclude解析世代を解放する。
  private cleanupIncludePreparationGeneration(rootUri: string): void {
    if (
      this.documents.has(rootUri) ||
      this.pendingIncludePreparations.has(rootUri) ||
      this.includeDependencies.has(rootUri) ||
      this.relatedIncludeUrisCache.has(rootUri)
    ) {
      return;
    }
    this.staleIncludeRoots.delete(rootUri);
    this.includePreparationGenerations.delete(rootUri);
  }

  // 参照も外部ASTも残っていないURIの読み込み世代を解放する。
  private cleanupExternalDocumentGeneration(uri: string): void {
    if (
      this.documents.has(uri) ||
      this.externalDocuments.has(uri) ||
      this.externalReferenceCounts.has(uri) ||
      this.pendingExternalDocuments.has(uri)
    ) {
      return;
    }
    this.externalDocumentGenerations.delete(uri);
  }

  private invalidateRootIncludeCache(rootUri: string): void {
    this.relatedIncludeUrisCache.delete(rootUri);
    this.staleIncludeRoots.add(rootUri);
    this.bumpIncludePreparationGeneration(rootUri);
  }

  private releaseIncludeDependencies(rootUri: string): void {
    const dependencies = this.includeDependencies.get(rootUri);
    if (!dependencies) {
      return;
    }

    this.includeDependencies.delete(rootUri);
    this.relatedIncludeUrisCache.delete(rootUri);
    this.staleIncludeRoots.delete(rootUri);
    for (const uri of dependencies) {
      const dependents = this.includeDependents.get(uri);
      if (dependents) {
        dependents.delete(rootUri);
        if (dependents.size === 0) {
          this.includeDependents.delete(uri);
        }
      }

      const nextCount = (this.externalReferenceCounts.get(uri) ?? 1) - 1;
      if (nextCount > 0) {
        this.externalReferenceCounts.set(uri, nextCount);
        continue;
      }

      this.externalReferenceCounts.delete(uri);
      // open document は externalDocuments に入らないため、ここでは触らない。
      if (!this.documents.has(uri)) {
        this.externalDocuments.delete(uri);
        this.externalSources.delete(uri);
        this.workspaceIndex.remove(uri);
      }
      // 解放中にin-flight読み込みがあれば、結果を登録させない。
      if (this.pendingExternalDocuments.has(uri)) {
        this.bumpExternalDocumentGeneration(uri);
      } else {
        this.cleanupExternalDocumentGeneration(uri);
      }
    }
  }

  private collectHlslIncludes(ast: any, result: string[]): void {
    if (!ast || !Array.isArray(ast.declarations)) {
      return;
    }

    for (const declaration of ast.declarations) {
      if (declaration?.kind === 'HlslInclude' && typeof declaration.path === 'string') {
        result.push(declaration.path);
      }
    }
  }

  private async collectRelatedIncludeUrisRecursive(
    uri: string,
    parsed: ParsedDocument,
    visited: Set<string>,
    result: Set<string>,
    source?: string,
  ): Promise<void> {
    interface TraversalItem {
      uri: string;
      parsed: ParsedDocument;
      source?: string;
    }

    // rootから開始した1回のtraversalでqueueとworker上限を共有する。
    const queue: TraversalItem[] = [{ uri, parsed, source }];
    let active = 0;
    let settled = false;
    let resolveTraversal: () => void = () => undefined;
    let rejectTraversal: (error: unknown) => void = () => undefined;
    const traversal = new Promise<void>((resolve, reject) => {
      resolveTraversal = resolve;
      rejectTraversal = reject;
    });

    visited.add(uri);
    let pump: () => void = () => undefined;

    const processItem = async (current: TraversalItem): Promise<void> => {
      let includePaths: string[];
      if (isHlslDocument(current.parsed.uri, current.parsed.languageId) && current.source !== undefined) {
        includePaths = this.collectRawHlslIncludes(current.source);
      } else {
        includePaths = this.collectIncludes(current.parsed);
      }

      for (const includePath of includePaths) {
        const resolved = await this.projectService.resolveInclude(includePath, current.uri);
        if (!resolved) {
          continue;
        }

        result.add(resolved.uri);
        if (visited.has(resolved.uri)) {
          continue;
        }
        visited.add(resolved.uri);

        const externalDocument = await this.ensureExternalDocument(resolved.uri);
        if (!externalDocument) {
          continue;
        }

        queue.push({
          uri: resolved.uri,
          parsed: externalDocument,
          source: this.externalSources.get(resolved.uri),
        });
        // 子includeを発見した時点で空きworkerへ渡し、root全体の24並列を活用する。
        pump();
      }
    };

    pump = (): void => {
      while (!settled && active < this.includeTraversalConcurrency && queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          break;
        }

        active++;
        void processItem(current).then(
          () => {
            active--;
            pump();
            if (!settled && active === 0 && queue.length === 0) {
              settled = true;
              resolveTraversal();
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              rejectTraversal(error);
            }
          },
        );
      }

      if (!settled && active === 0 && queue.length === 0) {
        settled = true;
        resolveTraversal();
      }
    };

    // 子includeを同じqueueへ追加しながらpumpを再利用するため、
    // 再帰階層ごとにworker poolが増えることはなく、traversal全体で最大24並列になる。
    pump();
    await traversal;
  }

  private collectIncludes(parsed: ParsedDocument): string[] {
    const result: string[] = [];
    if (parsed.ast.kind === 'ShaderDocument') {
      this.collectShaderLabIncludes(parsed.ast, result);
    } else {
      this.collectHlslIncludes(parsed.ast, result);
    }

    return result;
  }

  private collectShaderLabIncludes(ast: any, result: string[]): void {
    if (!ast) {
      return;
    }

    /*
     * Shader 全体の HLSL ブロック
     */
    if (Array.isArray(ast.hlslBlocks)) {
      for (const block of ast.hlslBlocks) {
        this.collectHlslIncludes(block?.hlsl, result);
      }
    }

    if (!Array.isArray(ast.subShaders)) {
      return;
    }

    for (const subShader of ast.subShaders) {
      /*
       * SubShader 内の HLSL
       */
      if (Array.isArray(subShader.hlslBlocks)) {
        for (const block of subShader.hlslBlocks) {
          this.collectHlslIncludes(block?.hlsl, result);
        }
      }

      /*
       * Pass 内の HLSL
       */
      if (!Array.isArray(subShader.passes)) {
        continue;
      }

      for (const pass of subShader.passes) {
        if (!Array.isArray(pass.hlslBlocks)) {
          continue;
        }

        for (const block of pass.hlslBlocks) {
          this.collectHlslIncludes(block?.hlsl, result);
        }
      }
    }
  }

  private collectRawHlslIncludes(source: string): string[] {
    const result: string[] = [];
    const lines = source.split(/\r?\n/);
    for (const line of lines) {
      /*
       * 行末コメントを除去する。
       *
       * ただし include path 内の
       * // は対象外になるよう、
       * include path を先に取得する。
       */
      const match = line.match(/^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)(?:\s*\/\/.*)?$/);
      if (!match) {
        continue;
      }

      const includePath = match[1] ?? match[2];
      if (!includePath) {
        continue;
      }

      result.push(includePath.trim());
    }

    return result;
  }

  private parseDocument(document: TextDocument, knownContentHash?: number): ParsedDocument {
    const parsed = this.parserService.parse(document);
    this.parsedDocuments.set(document.uri, parsed);
    this.documentContentHashes.set(document.uri, knownContentHash ?? this.hashSource(document.getText()));
    this.parsingVersions.set(document.uri, document.version);
    this.localFunctionIndexes.set(document.uri, this.buildLocalFunctionIndex(parsed.ast));
    this.workspaceIndex.update(parsed);
    return parsed;
  }

  private buildLocalFunctionIndex(ast: ParsedDocument['ast']): LocalFunctionIndex[] {
    const result: LocalFunctionIndex[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      const candidate = node as { kind?: string; range?: import('../parser/token').SourceRange };
      if (candidate.kind === 'HlslFunction' && candidate.range) {
        const fn = node as HlslFunctionNode;
        result.push({
          range: fn.range,
          parameters: (fn.parameters ?? [])
            .filter((parameter) => Boolean(parameter?.name && parameter?.typeName))
            .map((parameter) => ({
              name: parameter.name,
              typeName: parameter.typeName,
              range: parameter.range,
            })),
          locals: (fn.locals ?? [])
            .filter((local) => Boolean(local?.name && local?.typeName && local?.range))
            .map((local) => ({
              name: local.name,
              typeName: local.typeName,
              range: local.range,
              scope: local.scope,
            })),
        });
        return;
      }

      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            visit(item);
          }
        } else if (value && typeof value === 'object') {
          visit(value);
        }
      }
    };

    visit(ast);
    result.sort((a, b) => a.range.start.offset - b.range.start.offset);
    return result;
  }

  /** FNV-1a 32bit。暗号学的用途ではなく、同一内容判定専用。 */
  private hashSource(source: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }

    return hash >>> 0;
  }

  private detectLanguageId(filePath: string): string | undefined {
    const extension = path.extname(filePath).toLowerCase();
    switch (extension) {
      case '.shader':
        return 'shaderlab';
      case '.hlsl':
      case '.hlsli':
      case '.compute':
      case '.cginc':
        return 'hlsl';
      default:
        return undefined;
    }
  }

  private isProjectDocument(uri: string): boolean {
    const filePath = this.uriToPath(uri);
    if (!filePath) {
      return false;
    }
    const root = this.projectService.getRootPath();
    return !!root && this.projectService.isInsideProject(filePath);
  }

  private uriToPath(uri: string): string | undefined {
    if (!uri.startsWith('file://')) {
      return undefined;
    }

    try {
      let value = decodeURIComponent(uri.substring('file://'.length));
      if (/^\/[A-Za-z]:\//.test(value)) {
        value = value.substring(1);
      }

      return value;
    } catch {
      return undefined;
    }
  }
}
