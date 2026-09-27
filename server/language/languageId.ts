import * as path from 'path';

/**
 * Language IDs used by the editor and the language server.
 *
 * Unity's editor integration commonly assigns `UnityShader` to .shader,
 * .hlsl and .compute alike. Therefore languageId alone cannot tell us
 * whether a document is ShaderLab or standalone HLSL.
 */
export function isUnityShaderLanguage(languageId: string | undefined): boolean {
  return languageId === 'shaderlab' || languageId === 'UnityShader';
}

/**
 * Returns the source language that should be used by the parser/providers.
 *
 * For UnityShader documents the URI extension is authoritative:
 *   .shader  -> ShaderLab
 *   .hlsl    -> HLSL
 *   .hlsli   -> HLSL
 *   .compute -> HLSL/Compute source
 *
 * Explicit language IDs remain supported for documents opened by this
 * extension or by the language server itself.
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

export function isShaderLabDocument(
  uri: string | undefined,
  languageId: string | undefined,
): boolean {
  return getSourceLanguage(uri, languageId) === 'shaderlab';
}

export function isHlslDocument(
  uri: string | undefined,
  languageId: string | undefined,
): boolean {
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
