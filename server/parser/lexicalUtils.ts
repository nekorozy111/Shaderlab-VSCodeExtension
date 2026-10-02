import { LexicalAnalysis, OffsetRange } from './tokenizer';

export function containsOffset(ranges: OffsetRange[], offset: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (offset < range.start) {
      high = middle - 1;
    } else if (offset >= range.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

export function isInsideComment(lexical: LexicalAnalysis, offset: number): boolean {
  return containsOffset(lexical.commentRanges, offset);
}

export function isInsideString(lexical: LexicalAnalysis, offset: number): boolean {
  return containsOffset(lexical.stringRanges, offset);
}

type SourceLexicalContext = {
  inComment: boolean;
  inString: boolean;
};

/**
 * 現在位置のコメント/文字列状態だけを局所走査する。
 * 編集直後のLSP requestでファイル全体をTokenizerへ通さないために使う。
 */
export function getSourceLexicalContextAtOffset(source: string, offset: number): SourceLexicalContext {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  if (safeOffset === 0) {
    return { inComment: false, inString: false };
  }

  const lineStart = source.lastIndexOf('\n', safeOffset - 1) + 1;

  const isActiveBlockDelimiter = (delimiterOffset: number): boolean => {
    const delimiterLineStart = source.lastIndexOf('\n', Math.max(0, delimiterOffset - 1)) + 1;
    let inStringOnLine = false;
    let quote = '';
    let inLineCommentOnLine = false;

    for (let index = delimiterLineStart; index < delimiterOffset; index++) {
      const current = source[index];
      const next = index + 1 < delimiterOffset ? source[index + 1] : '';
      if (inLineCommentOnLine) {
        return false;
      }
      if (inStringOnLine) {
        if (current === '\\') {
          index++;
          continue;
        }
        if (current === quote) {
          inStringOnLine = false;
          quote = '';
        }
        continue;
      }
      if (current === '/' && next === '/') {
        inLineCommentOnLine = true;
        return false;
      }
      if (current === '"' || current === "'") {
        inStringOnLine = true;
        quote = current;
      }
    }

    return !inStringOnLine;
  };

  // 文字列や行コメント中に書かれた見かけ上のデリミタを除外する。
  let lastOpen = source.lastIndexOf('/*', Math.max(0, lineStart - 1));
  while (lastOpen >= 0 && !isActiveBlockDelimiter(lastOpen)) {
    lastOpen = source.lastIndexOf('/*', Math.max(0, lastOpen - 1));
  }
  let lastClose = source.lastIndexOf('*/', Math.max(0, lineStart - 1));
  while (lastClose >= 0 && !isActiveBlockDelimiter(lastClose)) {
    lastClose = source.lastIndexOf('*/', Math.max(0, lastClose - 1));
  }
  let inBlockComment = lastOpen > lastClose;
  let inLineComment = false;
  let inString = false;
  let quote = '';

  // 通常の編集では現在行が十分短いため、現在行だけを走査して応答時間を抑える。
  for (let index = lineStart; index < safeOffset; index++) {
    const current = source[index];
    const next = index + 1 < safeOffset ? source[index + 1] : '';

    if (inLineComment) {
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inString) {
      if (current === '\\') {
        index++;
        continue;
      }
      if (current === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      index++;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
    }
  }

  return {
    inComment: inLineComment || inBlockComment,
    inString,
  };
}
