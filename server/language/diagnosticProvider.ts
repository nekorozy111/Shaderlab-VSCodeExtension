import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  HlslFunctionNode,
  HlslStructNode,
  HlslVariableNode,
  ParsedDocument,
  ShaderDocumentNode,
  HlslDocumentNode,
} from '../parser/ast';
import { Token } from '../parser/token';
import { Tokenizer } from '../parser/tokenizer';
import { DocumentManager } from './documentManager';

type SymbolInfo = {
  name: string;
  typeName?: string;
  kind: string;
  range: import('../parser/token').SourceRange;
  scope?: import('../parser/token').SourceRange;
};

export class DiagnosticProvider {
  private readonly builtinTypes = new Set([
    'void',
    'bool',
    'bool1',
    'bool2',
    'bool3',
    'bool4',
    'int',
    'int1',
    'int2',
    'int3',
    'int4',
    'uint',
    'uint1',
    'uint2',
    'uint3',
    'uint4',
    'half',
    'half1',
    'half2',
    'half3',
    'half4',
    'float',
    'float1',
    'float2',
    'float3',
    'float4',
    'double',
    'double1',
    'double2',
    'double3',
    'double4',
    'min10float',
    'min10float2',
    'min10float3',
    'min10float4',
    'min16float',
    'min16float2',
    'min16float3',
    'min16float4',
    'min16int',
    'min16int2',
    'min16int3',
    'min16int4',
    'min16uint',
    'min16uint2',
    'min16uint3',
    'min16uint4',
    'float2x2',
    'float2x3',
    'float2x4',
    'float3x2',
    'float3x3',
    'float3x4',
    'float4x2',
    'float4x3',
    'float4x4',
    'half2x2',
    'half2x3',
    'half2x4',
    'half3x2',
    'half3x3',
    'half3x4',
    'half4x2',
    'half4x3',
    'half4x4',
    'Texture1D',
    'Texture2D',
    'Texture3D',
    'TextureCube',
    'Texture1DArray',
    'Texture2DArray',
    'TextureCubeArray',
    'Texture2DMS',
    'Texture2DMSArray',
    'RWTexture1D',
    'RWTexture2D',
    'RWTexture3D',
    'RWTexture1DArray',
    'RWTexture2DArray',
    'Buffer',
    'RWBuffer',
    'StructuredBuffer',
    'RWStructuredBuffer',
    'AppendStructuredBuffer',
    'ConsumeStructuredBuffer',
    'ByteAddressBuffer',
    'RWByteAddressBuffer',
    'ConstantBuffer',
    'SamplerState',
    'SamplerComparisonState',
    'RasterizerOrderedBuffer',
    'RasterizerOrderedByteAddressBuffer',
    'RasterizerOrderedStructuredBuffer',
    'RasterizerOrderedTexture1D',
    'RasterizerOrderedTexture2D',
    'RasterizerOrderedTexture3D',
    'RaytracingAccelerationStructure',
    'InputPatch',
    'OutputPatch',
    'PointStream',
    'LineStream',
    'TriangleStream',
    'sampler1D',
    'sampler2D',
    'sampler3D',
    'samplerCUBE',
    'matrix',
    'vector',
    'RayDesc',
    'RayQuery',
    'RayQuery64',
    'RaytracingAccelerationStructure',
    'Triangle',
    'TriangleStrip',
    'Line',
    'LineStrip',
  ]);

