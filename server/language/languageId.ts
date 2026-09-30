import * as path from 'path';

/**
 * エディターと言語サーバーで使用する言語ID。
 *
 * Unityのエディター連携では、.shader に `UnityShader` を割り当てることがある。
 * さらに .hlsl と .compute にも同じIDが割り当てられるため、languageId だけでは
 * ドキュメントがShaderLabか単独HLSLかを判定できない。
 */
export function isUnityShaderLanguage(languageId: string | undefined): boolean {
  return languageId === 'shaderlab' || languageId === 'UnityShader';
}

/**
 * パーサーとProviderで使用するソース言語を返す。
 *
 * UnityShaderドキュメントではURIの拡張子を優先して判定する。
 *   .shader  -> ShaderLab
 *   .hlsl    -> HLSL
 *   .hlsli   -> HLSL
 *   .compute -> HLSL/Compute source
 *
 * 明示的な言語IDも、拡張機能または言語サーバー自身によって開かれた
 * ドキュメントでは引き続き使用できる。
 */
export function getSourceLanguage(
  uri: string | undefined,
  languageId: string | undefined,
): 'shaderlab' | 'hlsl' | undefined {
  const extension = getUriExtension(uri);
  if (extension === '.shader') {
    return 'shaderlab';
  }

  if (extension === '.hlsl' || extension === '.hlsli' || extension === '.compute' || extension === '.cginc') {
    return 'hlsl';
  }

  if (languageId === 'shaderlab') {
    return 'shaderlab';
  }

  if (languageId === 'hlsl' || languageId === 'hlsli' || languageId === 'compute') {
    return 'hlsl';
  }

  return undefined;
}

export function isShaderLabDocument(uri: string | undefined, languageId: string | undefined): boolean {
  return getSourceLanguage(uri, languageId) === 'shaderlab';
}

export function isHlslDocument(uri: string | undefined, languageId: string | undefined): boolean {
  return getSourceLanguage(uri, languageId) === 'hlsl';
}

function getUriExtension(uri: string | undefined): string {
  if (!uri) {
    return '';
  }

  try {
    // file:///C:/.../foo.compute -> C:/.../foo.compute
    const value = decodeURIComponent(uri.split('#', 1)[0].split('?', 1)[0]);
    return path.extname(value).toLowerCase();
  } catch {
    return path.extname(uri).toLowerCase();
  }
}
