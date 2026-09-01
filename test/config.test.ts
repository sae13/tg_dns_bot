import { describe, expect, it } from 'vitest';
import {
  InvalidBindingError,
  MissingBindingError,
  coordinatorPublishConfig,
  externalWriterConfig,
  helpFeatureConfig,
  readFeatureConfig,
  sendFeatureConfig,
  telegramBotConfig,
  type Env
} from '../src/config';

describe('sendFeatureConfig', () => {
  it('defaults sending to enabled and parses the canonical zone map binding', () => {
    const config = sendFeatureConfig({ ZONE_MAP: '[["Example.COM.","zone-1"]]' });
    expect(config.sendEnabled).toBe(true);
    expect(config.allowedZones()).toEqual([{ suffix: 'example.com', zoneId: 'zone-1' }]);
  });

  it('uses the architecture binding name when supplied', () => {
    const config = sendFeatureConfig({ ALLOWED_ZONE_MAP: '[["example.com","zone-1"]]' });
    expect(config.allowedZones()).toEqual([{ suffix: 'example.com', zoneId: 'zone-1' }]);
  });

  it('rejects duplicate zone entries instead of applying last-write-wins', () => {
    const config = sendFeatureConfig({
      ALLOWED_ZONE_MAP: '[["example.com","zone-first"],["example.com","zone-last"]]'
    });
    expect(() => config.allowedZones()).toThrow(InvalidBindingError);
  });

  it('does not parse or require a zone map while sending is disabled', () => {
    const config = sendFeatureConfig({ SEND_ENABLED: 'false', ZONE_MAP: 'not-json' });
    expect(config.sendEnabled).toBe(false);
    expect(() => config.allowedZones()).toThrow(InvalidBindingError);
  });

  it.each(['TRUE', '1', 'yes', ''])('rejects a non-canonical send flag: %j', (value) => {
    expect(() => sendFeatureConfig({ SEND_ENABLED: value, ZONE_MAP: '{}' })).toThrow(InvalidBindingError);
  });

  it.each<Env>([
    { SEND_ENABLED: 'true' },
    { SEND_ENABLED: 'true', ZONE_MAP: '{}' },
    { SEND_ENABLED: 'true', ZONE_MAP: '[]' },
    { SEND_ENABLED: 'true', ZONE_MAP: '{"example.com":""}' },
    { SEND_ENABLED: 'true', ZONE_MAP: '{"example.com":"zone-a","child.example.com":"zone-b"}' }
  ])('rejects a missing or invalid active zone map: %j', (env) => {
    expect(() => sendFeatureConfig(env).allowedZones()).toThrow(InvalidBindingError);
  });
});

describe('readFeatureConfig', () => {
  it('defaults public reading to enabled without requiring write bindings or secrets', () => {
    expect(readFeatureConfig({})).toEqual({
      readEnabled: true,
      timeoutMilliseconds: 15_000
    });
  });

  it('accepts the architecture INBOX_ENABLED binding as an alias for READ_ENABLED', () => {
    expect(readFeatureConfig({ INBOX_ENABLED: 'false' })).toEqual({
      readEnabled: false,
      timeoutMilliseconds: 15_000
    });
  });

  it('does not validate resolver timeout while reading is disabled', () => {
    expect(readFeatureConfig({ READ_ENABLED: 'false', PROVIDER_TIMEOUT_SECONDS: 'invalid' })).toEqual({
      readEnabled: false,
      timeoutMilliseconds: 15_000
    });
  });

  it('rejects conflicting read feature aliases instead of silently choosing one', () => {
    expect(() => readFeatureConfig({ READ_ENABLED: 'true', INBOX_ENABLED: 'false' }))
      .toThrowError(expect.objectContaining({ bindingName: 'INBOX_ENABLED' }));
  });

  it.each(['TRUE', '1', 'yes', ''])('rejects a non-canonical read flag: %j', (value) => {
    expect(() => readFeatureConfig({ READ_ENABLED: value })).toThrow(InvalidBindingError);
  });

  it.each(['0', '31', '1.5', '-1', 'seconds'])(
    'rejects an invalid public DNS timeout: %j',
    (PROVIDER_TIMEOUT_SECONDS) => {
      expect(() => readFeatureConfig({ PROVIDER_TIMEOUT_SECONDS }))
        .toThrowError(expect.objectContaining({ bindingName: 'PROVIDER_TIMEOUT_SECONDS' }));
    }
  );
});