  private readonly keywords = new Set([
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
    'cbuffer',
    'tbuffer',
    'class',
    'namespace',
    'static',
    'const',
    'volatile',
    'uniform',
    'in',
    'out',
    'inout',
    'register',
    'true',
    'false',
    'NULL',
    'typedef',
    'enum',
    'union',
    'interface',
    'template',
    'typename',
    'extern',
    'inline',
    'precise',
    'nointerpolation',
    'linear',
    'centroid',
    'noperspective',
    'sample',
    'snorm',
    'unorm',
    'row_major',
    'column_major',
    'groupshared',
    'globallycoherent',
    'shared',
    'static',
    'packoffset',
    'true',
    'false',
    'SamplerState',
    'SamplerComparisonState',
    // Unity/ShaderLabのHLSLブロック・CBUFFER用マクロ。
    'HLSLPROGRAM',
    'HLSLINCLUDE',
    'ENDHLSL',
    'CGPROGRAM',
    'ENDCG',
    'CBUFFER_START',
    'CBUFFER_END',
    'UNITY_BRANCH',
    'UNITY_FLATTEN',
    'UNITY_UNROLL',
    'UNITY_LOOP',
    'UNITY_VERTEX_INPUT_INSTANCE_ID',
    'UNITY_SETUP_INSTANCE_ID',
    'UNITY_TRANSFER_INSTANCE_ID',
    'UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO',
    'UNITY_VERTEX_OUTPUT_STEREO',
    'UNITY_DECLARE_TEX2D',
    'UNITY_DECLARE_TEX3D',
    'UNITY_DECLARE_TEXCUBE',
    'UNITY_DECLARE_TEX2DARRAY',
  ]);

  // Unityのインクルードファイル等で提供されるマクロ。
  // 関数のように見えるマクロは通常の関数検索へ渡さない。
  private readonly builtinMacros = new Set([
    'HLSLPROGRAM',
    'HLSLINCLUDE',
    'ENDHLSL',
    'CGPROGRAM',
    'ENDCG',
    'CBUFFER_START',
    'CBUFFER_END',
    'UNITY_BRANCH',
    'UNITY_FLATTEN',
    'UNITY_UNROLL',
    'UNITY_LOOP',
    'UNITY_ASSUME',
    'UNITY_UNROLLX',
    'UNITY_LOOPX',
    'UNITY_VERTEX_INPUT_INSTANCE_ID',
    'UNITY_SETUP_INSTANCE_ID',
    'UNITY_TRANSFER_INSTANCE_ID',
    'UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO',
    'UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX',
    'UNITY_VERTEX_OUTPUT_STEREO',
    'UNITY_INITIALIZE_OUTPUT',
    'UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO',
    'UNITY_ANY_INSTANCING_ENABLED',
    'UNITY_ACCESS_INSTANCED_PROP',
    'UNITY_DEFINE_INSTANCED_PROP',
    'UNITY_INSTANCING_BUFFER_START',
    'UNITY_INSTANCING_BUFFER_END',
    'UNITY_INSTANCING_CBUFFER_START',
    'UNITY_INSTANCING_CBUFFER_END',
    'UNITY_DECLARE_TEX2D',
    'UNITY_DECLARE_TEX3D',
    'UNITY_DECLARE_TEXCUBE',
    'UNITY_DECLARE_TEX2DARRAY',
    'UNITY_DECLARE_TEXCUBEARRAY',
    'UNITY_DECLARE_TEX2D_MSAA',
    'UNITY_DECLARE_TEX2DARRAY_MSAA',
    'UNITY_DECLARE_SHADOWMAP',
    'UNITY_DECLARE_TEX2D_NOSAMPLER',
    'UNITY_DECLARE_TEX3D_NOSAMPLER',
    'UNITY_DECLARE_TEXCUBE_NOSAMPLER',
    'UNITY_SAMPLE_TEX2D',
    'UNITY_SAMPLE_TEX3D',
    'UNITY_SAMPLE_TEXCUBE',
    'UNITY_SAMPLE_TEX2DARRAY',
    'UNITY_SAMPLE_TEXCUBEARRAY',
    'UNITY_SAMPLE_TEX2D_SAMPLER',
    'UNITY_SAMPLE_TEX3D_SAMPLER',
    'UNITY_SAMPLE_TEXCUBE_SAMPLER',
    'UNITY_SAMPLE_TEX2DARRAY_SAMPLER',
    'UNITY_SAMPLE_TEXCUBEARRAY_SAMPLER',
    'SAMPLE_TEXTURE2D',
    'SAMPLE_TEXTURE2D_LOD',
    'SAMPLE_TEXTURE2D_BIAS',
    'SAMPLE_TEXTURE2D_GRAD',
    'SAMPLE_TEXTURE2D_ARRAY',
    'SAMPLE_TEXTURE2D_ARRAY_LOD',
    'SAMPLE_TEXTURE3D',
    'SAMPLE_TEXTURE3D_LOD',
    'SAMPLE_TEXTURECUBE',
    'SAMPLE_TEXTURECUBE_LOD',
    'SAMPLE_TEXTURECUBE_ARRAY',
    'SAMPLE_TEXTURECUBE_ARRAY_LOD',
    'LOAD_TEXTURE2D',
    'LOAD_TEXTURE2D_ARRAY',
    'LOAD_TEXTURE3D',
    'LOAD_TEXTURECUBE',
    'TRANSFORM_TEX',
    'TEXTURE2D',
    'TEXTURE2D_ARRAY',
    'TEXTURE3D',
    'TEXTURECUBE',
    'TEXTURECUBE_ARRAY',
    'SAMPLER',
    'SAMPLER_CMP',
    'DECLARE_TEX2D',
    'DECLARE_TEX3D',
    'DECLARE_TEXCUBE',
    'DECLARE_TEX2D_ARRAY',
    'DECLARE_TEXCUBE_ARRAY',
    'DECLARE_SAMPLER',
  ]);

