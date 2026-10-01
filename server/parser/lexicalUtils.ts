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
