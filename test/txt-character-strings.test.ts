import { describe, expect, it } from 'vitest';
import {
  TXT_CHARACTER_STRING_BYTE_LIMIT,
  TxtCharacterStringError,
  splitTxtCharacterStrings
} from '../src/domain/publish-plan';

const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe('splitTxtCharacterStrings', () => {
  it.each([
    ['one byte below the limit', 'a'.repeat(254), [254]],
    ['exactly at the limit', 'a'.repeat(255), [255]],
    ['one byte above the limit', 'a'.repeat(256), [255, 1]]
  ])('splits ASCII %s', (_case, payload, expectedByteLengths) => {
    const parts = splitTxtCharacterStrings(payload);

    expect(parts.map(byteLength)).toEqual(expectedByteLengths);
    expect(parts.join('')).toBe(payload);
    expect(Object.isFrozen(parts)).toBe(true);
  });

  it('splits Persian, emoji, combining marks, quotes, and backslashes only between code points', () => {
    const payload = ('فارسی😀é"\\').repeat(100);

    const parts = splitTxtCharacterStrings(payload);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => byteLength(part) <= TXT_CHARACTER_STRING_BYTE_LIMIT)).toBe(true);
    expect(parts.join('')).toBe(payload);
    expect(parts.every((part) => !part.includes('\uFFFD'))).toBe(true);
  });

  it('keeps an empty TXT payload as one empty character-string', () => {
    expect(splitTxtCharacterStrings('')).toEqual(['']);
  });

  it('rejects runtime-invalid input without coercion', () => {
    expect(() => splitTxtCharacterStrings(null as unknown as string)).toThrowError(
      expect.objectContaining<Partial<TxtCharacterStringError>>({ code: 'invalid_payload' })
    );
  });
});
