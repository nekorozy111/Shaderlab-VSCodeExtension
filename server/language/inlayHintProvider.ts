import { InlayHint, InlayHintKind, Position } from 'vscode-languageserver/node';
import { Token } from '../parser/token';
import { Tokenizer } from '../parser/tokenizer';
import { DocumentManager } from './documentManager';

export class InlayHintProvider {
  public constructor(private readonly documentManager: DocumentManager) {}

  public provideInlayHints(uri: string): InlayHint[] {
    const document = this.documentManager.get(uri);
    if (!document) return [];

    const source = document.getText();
    const lexical = new Tokenizer(source).analyze(document.version);
    const tokens = lexical.tokens.filter((token) => token.kind !== 'eof');
    const ranges = lexical.hlslRanges.length > 0 ? lexical.hlslRanges : [{ start: 0, end: source.length }];
    const hints: InlayHint[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const functionToken = tokens[i];
      if (
        functionToken.kind !== 'identifier' ||
        tokens[i + 1]?.value !== '(' ||
        !ranges.some(
          (range) => functionToken.range.start.offset >= range.start && functionToken.range.start.offset <= range.end,
        )
      ) {
        continue;
      }

      const closeIndex = this.findMatchingParen(tokens, i + 1);
      if (closeIndex < 0) continue;

      const functionMatches = this.documentManager
        .findByKindInRelated(uri, functionToken.value, 'function')
        .filter((match) => match.symbol.kind === 'function');
      if (functionMatches.length === 0) continue;

      // 関数定義・宣言側ではInlay Hintを表示せず、関数呼び出し側だけを対象にする。
      if (this.isFunctionDeclaration(tokens, i, closeIndex, functionMatches)) continue;

      const parameterQualifiers = this.getParameterQualifiers(functionMatches);
      if (parameterQualifiers.length === 0) continue;

      const argumentStarts = this.getArgumentStarts(tokens, i + 1, closeIndex);
      for (let argumentIndex = 0; argumentIndex < argumentStarts.length; argumentIndex++) {
        const qualifier = parameterQualifiers[argumentIndex];
        if (!qualifier) continue;

        const argumentToken = argumentStarts[argumentIndex];
        hints.push({
          position: {
            line: argumentToken.range.start.line,
            character: argumentToken.range.start.character,
          },
          // 修飾子だけを表示し、角括弧は付けない。背景色はVS CodeのParameter用Inlay Hintテーマ色を使用する。
          label: `${qualifier}:`,
          kind: InlayHintKind.Parameter,
          paddingLeft: true,
          paddingRight: false,
        });
      }
    }

    return hints;
  }

  private isFunctionDeclaration(
    tokens: Token[],
    functionIndex: number,
    closeIndex: number,
    matches: Array<{ symbol: any }>,
  ): boolean {
    const next = tokens[closeIndex + 1];
    if (!next || (next.value !== '{' && next.value !== ';')) {
      return false;
    }

    const previous = tokens[functionIndex - 1];
    if (!previous || previous.kind !== 'identifier') {
      return false;
    }

    // 戻り値型が組み込み型または該当関数の戻り値型と一致する場合は、
    // 「型名 関数名(...)」という関数定義・宣言として扱う。
    const builtinTypes = new Set([
      'void',
      'bool',
      'int',
      'uint',
      'half',
      'float',
      'double',
      'float2',
      'float3',
      'float4',
      'float2x2',
      'float3x3',
      'float4x4',
      'half2',
      'half3',
      'half4',
      'int2',
      'int3',
      'int4',
      'uint2',
      'uint3',
      'uint4',
    ]);
    if (builtinTypes.has(previous.value)) {
      return true;
    }

    return matches.some((match) => match.symbol.returnType === previous.value);
  }

  private getParameterQualifiers(
    matches: Array<{ symbol: any }>,
  ): Array<'in' | 'out' | 'inout' | 'uniform' | undefined> {
    // オーバーロードがある場合、修飾子の位置が共通する候補だけを表示する。
    const first = matches[0]?.symbol;
    if (!first) return [];
    const maxLength = Math.max(
      ...matches.map((match) => match.symbol.children.filter((child: any) => child.kind === 'parameter').length),
    );
    const result: Array<'in' | 'out' | 'inout' | 'uniform' | undefined> = [];

    for (let index = 0; index < maxLength; index++) {
      const qualifiers = matches
        .map((match) => match.symbol.children.filter((child: any) => child.kind === 'parameter')[index]?.qualifier)
        .filter((value) => value !== undefined);
      if (qualifiers.length === 0) {
        result.push(undefined);
      } else {
        const unique = new Set(qualifiers);
        result.push(unique.size === 1 ? qualifiers[0] : undefined);
      }
    }
    return result;
  }

  private getArgumentStarts(tokens: Token[], openIndex: number, closeIndex: number): Token[] {
    if (closeIndex === openIndex + 1) return [];
    const result: Token[] = [];
    let depth = 0;
    let expectingArgument = true;

    for (let i = openIndex + 1; i < closeIndex; i++) {
      const token = tokens[i];
      if (expectingArgument && token.value !== ',') {
        result.push(token);
        expectingArgument = false;
      }

      if (token.value === '(' || token.value === '[' || token.value === '{') {
        depth++;
      } else if (token.value === ')' || token.value === ']' || token.value === '}') {
        depth--;
      } else if (token.value === ',' && depth === 0) {
        expectingArgument = true;
      }
    }

    return result;
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
}
