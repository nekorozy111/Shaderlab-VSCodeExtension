import * as path from 'path';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParsedDocument } from '../parser/ast';
import { ParserService } from '../parser/parserService';
import { WorkspaceIndex, SymbolMatch } from '../symbol/workspaceIndex';
import { ProjectService } from '../project/projectService';

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

  public initializeProject(params: Parameters<ProjectService['initialize']>[0]): void {
    this.projectService.initialize(params);
  }

  public getProjectService(): ProjectService {
    return this.projectService;
  }

  public open(document: TextDocument): ParsedDocument {
    this.documents.set(document.uri, document);

    return this.parseDocument(document);
  }

  /**
   * VS Codeから受け取った最新Documentを保持する。
   * Parseは呼び出し側のdebounce後に行う。
   */
  public set(document: TextDocument): void {
    this.documents.set(document.uri, document);
  }

  public update(document: TextDocument): ParsedDocument {
    const source = document.getText();
    const contentHash = this.hashSource(source);
    const previousHash = this.documentContentHashes.get(document.uri);
    const previousParsed = this.parsedDocuments.get(document.uri);

    // versionだけが進んで内容が同じ場合はAST / Symbol Index / include graphを再構築しない。
    // undo/redoや同一内容のchange通知で無駄なParseを発生させない。
    if (previousParsed && previousHash === contentHash) {
      const versionedParsed: ParsedDocument = {
        ...previousParsed,
        version: document.version,
      };

      this.documents.set(document.uri, document);
      this.parsedDocuments.set(document.uri, versionedParsed);
      return versionedParsed;
    }

    // 内容が変わった場合だけ、古い include graph を破棄する。
    this.releaseIncludeDependencies(document.uri);

    this.documents.set(document.uri, document);

    return this.parseDocument(document, contentHash);
  }


  public close(document: TextDocument): void {
    this.documents.delete(document.uri);

    this.parsedDocuments.delete(document.uri);
    this.documentContentHashes.delete(document.uri);
    this.workspaceIndex.remove(document.uri);

    // この root document が保持していた external include の参照を解放する。
    this.releaseIncludeDependencies(document.uri);
  }

  public get(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  public getParsed(uri: string): ParsedDocument | undefined {
    const document = this.documents.get(uri);
    const parsed = this.parsedDocuments.get(uri);

    // debounce中でもF12/hover等から要求された場合は、
    // 古いASTを返さず最新Documentを同期的に再解析する。
    if (document && (!parsed || parsed.version !== document.version)) {
      return this.update(document);
    }

    return parsed;
  }

  public getWorkspaceIndex(): WorkspaceIndex {
    return this.workspaceIndex;
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

  public findByKindInRelated(rootUri: string, name: string, kind: Parameters<WorkspaceIndex['findByKind']>[1]): SymbolMatch[] {
    const relatedUris = this.getRelatedIncludeUris(rootUri);
    const globalMatches = this.workspaceIndex.findByKind(name, kind);
    const relatedSymbolCount = this.workspaceIndex.getDocumentSymbolCount(relatedUris);

    if (relatedSymbolCount < globalMatches.length) {
      return this.workspaceIndex
        .findExactInUris(name, relatedUris)
        .filter((match) => match.symbol.kind === kind);
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

  public clear(): void {
    this.documents.clear();
    this.parsedDocuments.clear();
    this.documentContentHashes.clear();
    this.externalDocuments.clear();
    this.externalSources.clear();
    this.includeDependencies.clear();
    this.relatedIncludeUrisCache.clear();
    this.includeDependents.clear();
    this.externalReferenceCounts.clear();
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
    for (const uri of this.externalDocuments.keys()) {
      this.workspaceIndex.remove(uri);
    }

    this.externalDocuments.clear();
    this.externalSources.clear();
    this.includeDependencies.clear();
    this.relatedIncludeUrisCache.clear();
    this.includeDependents.clear();
    this.externalReferenceCounts.clear();
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

    const affectedRoots = new Set<string>();

    for (const changedUri of changedUris) {
      const dependents = this.includeDependents.get(changedUri);

      if (dependents) {
        for (const rootUri of dependents) {
          affectedRoots.add(rootUri);
        }
      }

      // 変更された external document 自体も古い AST を保持しない。
      if (this.externalDocuments.has(changedUri)) {
        this.externalDocuments.delete(changedUri);
        this.externalSources.delete(changedUri);
        this.workspaceIndex.remove(changedUri);
      }

      // 依存 root が存在しない場合でも、古い reverse edge を残さない。
      this.includeDependents.delete(changedUri);
    }

    for (const rootUri of affectedRoots) {
      this.releaseIncludeDependencies(rootUri);
    }
  }

  public ensureExternalDocument(uri: string): ParsedDocument | undefined {
    const openDocument = this.parsedDocuments.get(uri);

    if (openDocument) {
      return openDocument;
    }

    const existing = this.externalDocuments.get(uri);

    if (existing) {
      return existing;
    }

    const filePath = this.uriToPath(uri);

    if (!filePath) {
      return undefined;
    }

    const text = this.projectService.readFile(filePath);

    if (text === undefined) {
      return undefined;
    }

    const languageId = this.detectLanguageId(filePath);

    if (!languageId) {
      return undefined;
    }

    const document = TextDocument.create(uri, languageId, 0, text);

    const parsed = this.parserService.parse(document);

    this.externalDocuments.set(uri, parsed);
    this.externalSources.set(uri, text);
    this.workspaceIndex.update(parsed);

    return parsed;
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

    const result = new Set<string>();
    const visited = new Set<string>();
    const parsed = this.getParsed(rootUri);

    if (!parsed) {
      return new Set([rootUri]);
    }

    this.collectRelatedIncludeUrisRecursive(rootUri, parsed, visited, result);

    result.delete(rootUri);
    this.includeDependencies.set(rootUri, result);

    const relatedUris = new Set([rootUri, ...result]);
    this.relatedIncludeUrisCache.set(rootUri, relatedUris);

    for (const uri of result) {
      this.externalReferenceCounts.set(uri, (this.externalReferenceCounts.get(uri) ?? 0) + 1);

      const dependents = this.includeDependents.get(uri) ?? new Set<string>();
      dependents.add(rootUri);
      this.includeDependents.set(uri, dependents);
    }

    return relatedUris;
  }

  private collectRelatedIncludeUrisRecursive(
    uri: string,
    parsed: ParsedDocument,
    visited: Set<string>,
    result: Set<string>,
    source?: string,
  ): void {
    if (visited.has(uri)) {
      return;
    }

    visited.add(uri);

    let includePaths: string[];

    /*
     * 外部 HLSL は実ファイルの内容から
     * #include を取得する。
     */
    if (parsed.languageId === 'hlsl' && source !== undefined) {
      includePaths = this.collectRawHlslIncludes(source);
    } else {
      includePaths = this.collectIncludes(parsed);
    }

    for (const includePath of includePaths) {
      const resolved = this.projectService.resolveInclude(includePath, uri);

      if (!resolved) {
        continue;
      }

      result.add(resolved.uri);

      /*
       * include 先を Parse / Index。
       */
      const externalDocument = this.ensureExternalDocument(resolved.uri);

      if (!externalDocument) {
        continue;
      }

      /*
       * 再帰的な #include を調べるため、
       * 外部ファイルの raw source を取得する。
       */
      const externalSource = this.externalSources.get(resolved.uri);

      this.collectRelatedIncludeUrisRecursive(resolved.uri, externalDocument, visited, result, externalSource);
    }
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
    this.documentContentHashes.set(
      document.uri,
      knownContentHash ?? this.hashSource(document.getText()),
    );


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
        return 'hlsl';

      default:
        return undefined;
    }
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