  // HLSL/Unityが暗黙に提供するグローバルシンボル。
  private readonly builtinSymbols = new Set([
    'PI',
    'FLT_EPSILON',
    'FLT_MIN',
    'FLT_MAX',
    'INT_MIN',
    'INT_MAX',
    'UINT_MIN',
    'UINT_MAX',
    'HALF_MIN',
    'HALF_MAX',
    'unity_ObjectToWorld',
    'unity_WorldToObject',
    'unity_MatrixVP',
    'unity_MatrixV',
    'unity_MatrixInvV',
    'unity_MatrixP',
    'unity_MatrixInvP',
    'unity_CameraProjection',
    'unity_CameraInvProjection',
    'unity_CameraWorldClipPlanes',
    'unity_CameraWorldPos',
    'unity_OrthoParams',
    'unity_CameraParams',
    'unity_DeltaTime',
    'unity_Time',
    'unity_SinTime',
    'unity_CosTime',
    'unity_WorldTransformParams',
    'unity_LODFade',
    'unity_RenderingLayer',
    'unity_LightmapST',
    'unity_DynamicLightmapST',
    'unity_SHAr',
    'unity_SHAg',
    'unity_SHAb',
    'unity_SHBr',
    'unity_SHBg',
    'unity_SHBb',
    'unity_SHC',
    'unity_SpecCube0',
    'unity_SpecCube1',
    'unity_SpecCube0_HDR',
    'unity_SpecCube1_HDR',
    'unity_StereoEyeIndex',
    'unity_StereoScaleOffset',
    'unity_StereoMatrixP',
    'unity_StereoMatrixV',
    'unity_StereoMatrixInvV',
    'unity_StereoMatrixVP',
    'unity_StereoCameraProjection',
    'unity_StereoCameraInvProjection',
  ]);

