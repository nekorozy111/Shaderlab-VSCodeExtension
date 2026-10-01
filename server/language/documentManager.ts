import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParsedDocument } from '../parser/ast';
import { ParserService } from '../parser/parserService';
import { WorkspaceIndex, SymbolMatch } from '../symbol/workspaceIndex';
import { ProjectService } from '../project/projectService';
import { isHlslDocument } from './languageId';

export class DocumentManager {
  private readonly documents = new Map<string, TextDocument>();
  private readonly parsedDocuments = new Map<string, ParsedDocument>();
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
  // 日本語コメント：同じ外部includeを同時に要求した場合は、Parse処理を1本にまとめる。
  private readonly pendingExternalDocuments = new Map<string, Promise<ParsedDocument | undefined>>();
  private includePreparationGeneration = 0;
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
      this.documentContentHashes.delete(document.uri);
      this.parsingVersions.delete(document.uri);
      this.workspaceIndex.remove(document.uri);
      return;
    }

    // 日本語コメント：編集時点でこのroot自身が保持する古いinclude graphも破棄する。
    // ASTの更新はdebounce後でも、関連URIだけは次のrequestから再構築させる。
    this.releaseIncludeDependencies(document.uri);
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
      return versionedParsed;
    }

    // 内容が変わった場合だけ、古い include graph を破棄する。
    this.releaseIncludeDependencies(document.uri);
    // このdocument自身をincludeしているrootも、変更後のASTを参照できるよう
    // 関連URI cacheを無効化する。set()でも一度無効化しているが、debounce中に
    // cacheが再構築された場合に備えて、実際のParse直前にも再度無効化する。
    this.invalidateIncludeDependents([document.uri]);
    this.externalDocuments.delete(document.uri);
    this.externalSources.delete(document.uri);
    this.documents.set(document.uri, document);
    return this.parseDocument(document, contentHash);
  }

  public close(document: TextDocument): void {
    this.documents.delete(document.uri);
    this.parserService.invalidate(document.uri);
    this.parsedDocuments.delete(document.uri);
    this.documentContentHashes.delete(document.uri);
    this.parsingVersions.delete(document.uri);
    this.workspaceIndex.remove(document.uri);
    // この root document が保持していた external include の参照を解放する。
    this.releaseIncludeDependencies(document.uri);
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
    this.includePreparationGeneration++;
    this.documents.clear();
    this.parsedDocuments.clear();
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
    this.includePreparationGeneration++;
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
      if (this.externalDocuments.has(changedUri)) {
        this.externalDocuments.delete(changedUri);
        this.externalSources.delete(changedUri);
        this.workspaceIndex.remove(changedUri);
      }
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

    // 非同期include解析中に古い結果が再登録されないよう世代を進める。
    this.includePreparationGeneration++;

    const affectedRoots = new Set<string>();
    for (const changedUri of changedUris) {
      const dependents = this.includeDependents.get(changedUri);
      if (!dependents) {
        continue;
      }

      for (const rootUri of dependents) {
        affectedRoots.add(rootUri);
      }

      // 変更されたURIに紐づくreverse edge自体も古くなるため、
      // 依存rootを収集した後に削除する。
      this.includeDependents.delete(changedUri);
    }

    for (const rootUri of affectedRoots) {
      this.releaseIncludeDependencies(rootUri);
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
        // 日本語コメント：別rootの変更で古い世代の読み込みが破棄された場合は、現世代で再試行する。
        if (result || this.externalDocuments.has(uri) || this.parsedDocuments.has(uri)) {
          return result ?? this.parsedDocuments.get(uri) ?? this.externalDocuments.get(uri);
        }
        continue;
      }

      const preparationGeneration = this.includePreparationGeneration;
      const preparation = this.loadExternalDocument(uri, preparationGeneration);
      this.pendingExternalDocuments.set(uri, preparation);
      try {
        const result = await preparation;
        if (result) {
          return result;
        }
        if (preparationGeneration !== this.includePreparationGeneration) {
          continue;
        }
        return undefined;
      } finally {
        if (this.pendingExternalDocuments.get(uri) === preparation) {
          this.pendingExternalDocuments.delete(uri);
        }
      }
    }
  }

  private async loadExternalDocument(uri: string, preparationGeneration: number): Promise<ParsedDocument | undefined> {
    const filePath = this.uriToPath(uri);
    if (!filePath) {
      return undefined;
    }

    const text = await this.projectService.readFileAsync(filePath);
    if (text === undefined || preparationGeneration !== this.includePreparationGeneration) {
      return undefined;
    }

    const languageId = this.detectLanguageId(filePath);
    if (!languageId) {
      return undefined;
    }

    const document = TextDocument.create(uri, languageId, 0, text);
    const parsed = this.parserService.parse(document);
    // 日本語コメント：読み込み中にinclude graphが変更された結果は登録しない。
    if (preparationGeneration !== this.includePreparationGeneration) {
      return undefined;
    }
    // 日本語コメント：非同期中に同じURIがopenされた場合は、open側を正として外部ASTを登録しない。
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
    }
  }

  private async buildRelatedIncludeUris(rootUri: string): Promise<void> {
    if (this.relatedIncludeUrisCache.has(rootUri)) {
      return;
    }

    const cachedDependencies = this.includeDependencies.get(rootUri);
    if (cachedDependencies) {
      this.relatedIncludeUrisCache.set(rootUri, new Set([rootUri, ...cachedDependencies]));
      return;
    }

    const rootDocument = this.documents.get(rootUri);
    const preparationGeneration = this.includePreparationGeneration;
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
    if (this.documents.get(rootUri) !== rootDocument || this.includePreparationGeneration !== preparationGeneration) {
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
  public findLocalVariable(uri: string, name: string, offset: number): {
    name: string;
    typeName: string;
    range: import('../parser/token').SourceRange;
  } | undefined {
    const parsed = this.parsedDocuments.get(uri);
    if (!parsed) {
      return undefined;
    }

    let best: { name: string; typeName: string; range: import('../parser/token').SourceRange; span: number } | undefined;
    const contains = (range: import('../parser/token').SourceRange, point: number): boolean =>
      range.start.offset <= point && point <= range.end.offset;

    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (node.kind === 'HlslFunction') {
        const fn = node;
        if (contains(fn.range, offset)) {
          for (const parameter of fn.parameters ?? []) {
            if (parameter.name !== name || !contains(fn.range, offset)) continue;
            if (parameter.range.start.offset <= offset) {
              best = { name: parameter.name, typeName: parameter.typeName, range: parameter.range, span: fn.range.end.offset - fn.range.start.offset };
            }
          }
          for (const local of fn.locals ?? []) {
            if (local.name !== name || local.range.start.offset > offset) continue;
            if (local.scope && !contains(local.scope, offset)) continue;
            const span = local.scope ? local.scope.end.offset - local.scope.start.offset : fn.range.end.offset - fn.range.start.offset;
            if (!best || span <= best.span) {
              best = { name: local.name, typeName: local.typeName, range: local.range, span };
            }
          }
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          if (Array.isArray(value)) value.forEach(visit);
          else if ((value as any).kind) visit(value);
        }
      }
    };

    visit(parsed.ast);
    if (!best) return undefined;
    return { name: best.name, typeName: best.typeName, range: best.range };
  }

  public getRelatedIncludeUris(rootUri: string): Set<string> {
    const cachedRelatedUris = this.relatedIncludeUrisCache.get(rootUri);
    if (cachedRelatedUris) {
      return cachedRelatedUris;
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

  private releaseIncludeDependencies(rootUri: string): void {
    const dependencies = this.includeDependencies.get(rootUri);
    if (!dependencies) {
      return;
    }

    this.includeDependencies.delete(rootUri);
    this.relatedIncludeUrisCache.delete(rootUri);
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
    if (visited.has(uri)) {
      return;
    }

    visited.add(uri);
    let includePaths: string[];
    /*
     * 外部 HLSL は実ファイルの内容から
     * #include を取得する。
     */
    if (isHlslDocument(parsed.uri, parsed.languageId) && source !== undefined) {
      includePaths = this.collectRawHlslIncludes(source);
    } else {
      includePaths = this.collectIncludes(parsed);
    }

    await Promise.all(includePaths.map(async (includePath) => {
      const resolved = await this.projectService.resolveInclude(includePath, uri);
      if (!resolved) return;

      result.add(resolved.uri);
      // 日本語コメント：独立したinclude branchは並列化し、同一URIのParseはin-flight cacheで共有する。
      const externalDocument = await this.ensureExternalDocument(resolved.uri);
      if (!externalDocument) return;

      const externalSource = this.externalSources.get(resolved.uri);
      await this.collectRelatedIncludeUrisRecursive(resolved.uri, externalDocument, visited, result, externalSource);
    }));
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
    this.workspaceIndex.update(parsed);
    return parsed;
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
