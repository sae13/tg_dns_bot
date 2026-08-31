import { describe, expect, it } from 'vitest';
import { renderInboxState, splitTelegramText } from '../src/adapters/telegram-inbox-renderer';
import type { InboxState } from '../src/application/reconstruct-inbox';

const completeState: InboxState = {
  status: 'complete',
  name: 'box.example',
  message: {
    v: 1,
    id: '123e4567-e89b-42d3-a456-426614174000',
    n: 1,
    uid: 42,
    username: 'sender',
    ts: '2026-08-30T12:15:12.345Z',
    text: 'سلام <world> `raw`'
  },
  chunks: [{
    v: 1,
    id: '123e4567-e89b-42d3-a456-426614174000',
    i: 1,
    n: 1,
    uid: 42,
    username: 'sender',
    ts: '2026-08-30T12:15:12.345Z',
    text: 'سلام <world> `raw`'
  }],
  queries: [{
    name: 'box.example',
    resolution: {
      status: 'found',
      records: [{ name: 'box.example', ttl: 60, value: 'tgdn1:wire' }]
    }
  }],
  malformed: []
};

describe('telegram inbox renderer', () => {
  it('renders complete managed identity, canonical timestamp, raw text, and raw records plainly', () => {
    const rendered = renderInboxState(completeState);
    expect(rendered).toContain('کامل');
    expect(rendered).toContain('box.example');
    expect(rendered).toContain('123e4567-e89b-42d3-a456-426614174000');
    expect(rendered).toContain('42');
    expect(rendered).toContain('sender');
    expect(rendered).toContain('2026-08-30T12:15:12.345Z');
    expect(rendered).toContain('سلام <world> `raw`');
    expect(rendered).toContain('tgdn1:wire');
    expect(rendered).not.toContain('parse_mode');
  });

  it('states that an absent sender username is unavailable without changing identity or UTC time', () => {
    const rendered = renderInboxState({
      ...completeState,
      message: { ...completeState.message, username: null }
    });
    expect(rendered).toContain('شناسه فرستنده:');
    expect(rendered).toContain('\n42\n');
    expect(rendered).toContain('نام کاربری:');
    expect(rendered).toContain('ندارد');
    expect(rendered).toContain('\n2026-08-30T12:15:12.345Z\n');
  });

  it('preserves every raw record and formatting-like character exactly in ambiguous evidence', () => {
    const rawValues = ['<b>عمومی</b>', '*markdown* _raw_ `code`', 'نقلقول " و ممیز \\\\'];
    const rendered = renderInboxState({
      status: 'ambiguous',
      name: 'box.example',
      roots: [completeState.chunks[0]!],
      queries: [{
        name: 'box.example',
        resolution: {
          status: 'found',
          records: rawValues.map((value, index) => ({ name: 'box.example', ttl: 60 + index, value }))
        }
      }],
      malformed: []
    });
    rawValues.forEach((value) => expect(rendered).toContain(`\n${value}\n`));
  });

  it('keeps all five inbox states distinct and includes reconstruction problems', () => {
    const states: InboxState[] = [
      { status: 'absent', reason: 'nodata', name: 'box.example', queries: [], malformed: [] },
      { status: 'raw_only', name: 'box.example', queries: [], malformed: [] },
      completeState,
      { status: 'ambiguous', name: 'box.example', roots: [], queries: [], malformed: [] },
      {
        status: 'incomplete',
        name: 'box.example',
        manifest: completeState.chunks[0]!,
        chunks: [completeState.chunks[0]!],
        queries: [],
        malformed: [],
        problems: [{ kind: 'missing_chunk', index: 2, name: '2.box.example' }]
      }
    ];
    const outputs = states.map((state) => renderInboxState(state));
    expect(outputs.every((output) => output.length > 0)).toBe(true);
    expect(new Set(outputs).size).toBe(5);
    expect(outputs[4]).toContain('2.box.example');
  });

  it('keeps generated Persian labels separate from LTR status, identity, and problem values', () => {
    const rendered = renderInboxState({
      status: 'incomplete',
      name: 'box.example',
      manifest: completeState.chunks[0]!,
      chunks: [completeState.chunks[0]!],
      queries: [{ name: 'box.example', resolution: { status: 'nodata' } }],
      malformed: [],
      problems: [{ kind: 'missing_chunk', index: 2, name: '2.box.example' }]
    });

    expect(rendered).not.toMatch(/[\u0600-\u06ff].*(?:raw_only|incomplete|nodata|box\.example|\b\d+\b)/u);
    expect(rendered).not.toMatch(/(?:raw_only|incomplete|nodata|box\.example|\b\d+\b).*[\u0600-\u06ff]/u);
    expect(rendered).toContain('\n2.box.example\n');
    expect(rendered).toContain('\n2026-08-30T12:15:12.345Z\n');
  });

  it.each([4_095, 4_096])('keeps a %i-code-point response in one unnumbered message', (length) => {
    const source = 'ش'.repeat(length);
    expect(splitTelegramText(source)).toEqual([source]);
  });

  it('numbers a response one code point over the limit and restores every code point exactly', () => {
    const source = `${'ش'.repeat(4_095)}🙂م`;
    const chunks = splitTelegramText(source);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/^\[1\/2\]\n/u);
    expect(chunks[1]).toMatch(/^\[2\/2\]\n/u);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 4_096)).toBe(true);
    expect(chunks.map(stripChunkHeader).join('')).toBe(source);
  });

  it('splits long Unicode text into ordered numbered chunks without code-point loss', () => {
    const source = '🙂الف'.repeat(2_000);
    const chunks = splitTelegramText(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 4_096)).toBe(true);
    expect(chunks.map(stripChunkHeader).join('')).toBe(source);
  });
});

function stripChunkHeader(chunk: string): string {
  return chunk.replace(/^\[\d+\/\d+\]\n/u, '');
}
