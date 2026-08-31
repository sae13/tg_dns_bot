import { decode as decodePunycode, encode as encodePunycode } from '../../vendor/punycode.mjs';

export interface AllowedZone {
  readonly suffix: string;
  readonly zoneId: string;
}

export type AllowedZoneMap = readonly AllowedZone[];

export interface ResolvedMailbox {
  readonly fqdn: string;
  readonly zoneId: string;
}

export class MailboxConfigError extends Error {
  constructor() {
    super('Invalid allowed zone mapping');
    this.name = 'MailboxConfigError';
  }
}

const FORBIDDEN_HOST_CHARACTERS = '/\\:@?#[]%';
const ASCII_HOSTNAME = /^[a-z0-9.-]+$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IDNA_DOTS = /[。．｡]/gu;

export function canonicalizeMailbox(input: string): string | null {
  if (input.length === 0 || hasForbiddenHostCharacter(input)) return null;

  let candidate = input.replace(IDNA_DOTS, '.');
  if (candidate.endsWith('.')) candidate = candidate.slice(0, -1);
  if (candidate.length === 0 || candidate.endsWith('.')) return null;

  let hostname: string;
  try {
    hostname = new URL(`http://${candidate}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname.length === 0 || hostname.length > 253 || !ASCII_HOSTNAME.test(hostname) || IPV4_ADDRESS.test(hostname)) {
    return null;
  }

  const labels = hostname.split('.');
  if (labels.some((label) => !isValidAsciiLabel(label))) return null;
  return hostname;
}

export function createAllowedZoneMap(entries: readonly (readonly [string, string])[]): AllowedZoneMap {
  const zones: AllowedZone[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new MailboxConfigError();
    const [rawSuffix, rawZoneId] = entry;
    if (typeof rawSuffix !== 'string' || typeof rawZoneId !== 'string') throw new MailboxConfigError();
    const suffix = canonicalizeMailbox(rawSuffix);
    const zoneId = rawZoneId.trim();
    if (suffix === null || zoneId.length === 0 || seen.has(suffix)) throw new MailboxConfigError();
    if (zones.some((zone) => isWithinSuffix(suffix, zone.suffix) || isWithinSuffix(zone.suffix, suffix))) {
      throw new MailboxConfigError();
    }
    seen.add(suffix);
    zones.push({ suffix, zoneId });
  }

  if (zones.length === 0) throw new MailboxConfigError();
  return zones;
}

export function resolveMailbox(input: string, zones: AllowedZoneMap): ResolvedMailbox | null {
  const fqdn = canonicalizeMailbox(input);
  if (fqdn === null) return null;
  const zone = zones.find((candidate) => isWithinDelegatedSuffix(fqdn, candidate.suffix));
  return zone === undefined ? null : { fqdn, zoneId: zone.zoneId };
}

function isValidAsciiLabel(label: string): boolean {
  if (!DNS_LABEL.test(label) || label.length > 63) return false;
  if (label.length >= 4 && label[2] === '-' && label[3] === '-' && !label.startsWith('xn--')) return false;
  if (!label.startsWith('xn--')) return true;

  try {
    const payload = label.slice(4);
    const unicode = decodePunycode(payload);
    if (unicode.length === 0 || `xn--${encodePunycode(unicode).toLowerCase()}` !== label) return false;
    return [...unicode].every(isAllowedIdnCodePoint) && hasValidJoiners(unicode);
  } catch {
    return false;
  }
}

function isAllowedIdnCodePoint(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  if (codePoint === 0x200c || codePoint === 0x200d) return true;
  if (codePoint < 0x80) return /[a-z0-9-]/u.test(character);
  return /[\p{L}\p{M}\p{Nd}]/u.test(character) && !/\p{Default_Ignorable_Code_Point}/u.test(character);
}

function hasValidJoiners(label: string): boolean {
  const characters = [...label];
  return characters.every((character, index) => {
    if (character !== '\u200c' && character !== '\u200d') return true;
    const previous = characters[index - 1];
    const next = characters[index + 1];
    return previous !== undefined && next !== undefined && /\p{L}/u.test(previous) && /\p{L}/u.test(next);
  });
}

function isWithinSuffix(name: string, suffix: string): boolean {
  return name === suffix || isWithinDelegatedSuffix(name, suffix);
}

function isWithinDelegatedSuffix(name: string, suffix: string): boolean {
  return name.endsWith(`.${suffix}`);
}

function hasForbiddenHostCharacter(input: string): boolean {
  return [...input].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return FORBIDDEN_HOST_CHARACTERS.includes(character) ||
      codePoint < 0x20 || codePoint === 0x7f ||
      (character.trim().length === 0 && character !== '\u200c' && character !== '\u200d') ||
      (/\p{Default_Ignorable_Code_Point}/u.test(character) && character !== '\u200c' && character !== '\u200d');
  });
}