  // HLSL/Unityで頻出する組み込み関数。外部ヘッダーを開いていない場合でも誤警告しない。
  private readonly builtinFunctions = new Set([
    'abs',
    'acos',
    'all',
    'any',
    'asin',
    'atan',
    'atan2',
    'ceil',
    'clamp',
    'clip',
    'cos',
    'cosh',
    'cross',
    'ddx',
    'ddx_coarse',
    'ddx_fine',
    'ddy',
    'ddy_coarse',
    'ddy_fine',
    'degrees',
    'determinant',
    'distance',
    'dot',
    'exp',
    'exp2',
    'floor',
    'fmod',
    'frac',
    'frexp',
    'isfinite',
    'isinf',
    'isnan',
    'ldexp',
    'length',
    'lerp',
    'log',
    'log10',
    'log2',
    'max',
    'min',
    'modf',
    'mul',
    'normalize',
    'pow',
    'radians',
    'reflect',
    'refract',
    'round',
    'rsqrt',
    'saturate',
    'sign',
    'sin',
    'sincos',
    'sinh',
    'smoothstep',
    'sqrt',
    'step',
    'tan',
    'tanh',
    'transpose',
    'trunc',
    'fwidth',
    'GetDimensions',
    'Load',
    'Sample',
    'SampleBias',
    'SampleCmp',
    'SampleCmpLevelZero',
    'SampleGrad',
    'SampleLevel',
    'InterlockedAdd',
    'InterlockedAnd',
    'InterlockedCompareExchange',
    'InterlockedExchange',
    'InterlockedMax',
    'InterlockedMin',
    'InterlockedOr',
    'InterlockedXor',
    'asfloat',
    'asint',
    'asuint',
    'asdouble',
    'asuint2',
    'asuint4',
    'WaveActiveAllTrue',
    'WaveActiveAnyTrue',
    'WaveActiveBallot',
    'WaveActiveCountBits',
    'WaveGetLaneCount',
    'WaveGetLaneIndex',
    'countbits',
    'firstbitlow',
    'firstbithigh',
    'reversebits',
    'rcp',
    'mad',
    'fma',
    'dst',
    'msad4',
    'noise',
    'ldexp',
    'asdouble',
    'f16tof32',
    'f32tof16',
    'pack_clamp',
    'pack_s8',
    'pack_u8',
    'unpack_s8',
    'unpack_u8',
    'CheckAccessFullyMapped',
    'EvaluateAttributeSnapped',
    'EvaluateAttributeCentroid',
    'EvaluateAttributeAtSample',
    'GetRenderTargetSampleCount',
    'GetRenderTargetSamplePosition',
    'GetDimensions',
    'CalculateLevelOfDetail',
    'CalculateLevelOfDetailUnclamped',
    'Gather',
    'GatherRed',
    'GatherGreen',
    'GatherBlue',
    'GatherAlpha',
    'GatherCmp',
    'GatherCmpRed',
    'GatherCmpGreen',
    'GatherCmpBlue',
    'GatherCmpAlpha',
    'NonUniformResourceIndex',
    'QuadReadLaneAt',
    'QuadReadAcrossDiagonal',
    'QuadReadAcrossX',
    'QuadReadAcrossY',
    'QuadAny',
    'QuadAll',
  ]);

  public constructor(private readonly documentManager: DocumentManager) {}