describe('helpFeatureConfig', () => {
  it('defaults help to enabled and exposes only canonical suffixes and bounded TTL', () => {
    const config = helpFeatureConfig({
      ALLOWED_ZONE_MAP: '[["Example.COM.","zone-secret"],["other.test","zone-two"]]',
      DNS_TTL_SECONDS: '120'
    });
    expect(config.helpEnabled).toBe(true);
    expect(config.allowedZoneSuffixes()).toEqual(['example.com', 'other.test']);
    expect(config.ttlSeconds).toBe(120);
    expect(JSON.stringify(config)).not.toContain('zone-secret');
  });

  it('allows an empty write-domain list and reports it without requiring send configuration', () => {
    const config = helpFeatureConfig({ HELP_ENABLED: 'true', SEND_ENABLED: 'false', ZONE_MAP: '[]' });
    expect(config.allowedZoneSuffixes()).toEqual([]);
  });

  it('does not parse or require dependent help configuration while help is disabled', () => {
    const config = helpFeatureConfig({
      HELP_ENABLED: 'false',
      ALLOWED_ZONE_MAP: 'not-json',
      DNS_TTL_SECONDS: 'not-a-number'
    });
    expect(config.helpEnabled).toBe(false);
    expect(config.ttlSeconds).toBe(60);
    expect(() => config.allowedZoneSuffixes()).toThrow(InvalidBindingError);
  });

  it.each(['TRUE', '1', 'yes', ''])('rejects a non-canonical help flag: %j', (value) => {
    expect(() => helpFeatureConfig({ HELP_ENABLED: value })).toThrow(InvalidBindingError);
  });
});

describe('externalWriterConfig', () => {
  it('reads an HTTPS endpoint and opaque shared secret', () => {
    expect(externalWriterConfig({
      EXTERNAL_WRITER_URL: 'https://writer.example.test/publish',
      EXTERNAL_WRITER_SHARED_SECRET: 'shared-secret-value'
    })).toEqual({
      endpoint: 'https://writer.example.test/publish',
      sharedSecret: 'shared-secret-value'
    });
  });

  it('rejects a missing external writer URL', () => {
    expect(() => externalWriterConfig({ EXTERNAL_WRITER_SHARED_SECRET: 'shared-secret-value' }))
      .toThrowError(new MissingBindingError('EXTERNAL_WRITER_URL'));
  });

  it.each([
    [{ EXTERNAL_WRITER_URL: 'http://writer.example.test/publish', EXTERNAL_WRITER_SHARED_SECRET: 'shared-secret-value' }, 'EXTERNAL_WRITER_URL'],
    [{ EXTERNAL_WRITER_URL: 'https://writer.example.test/publish', EXTERNAL_WRITER_SHARED_SECRET: 'short' }, 'EXTERNAL_WRITER_SHARED_SECRET']
  ] as const)('rejects invalid external writer configuration %#', (env, binding) => {
    expect(() => externalWriterConfig(env)).toThrowError(new InvalidBindingError(binding));
  });
});

describe('telegramBotConfig', () => {
  it('requires the bot token only when Telegram delivery configuration is requested', () => {
    expect(() => telegramBotConfig({})).toThrowError(expect.objectContaining({ bindingName: 'BOT_TOKEN' }));
    expect(telegramBotConfig({ BOT_TOKEN: '123:token' })).toEqual({
      botToken: '123:token',
      timeoutMilliseconds: 15_000
    });
  });

  it('accepts a valid configured API base URL without exposing the token in errors', () => {
    expect(telegramBotConfig({
      BOT_TOKEN: '123:never-log',
      TELEGRAM_API_BASE_URL: 'https://api.telegram.test/'
    })).toEqual({
      botToken: '123:never-log',
      apiBaseUrl: 'https://api.telegram.test/',
      timeoutMilliseconds: 15_000
    });
  });

  it.each([
    'ftp://api.telegram.test',
    'https://user:password@api.telegram.test',
    'https://api.telegram.test?token=secret',
    'not-a-url'
  ])('rejects an invalid Telegram API base URL without including its value: %j', (apiBaseUrl) => {
    try {
      telegramBotConfig({ BOT_TOKEN: '123:never-log', TELEGRAM_API_BASE_URL: apiBaseUrl });
      expect.fail('configuration should fail');
    } catch (error) {
      expect(error).toMatchObject({ bindingName: 'TELEGRAM_API_BASE_URL' });
      expect(String(error)).not.toContain(apiBaseUrl);
      expect(String(error)).not.toContain('never-log');
    }
  });
});

describe('coordinatorPublishConfig', () => {
  const base: Env = {
    CLOUDFLARE_API_TOKEN: 'token',
    ALLOWED_ZONE_MAP: '[["example.com","zone-1"]]'
  };

  it('defaults to a 15-second provider timeout and 45-second publication budget', () => {
    expect(coordinatorPublishConfig(base)).toMatchObject({
      timeoutMilliseconds: 15_000,
      budgetMilliseconds: 45_000
    });
  });

  it.each(['0', '31', '1.5', '-1', 'seconds'])(
    'rejects an invalid provider timeout: %j',
    (PROVIDER_TIMEOUT_SECONDS) => {
      expect(() => coordinatorPublishConfig({ ...base, PROVIDER_TIMEOUT_SECONDS }))
        .toThrowError(expect.objectContaining({ bindingName: 'PROVIDER_TIMEOUT_SECONDS' }));
    }
  );
});
