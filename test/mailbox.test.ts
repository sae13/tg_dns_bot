import { describe, expect, it } from 'vitest';
import { MailboxConfigError, canonicalizeMailbox, createAllowedZoneMap, resolveMailbox } from '../src/domain/mailbox';

describe('canonicalizeMailbox', () => {
  it.each([
    ['BoX.Example.COM.', 'box.example.com'],
    ['bücher.example.', 'xn--bcher-kva.example'],
    ['XN--BCHER-KVA.Example', 'xn--bcher-kva.example'],
    ['example。com。', 'example.com'],
    ['نامه\u200cای.example', 'xn--mgba3gch31f060k.example'],
    ['xn--mgba3gch31f060k.example', 'xn--mgba3gch31f060k.example']
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(canonicalizeMailbox(input)).toBe(expected);
  });

  it.each([
    '', '.', '..', 'box..example.com', '-box.example.com', 'box-.example.com',
    'box_example.com', 'https://box.example.com', 'box.example.com/path',
    '127.0.0.1', '2001:db8::1', '[2001:db8::1]', 'box.example.com..',
    'example.com。.', 'example.com．.', 'example.com｡.',
    'xn--ls8h.example', 'xn--n3h.example', 'ab--cd.example', 'xn--a.example',
    'a\u200bb.example.com', 'a\ufeffb.example.com', 'a\u2060b.example.com',
    `${'a'.repeat(64)}.example.com`, `${'a.'.repeat(126)}aaaa`
  ])('rejects an invalid mailbox FQDN: %j', (input) => {
    expect(canonicalizeMailbox(input)).toBeNull();
  });
});

describe('resolveMailbox', () => {
  const zones = createAllowedZoneMap([
    ['Example.COM.', 'zone-example'],
    ['bücher.example', 'zone-idn']
  ]);

  it.each([
    ['example.com', 'example.com', 'zone-example'],
    ['Box.Example.COM.', 'box.example.com', 'zone-example'],
    ['shop.bücher.example', 'shop.xn--bcher-kva.example', 'zone-idn'],
    ['shop.xn--bcher-kva.example.', 'shop.xn--bcher-kva.example', 'zone-idn']
  ])('routes %s on a DNS label boundary', (input, fqdn, zoneId) => {
    expect(resolveMailbox(input, zones)).toEqual({ fqdn, zoneId });
  });

  it.each([
    'evil-example.com', 'example.com.evil', 'notexample.com', 'https://example.com',
    '127.0.0.1', 'bad_label.example.com', 'other.example'
  ])('rejects invalid, lookalike, or unauthorized names: %s', (input) => {
    expect(resolveMailbox(input, zones)).toBeNull();
  });

  it('rejects duplicate suffixes after canonicalization', () => {
    expect(() => createAllowedZoneMap([['Example.COM', 'zone-a'], ['example.com.', 'zone-b']]))
      .toThrow(MailboxConfigError);
  });

  it('rejects overlapping suffixes to keep zone selection unambiguous', () => {
    expect(() => createAllowedZoneMap([['example.com', 'zone-a'], ['child.example.com', 'zone-b']]))
      .toThrow(MailboxConfigError);
  });

  it.each<readonly (readonly [string, string])[][]>([
    [[['https://example.com', 'zone']]],
    [[['example.com', '']]],
    [[]]
  ])('rejects an invalid zone mapping: %j', (mapping) => {
    expect(() => createAllowedZoneMap(mapping)).toThrow(MailboxConfigError);
  });
});
