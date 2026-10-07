import {
  SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  SemanticTokensParams,
} from 'vscode-languageserver/node';
import { Token } from '../parser/token';
import { Tokenizer } from '../parser/tokenizer';
import { DocumentManager } from './documentManager';

export const HlslSemanticTokenTypes = [
  'namespace',
  'type',
  'struct',
  'class',
  'interface',
  'enum',
  'enumMember',
  'typeParameter',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'parameter',
  'constant',
  'macro',
  'keyword',
  'operator',
  'number',
  'string',
  'comment',
] as const;

export const HlslSemanticTokenModifiers = ['declaration', 'readonly', 'static'] as const;

export const HlslSemanticTokensLegend: SemanticTokensLegend = {
  tokenTypes: [...HlslSemanticTokenTypes],
  tokenModifiers: [...HlslSemanticTokenModifiers],
};

type SemanticTokenType = (typeof HlslSemanticTokenTypes)[number];

const BUILTIN_TYPES = new Set([
  'void',
  'bool',
  'int',
  'uint',
  'half',
  'float',
  'double',
  'min16float',
  'min10float',
  'min16int',
  'min12int',
  'min16uint',
  'float2',
  'float3',
  'float4',
  'float2x2',
  'float2x3',
  'float2x4',
  'float3x2',
  'float3x3',
  'float3x4',
  'float4x2',
  'float4x3',
  'float4x4',
  'half2',
  'half3',
  'half4',
  'half2x2',
  'half3x3',
  'half4x4',
  'int2',
  'int3',
  'int4',
  'uint2',
  'uint3',
  'uint4',
  'bool2',
  'bool3',
  'bool4',
  'sampler',
  'sampler1D',
  'sampler2D',
  'sampler3D',
  'samplerCUBE',
  'Texture1D',
  'Texture2D',
  'Texture3D',
  'TextureCube',
  'Texture1DArray',
  'Texture2DArray',
  'TextureCubeArray',
  'RWTexture1D',
  'RWTexture2D',
  'RWTexture3D',
  'RWTexture1DArray',
  'RWTexture2DArray',
  'StructuredBuffer',
  'RWStructuredBuffer',
  'ByteAddressBuffer',
  'RWByteAddressBuffer',
  'Buffer',
  'RWBuffer',
]);

const KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'discard',
  'struct',
  'class',
  'interface',
  'typedef',
  'const',
  'static',
  'uniform',
  'in',
  'out',
  'inout',
  'inline',
  'precise',
  'volatile',
  'groupshared',
  'row_major',
  'column_major',
  'register',
  'packoffset',
  'cbuffer',
  'tbuffer',
  'namespace',
  'true',
  'false',
]);

const HLSL_SEMANTICS = new Set([
  'POSITION',
  'POSITION0',
  'POSITION1',
  'POSITION2',
  'POSITION3',
  'NORMAL',
  'NORMAL0',
  'NORMAL1',
  'NORMAL2',
  'NORMAL3',
  'TANGENT',
  'TANGENT0',
  'TANGENT1',
  'TANGENT2',
  'TANGENT3',
  'BINORMAL',
  'BINORMAL0',
  'BINORMAL1',
  'BINORMAL2',
  'BINORMAL3',
  'TEXCOORD',
  'TEXCOORD0',
  'TEXCOORD1',
  'TEXCOORD2',
  'TEXCOORD3',
  'TEXCOORD4',
  'TEXCOORD5',
  'TEXCOORD6',
  'TEXCOORD7',
  'TEXCOORD8',
  'TEXCOORD9',
  'COLOR',
  'COLOR0',
  'COLOR1',
  'COLOR2',
  'COLOR3',
  'SV_POSITION',
  'SV_TARGET',
  'SV_TARGET0',
  'SV_TARGET1',
  'SV_TARGET2',
  'SV_TARGET3',
  'SV_DEPTH',
  'SV_DEPTH0',
  'SV_DEPTH1',
  'SV_COVERAGE',
  'SV_DISPATCHTHREADID',
  'SV_GROUPID',
  'SV_GROUPINDEX',
  'SV_GROUPTHREADID',
  'SV_INSTANCEID',
  'SV_ISFRONTFACE',
  'SV_PRIMITIVEID',
  'SV_SAMPLEINDEX',
  'SV_VERTEXID',
  'SV_VIEWPORTARRAYINDEX',
  'SV_RENDERTARGETARRAYINDEX',
  'SV_OUTPUTCONTROLPOINTID',
  'SV_DOMAINLOCATION',
  'SV_HULLPERPATCHID',
  'SV_TESSFACTOR',
  'SV_INSIDETESSFACTOR',
  'SV_EDGE_TESSFACTOR',
]);

const OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
  '!',
  '&',
  '|',
  '^',
  '~',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<',
  '>>',
  '->',
  '::',
  '&=',
  '|=',
  '^=',
  '?',
]);

export class SemanticTokenProvider {
  public constructor(private readonly documentManager: DocumentManager) {}

  public provideSemanticTokens(params: SemanticTokensParams): SemanticTokens {
    const document = this.documentManager.get(params.textDocument.uri);
    if (!document) {
      return { data: [] };
    }

    const uri = params.textDocument.uri;
    const source = document.getText();
    const lexical = new Tokenizer(source).analyze(document.version);
    const tokens = lexical.tokens.filter((token) => token.kind !== 'eof');
    const ranges = lexical.hlslRanges.length > 0 ? lexical.hlslRanges : [{ start: 0, end: source.length }];
    const semanticEntries: Array<{
      line: number;
      character: number;
      length: number;
      type: SemanticTokenType;
    }> = [];

    // コメントはTokenizerが通常のtoken列から除外するため、専用rangeから追加する。
    for (const comment of lexical.commentRanges) {
      if (!ranges.some((range) => comment.start >= range.start && comment.start < range.end)) {
        continue;
      }

      const commentText = source.slice(comment.start, comment.end);
      let line = 0;
      let character = 0;
      for (let index = 0; index < comment.start; index++) {
        if (source[index] === '\n') {
          line++;
          character = 0;
        } else {
          character++;
        }
      }

      const lines = commentText.split('\n');
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        if (lines[lineIndex].length === 0) {
          continue;
        }
        semanticEntries.push({
          line: line + lineIndex,
          character: lineIndex === 0 ? character : 0,
          length: lines[lineIndex].length,
          type: 'comment',
        });
      }
    }

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!ranges.some((range) => token.range.start.offset >= range.start && token.range.start.offset < range.end)) {
        continue;
      }

      const type = this.classifyToken(uri, tokens, index);
      if (!type) {
        continue;
      }

      semanticEntries.push({
        line: token.range.start.line,
        character: token.range.start.character,
        length: Math.max(1, token.range.end.offset - token.range.start.offset),
        type,
      });
    }

    semanticEntries.sort((left, right) => {
      if (left.line !== right.line) return left.line - right.line;
      return left.character - right.character;
    });

    const builder = new SemanticTokensBuilder();
    for (const entry of semanticEntries) {
      builder.push(entry.line, entry.character, entry.length, HlslSemanticTokenTypes.indexOf(entry.type), 0);
    }

    return builder.build();
  }

  private classifyToken(uri: string, tokens: Token[], index: number): SemanticTokenType | undefined {
    const token = tokens[index];

    if (token.kind === 'number') {
      return 'number';
    }
    if (token.kind === 'string') {
      return 'string';
    }
    if (token.kind === 'operator' || OPERATORS.has(token.value)) {
      return 'operator';
    }
    // # 自体は着色対象にせず、#define / #include などのディレクティブ名だけを分類する。
    if (token.kind === 'preprocessor') {
      return undefined;
    }
    if (token.kind !== 'identifier') {
      return undefined;
    }

    // . の直後は構造体メンバまたはベクトルswizzleとして扱う。
    // swizzle は同名の変数・予約語よりも優先する。
    if (tokens[index - 1]?.value === '.') {
      return 'property';
    }

    // 構造体フィールド宣言の semantic は、シンボル検索結果よりも優先する。
    // POSITION / NORMAL / TEXCOORD0 / SV_POSITION などが別のシンボルと衝突しても、
    // フィールド宣言の一部として field と同じ色になるようにする。
    if (HLSL_SEMANTICS.has(token.value.toUpperCase()) && this.isStructFieldSemantic(tokens, index)) {
      return 'field';
    }

    // #define NAME の NAME はマクロとして色付けする。
    if (this.isPreprocessorDirective(tokens, index, 'define')) {
      return 'macro';
    }

    // シンボル情報を予約語より先に見る。
    // 例えば構造体メンバ名が予約語と同じ場合でも、メンバとして着色する。
    const matches = this.documentManager.findExactInRelated(uri, token.value);
    if (matches.length > 0) {
      const declarationMatch = this.findBestDeclarationMatch(matches, token);
      if (declarationMatch) {
        return this.symbolKindToSemanticToken(declarationMatch.symbol.kind);
      }

      if (matches.some((match) => match.symbol.kind === 'field') && this.isLikelyFieldReference(tokens, index)) {
        return 'field';
      }

      if (tokens[index + 1]?.value === '(' && matches.some((match) => match.symbol.kind === 'function')) {
        return 'function';
      }

      if (matches.some((match) => match.symbol.kind === 'typedef') && this.looksLikeTypePosition(tokens, index)) {
        return 'type';
      }
      if (matches.some((match) => match.symbol.kind === 'struct') && this.looksLikeTypePosition(tokens, index)) {
        return 'struct';
      }
      if (matches.some((match) => match.symbol.kind === 'macro')) {
        return 'macro';
      }
      if (matches.some((match) => match.symbol.kind === 'parameter')) {
        return 'parameter';
      }
      if (matches.some((match) => match.symbol.kind === 'field')) {
        return 'field';
      }
      if (matches.some((match) => match.symbol.kind === 'function')) {
        return 'function';
      }
      if (matches.some((match) => match.symbol.kind === 'cbuffer')) {
        return 'namespace';
      }
      if (matches.some((match) => match.symbol.kind === 'variable')) {
        return this.isConstDeclaration(tokens, index) ? 'constant' : 'variable';
      }
      if (matches.some((match) => match.symbol.kind === 'struct')) {
        return 'struct';
      }
      if (matches.some((match) => match.symbol.kind === 'typedef')) {
        return 'type';
      }
    }

    if (BUILTIN_TYPES.has(token.value)) {
      return 'type';
    }
    if (HLSL_SEMANTICS.has(token.value.toUpperCase())) {
      return 'keyword';
    }
    if (KEYWORDS.has(token.value)) {
      return 'keyword';
    }

    return undefined;
  }

  private findBestDeclarationMatch(
    matches: ReturnType<DocumentManager['findExactInRelated']>,
    token: Token,
  ): ReturnType<DocumentManager['findExactInRelated']>[number] | undefined {
    return matches.find(
      (match) =>
        match.symbol.location.selectionRange.start.offset === token.range.start.offset &&
        match.symbol.location.selectionRange.end.offset === token.range.end.offset,
    );
  }

  private isLikelyFieldReference(tokens: Token[], index: number): boolean {
    return tokens[index - 1]?.value === '.' || tokens[index - 1]?.value === '->';
  }

  private isStructFieldSemantic(tokens: Token[], index: number): boolean {
    // field : POSITION のように、コロン直後にある semantic を判定する。
    if (tokens[index - 1]?.value !== ':') {
      return false;
    }

    // 現在位置から直前のセミコロン/波括弧までを見て、
    // 型 + フィールド名 + ':' という宣言形になっているか確認する。
    let colonIndex = index - 1;
    for (let i = colonIndex - 1; i >= 0; i--) {
      const value = tokens[i].value;
      if (value === ';' || value === '{' || value === '}') {
        break;
      }
      if (value === ':') {
        return false;
      }

      if (tokens[i].kind === 'identifier' && tokens[i + 1]?.value === ':') {
        // semantic の左側にフィールド名がある。
        // さらにその前に型があることを確認する。
        return i > 0 && (tokens[i - 1]?.kind === 'identifier' || BUILTIN_TYPES.has(tokens[i - 1]?.value));
      }
    }

    return false;
  }

  private isPreprocessorDirective(tokens: Token[], index: number, directive: string): boolean {
    return tokens[index - 1]?.value === directive && tokens[index - 2]?.value === '#';
  }

  private symbolKindToSemanticToken(kind: string): SemanticTokenType {
    switch (kind) {
      case 'struct':
        return 'struct';
      case 'typedef':
        return 'type';
      case 'function':
        return 'function';
      case 'parameter':
        return 'parameter';
      case 'field':
        return 'field';
      case 'property':
        return 'property';
      case 'macro':
        return 'macro';
      case 'cbuffer':
        return 'namespace';
      case 'variable':
        return 'variable';
      default:
        return 'variable';
    }
  }

  private looksLikeTypePosition(tokens: Token[], index: number): boolean {
    const previous = tokens[index - 1]?.value;
    const next = tokens[index + 1]?.value;
    return (
      previous === undefined ||
      previous === ';' ||
      previous === '{' ||
      previous === '}' ||
      previous === ',' ||
      previous === ')' ||
      previous === '(' ||
      KEYWORDS.has(previous) ||
      next === '*' ||
      next === '&' ||
      (next !== undefined && /^[A-Za-z_]\w*$/.test(next))
    );
  }

  private isConstDeclaration(tokens: Token[], index: number): boolean {
    for (let i = index - 1; i >= Math.max(0, index - 6); i--) {
      const value = tokens[i].value;
      if (value === ';' || value === '{' || value === '}') {
        break;
      }
      if (value === 'const') {
        return true;
      }
    }
    return false;
  }
}