  public provideDiagnostics(uri: string): Diagnostic[] {
    const document = this.documentManager.get(uri);
    const parsed = this.documentManager.getParsed(uri);
    if (!document || !parsed) {
      return [];
    }

    const source = document.getText();
    const lexical = new Tokenizer(source).analyze(document.version);
    const tokens = lexical.tokens.filter((token) => token.kind !== 'eof');
    const hlslRanges = lexical.hlslRanges;
    if (hlslRanges.length === 0 && parsed.ast.kind === 'HlslDocument') {
      hlslRanges.push({ start: 0, end: source.length });
    }

    const diagnostics: Diagnostic[] = [];
    const knownSymbols = this.collectKnownSymbols(uri);
    const declarations = this.collectDeclarations(parsed);
    const structs = this.collectStructs(uri, parsed);
    const seen = new Set<string>();

    const add = (token: Token, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Warning): void => {
      const key = `${token.range.start.offset}|${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      diagnostics.push({
        severity,
        range: {
          start: { line: token.range.start.line, character: token.range.start.character },
          end: { line: token.range.end.line, character: token.range.end.character },
        },
        message,
        source: 'ShaderLab IntelliSense',
      });
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.kind !== 'identifier' || !this.isInsideAnyRange(token.range.start.offset, hlslRanges)) {
        continue;
      }

      const previous = tokens[i - 1];
      const next = tokens[i + 1];

      // 宣言名・型名・メンバー名・include等は未定義変数チェックから除外する。
      if (
        this.isDeclarationToken(token, declarations) ||
        this.isMemberToken(tokens, i) ||
        this.isPreprocessorContext(tokens, i)
      ) {
        continue;
      }

      // float4(...)などの組み込み型コンストラクタは関数呼び出しではない。
      // 型名判定を関数呼び出し判定より先に行う。
      if (
        this.isTypeName(uri, token.value, structs) ||
        this.isSemantic(token.value) ||
        this.isBuiltinMacro(token.value) ||
        this.isBuiltinSymbol(token.value) ||
        this.builtinFunctions.has(token.value) ||
        this.keywords.has(token.value)
      ) {
        continue;
      }

      if (next?.value === '(') {
        this.checkFunctionCall(uri, token, tokens, i, add);
        continue;
      }

      // Swizzleはstructメンバーではないため未定義変数として扱わない。
      if (previous?.value === '.' || this.isLikelyLabel(tokens, i)) {
        continue;
      }

      if (!this.isKnownVariable(uri, token.value, token.range.start.offset, knownSymbols)) {
        add(token, `未定義の変数またはプロパティ '${token.value}' です。`);
      }
    }

    this.checkStructMembers(uri, tokens, hlslRanges, declarations, structs, add);
    return diagnostics;
  }

  private checkFunctionCall(
    uri: string,
    nameToken: Token,
    tokens: Token[],
    nameIndex: number,
    add: (token: Token, message: string, severity?: DiagnosticSeverity) => void,
  ): void {
    const openIndex = nameIndex + 1;
    const closeIndex = this.findMatchingParen(tokens, openIndex);
    if (closeIndex < 0) return;

    const argumentsCount = this.countArguments(tokens, openIndex, closeIndex);
    // オブジェクトのメソッド呼び出し（tex.Sample(...)など）は、通常の関数名検索とは別扱いにする。
    if (tokens[nameIndex - 1]?.value === '.' || tokens[nameIndex - 1]?.value === '->') {
      return;
    }

    if (
      this.isBuiltinMacro(nameToken.value) ||
      this.isBuiltinSymbol(nameToken.value) ||
      this.builtinFunctions.has(nameToken.value)
    ) {
      return;
    }

    const matches = this.documentManager.findByKindInRelated(uri, nameToken.value, 'function');
    // 現在ファイル/到達可能なincludeのどこにも定義がない関数呼び出しも診断する。
    if (matches.length === 0) {
      add(nameToken, `関数 '${nameToken.value}' が定義されていません。`, DiagnosticSeverity.Warning);
      return;
    }

    // 同名関数のオーバーロード（hover上ではoverrideとして扱っているものを含む）を全て候補にして、
    // いずれか1つでも引数個数が一致すれば有効な呼び出しとする。
    const valid = matches.some(
      (match) => match.symbol.kind === 'function' && this.functionParameterCount(match.symbol) === argumentsCount,
    );
    if (!valid) {
      const counts = Array.from(new Set(matches.map((match) => this.functionParameterCount(match.symbol)))).sort(
        (a, b) => a - b,
      );
      add(
        nameToken,
        `'${nameToken.value}' の引数の数が一致しません。指定可能: ${counts.join(', ')}個、実際: ${argumentsCount}個。`,
        DiagnosticSeverity.Error,
      );
    }
  }

  private functionParameterCount(symbol: any): number {
    return symbol.children.filter((child: any) => child.kind === 'parameter').length;
  }

  private checkStructMembers(
    uri: string,
    tokens: Token[],
    hlslRanges: Array<{ start: number; end: number }>,
    declarations: SymbolInfo[],
    structs: Map<string, HlslStructNode>,
    add: (token: Token, message: string, severity?: DiagnosticSeverity) => void,
  ): void {
    for (let i = 0; i < tokens.length - 2; i++) {
      const object = tokens[i];
      if (object.kind !== 'identifier' || !this.isInsideAnyRange(object.range.start.offset, hlslRanges)) continue;
      if (tokens[i + 1]?.value !== '.' || tokens[i + 2]?.kind !== 'identifier') continue;
      const member = tokens[i + 2];

      if (this.isSwizzle(member.value)) continue;

      const objectType = this.findObjectType(uri, object.value, object.range.start.offset, declarations);
      if (!objectType) continue;
      const normalized = this.normalizeType(objectType);
      const struct = structs.get(normalized);
      if (struct) {
        const exists = struct.fields.some((field) => field.name.toLowerCase() === member.value.toLowerCase());
        if (!exists) {
          add(
            member,
            `構造体 '${struct.name}' にメンバー '${member.value}' は存在しません。`,
            DiagnosticSeverity.Error,
          );
        }
        continue;
      }

      if (this.isBuiltinVector(normalized) || this.isBuiltinMatrix(normalized)) {
        // 組み込みベクトル/行列はswizzleや添字を言語側で扱うため、ここでは警告しない。
        continue;
      }

      const builtinMembers = this.getBuiltinResourceMembers(normalized);
      if (builtinMembers && !builtinMembers.has(member.value)) {
        add(member, `型 '${objectType}' にメンバー '${member.value}' は存在しません。`, DiagnosticSeverity.Error);
      }
    }
  }

  private collectKnownSymbols(uri: string): SymbolInfo[] {
    const matches = this.documentManager.findPrefixInRelated(uri, '');
    return matches.map((match) => ({
      name: match.symbol.name,
      typeName: match.symbol.typeName,
      kind: match.symbol.kind,
      range: match.symbol.location.range,
    }));
  }

  private collectDeclarations(parsed: ParsedDocument): SymbolInfo[] {
    const result: SymbolInfo[] = [];
    const visitHlsl = (hlsl: HlslDocumentNode): void => {
      for (const declaration of hlsl.declarations) {
        if (declaration.kind === 'HlslVariable') {
          result.push({
            name: declaration.name,
            typeName: declaration.typeName,
            kind: 'variable',
            range: declaration.range,
            scope: declaration.scope,
          });
        } else if (declaration.kind === 'HlslFunction') {
          result.push({ name: declaration.name, kind: 'function', range: declaration.range });
          for (const parameter of declaration.parameters) {
            result.push({
              name: parameter.name,
              typeName: parameter.typeName,
              kind: 'parameter',
              range: parameter.range,
              scope: declaration.range,
            });
          }
          for (const local of declaration.locals) {
            result.push({
              name: local.name,
              typeName: local.typeName,
              kind: 'variable',
              range: local.range,
              scope: local.scope,
            });
          }
        } else if (declaration.kind === 'HlslStruct') {
          result.push({ name: declaration.name, kind: 'struct', range: declaration.range });
          for (const field of declaration.fields) {
            result.push({ name: field.name, typeName: field.typeName, kind: 'field', range: field.range });
          }
        } else if (declaration.kind === 'HlslCBuffer') {
          result.push({ name: declaration.name, kind: 'cbuffer', range: declaration.range });
          for (const field of declaration.fields) {
            result.push({ name: field.name, typeName: field.typeName, kind: 'field', range: field.range });
          }
        }
      }
    };
    const visitShader = (shader: ShaderDocumentNode): void => {
      for (const block of shader.hlslBlocks) visitHlsl(block.hlsl);
      for (const subShader of shader.subShaders) {
        for (const block of subShader.hlslBlocks) visitHlsl(block.hlsl);
        for (const pass of subShader.passes) for (const block of pass.hlslBlocks) visitHlsl(block.hlsl);
      }
    };
    if (parsed.ast.kind === 'HlslDocument') visitHlsl(parsed.ast);
    else visitShader(parsed.ast);
    return result;
  }

  private collectStructs(uri: string, parsed: ParsedDocument): Map<string, HlslStructNode> {
    const result = new Map<string, HlslStructNode>();
    const add = (hlsl: HlslDocumentNode): void => {
      for (const declaration of hlsl.declarations) {
        if (declaration.kind === 'HlslStruct') {
          result.set(declaration.name.toLowerCase(), declaration);
        }
      }
    };
    if (parsed.ast.kind === 'HlslDocument') add(parsed.ast);
    else {
      add(parsed.ast.hlslBlocks[0]?.hlsl ?? { kind: 'HlslDocument', declarations: [], range: parsed.ast.range });
      for (const sub of parsed.ast.subShaders) {
        for (const block of sub.hlslBlocks) add(block.hlsl);
        for (const pass of sub.passes) for (const block of pass.hlslBlocks) add(block.hlsl);
      }
    }

    // include先のstructも検索対象にする。
    for (const match of this.documentManager.findPrefixInRelated(uri, '')) {
      if (match.symbol.kind !== 'struct') continue;
      if (match.symbol.name) {
        const external = this.documentManager.getParsed(match.uri);
        if (external?.ast.kind === 'HlslDocument') {
          const node = external.ast.declarations.find(
            (declaration) =>
              declaration.kind === 'HlslStruct' && declaration.name.toLowerCase() === match.symbol.name.toLowerCase(),
          );
          if (node && node.kind === 'HlslStruct') result.set(node.name.toLowerCase(), node);
        }
      }
    }
    return result;
  }

  private findObjectType(uri: string, name: string, offset: number, declarations: SymbolInfo[]): string | undefined {
    const candidates = declarations.filter((entry) => entry.name === name && entry.typeName);
    let best: SymbolInfo | undefined;
    for (const entry of candidates) {
      if (entry.range.start.offset > offset) continue;
      if (entry.scope && (offset < entry.scope.start.offset || offset > entry.scope.end.offset)) continue;
      if (!best || entry.range.start.offset > best.range.start.offset) best = entry;
    }
    if (best?.typeName) return best.typeName;

    const related = this.documentManager
      .findExactInRelated(uri, name)
      .filter((match) => ['variable', 'parameter', 'field', 'property'].includes(match.symbol.kind));
    return related[0]?.symbol.typeName;
  }

  private isKnownVariable(uri: string, name: string, offset: number, symbols: SymbolInfo[]): boolean {
    // DocumentManager側のローカル関数索引を利用する。ShaderLab埋め込みHLSLでは
    // ASTのscope情報だけに依存すると、ブロック変換後の位置関係によってローカル変数を取りこぼす場合がある。
    if (this.documentManager.findLocalVariable(uri, name, offset)) {
      return true;
    }

    return symbols.some((symbol) => {
      if (symbol.name !== name) return false;
      if (symbol.range.start.offset <= offset && (!symbol.scope || offset <= symbol.scope.end.offset)) return true;
      return (
        symbol.kind === 'property' || symbol.kind === 'variable' || symbol.kind === 'field' || symbol.kind === 'cbuffer'
      );
    });
  }

  private isDeclarationToken(token: Token, declarations: SymbolInfo[]): boolean {
    return declarations.some(
      (declaration) =>
        declaration.range.start.offset <= token.range.start.offset &&
        token.range.start.offset <= declaration.range.end.offset &&
        declaration.name === token.value,
    );
  }

  private isMemberToken(tokens: Token[], index: number): boolean {
    return tokens[index - 1]?.value === '.' || tokens[index - 1]?.value === '->';
  }

  private isPreprocessorContext(tokens: Token[], index: number): boolean {
    let line = tokens[index].range.start.line;
    for (let i = index - 1; i >= 0; i--) {
      if (tokens[i].range.start.line !== line) break;
      if (tokens[i].value === '#') return true;
    }
    return false;
  }

  private isLikelyLabel(tokens: Token[], index: number): boolean {
    return tokens[index + 1]?.value === ':';
  }

  private isBuiltinMacro(name: string): boolean {
    if (this.builtinMacros.has(name)) return true;

    // Unityのヘッダーはバージョンやレンダーパイプラインによって大量のUNITY_/SHADER_マクロを定義する。
    // 個別列挙だけでは取りこぼすため、明確に組み込み名前空間と判断できるものをまとめて除外する。
    return /^(UNITY_|SHADER_|PLATFORM_|STEREO_|XR_|TEXTURE\dD|TEXTURECUBE|SAMPLER\d?D|SAMPLE_TEXTURE|LOAD_TEXTURE|DECLARE_TEX|DECLARE_SAMPLER)/.test(
      name,
    );
  }

  private isBuiltinSymbol(name: string): boolean {
    if (this.builtinSymbols.has(name)) return true;

    // Unityの組み込みグローバルには大量のバージョン依存シンボルがあるため、既知の名前空間も許可する。
    return (
      /^unity_[A-Za-z0-9_]+$/.test(name) || /^UNITY_MATRIX_[A-Za-z0-9_]+$/.test(name) || /^UNITY_[A-Z0-9_]+$/.test(name)
    );
  }

  private isTypeName(uri: string, name: string, structs: Map<string, HlslStructNode>): boolean {
    return (
      this.builtinTypes.has(name) ||
      structs.has(name.toLowerCase()) ||
      this.documentManager.findExactInRelated(uri, name).some((match) => match.symbol.kind === 'struct')
    );
  }

  private isSemantic(name: string): boolean {
    return (
      /^SV_[A-Z0-9_]+$/.test(name) ||
      /^(POSITION|NORMAL|TANGENT|BINORMAL|BLENDINDICES|BLENDWEIGHT|TEXCOORD|COLOR|PSIZE|FOG)\d*$/.test(name)
    );
  }

  private isSwizzle(name: string): boolean {
    if (name.length < 1 || name.length > 4) return false;
    return [...name.toLowerCase()].every((c) => 'xyzwrgba'.includes(c));
  }

  private normalizeType(typeName: string): string {
    return typeName
      .replace(/\b(const|static|uniform|in|out|inout|volatile)\b/g, '')
      .replace(/\s+/g, '')
      .replace(/<.*>$/, '')
      .toLowerCase();
  }

  private isBuiltinVector(type: string): boolean {
    return /^(bool|int|uint|half|float|double|min10float|min16float|min16int|min16uint)[1-4]$/.test(type);
  }

  private isBuiltinMatrix(type: string): boolean {
    return /^(bool|int|uint|half|float|double|min10float|min16float|min16int|min16uint)[1-4]x[1-4]$/.test(type);
  }

  private getBuiltinResourceMembers(type: string): Set<string> | undefined {
    if (/^rw?texture(1d|2d|3d|cube|1darray|2darray|cubearray)(ms)?$/i.test(type)) {
      return new Set([
        'Sample',
        'SampleBias',
        'SampleGrad',
        'SampleLevel',
        'SampleCmp',
        'SampleCmpLevelZero',
        'Load',
        'GetDimensions',
      ]);
    }
    if (
      /^(rw)?(buffer|structuredbuffer|byteaddressbuffer|appendstructuredbuffer|consumestructuredbuffer|rasterizerorderedbuffer|rasterizerorderedbyteaddressbuffer|rasterizerorderedstructuredbuffer)$/i.test(
        type,
      )
    ) {
      return new Set(['Load', 'GetDimensions']);
    }
    return undefined;
  }

  private isInsideAnyRange(offset: number, ranges: Array<{ start: number; end: number }>): boolean {
    return ranges.some((range) => offset >= range.start && offset <= range.end);
  }

  private findMatchingParen(tokens: Token[], openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < tokens.length; i++) {
      if (tokens[i].value === '(') depth++;
      else if (tokens[i].value === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private countArguments(tokens: Token[], openIndex: number, closeIndex: number): number {
    if (closeIndex === openIndex + 1) return 0;
    let depth = 0;
    let count = 1;
    for (let i = openIndex + 1; i < closeIndex; i++) {
      const value = tokens[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') depth--;
      else if (value === ',' && depth === 0) count++;
    }
    return count;
  }
}
