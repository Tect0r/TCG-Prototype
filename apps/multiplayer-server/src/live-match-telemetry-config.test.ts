import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@tcg/shared';
import {
  effectiveLiveMatchRetention,
  LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS,
  liveMatchTelemetryConfigFromEnvironment,
  parseLiveMatchTelemetryConfig,
} from './live-match-telemetry-config.js';

const ABSOLUTE_ROOT =
  process.platform === 'win32' ? 'C:\\telemetry\\live-matches' : '/var/telemetry/live-matches';

describe('parseLiveMatchTelemetryConfig', () => {
  it('defaults to disabled, no root, every retention tier off, standard privacy, no age limit', () => {
    const result = parseLiveMatchTelemetryConfig({});
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      enabled: false,
      rootDirectory: null,
      retention: { rawEvent: false, replay: false, preActionCapture: false },
      maxAgeDays: null,
      privacyMode: 'standard',
    });
  });

  it('refuses enabled without a root directory', () => {
    const result = parseLiveMatchTelemetryConfig({ enabled: true });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain('live_match_telemetry/root_required');
  });

  it('refuses a root directory that is not absolute', () => {
    const result = parseLiveMatchTelemetryConfig({
      enabled: true,
      rootDirectory: 'relative/path',
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain(
      'live_match_telemetry/root_not_absolute',
    );
  });

  it('accepts enabled with an absolute root and configured retention', () => {
    const result = parseLiveMatchTelemetryConfig({
      enabled: true,
      rootDirectory: ABSOLUTE_ROOT,
      retention: { rawEvent: true },
      maxAgeDays: 90,
      privacyMode: 'strict',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      enabled: true,
      rootDirectory: ABSOLUTE_ROOT,
      retention: { rawEvent: true, replay: false, preActionCapture: false },
      maxAgeDays: 90,
      privacyMode: 'strict',
    });
  });

  it('a configured root with collection disabled yields no root', () => {
    // A prior root value must never survive a switch to disabled — this is
    // what keeps `compose.ts` from wiring a live-match sink while the
    // operator's own `enabled` flag says off, and it is why
    // `LiveMatchTelemetryConfig.rootDirectory`'s doc comment promises `null`
    // exactly when `enabled` is `false`.
    const result = parseLiveMatchTelemetryConfig({
      enabled: false,
      rootDirectory: ABSOLUTE_ROOT,
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.rootDirectory).toBeNull();
  });

  it.each([0, -1, 1.5, 3651])('refuses an out-of-bounds maxAgeDays of %s', (maxAgeDays) => {
    const result = parseLiveMatchTelemetryConfig({ maxAgeDays });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain(
      'live_match_telemetry/invalid_max_age_days',
    );
  });

  it('accepts maxAgeDays at its bounds', () => {
    expect(isOk(parseLiveMatchTelemetryConfig({ maxAgeDays: 1 }))).toBe(true);
    expect(isOk(parseLiveMatchTelemetryConfig({ maxAgeDays: 3650 }))).toBe(true);
  });

  it('refuses an unrecognised privacyMode', () => {
    const result = parseLiveMatchTelemetryConfig({
      privacyMode: 'invisible' as never,
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain(
      'live_match_telemetry/invalid_privacy_mode',
    );
  });

  it('rejects an invalid retention shape rather than silently ignoring the unknown field', () => {
    const result = parseLiveMatchTelemetryConfig({
      retention: { rawEvent: 'yes' } as never,
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain(
      'live_match_telemetry/invalid_retention',
    );
  });
});

describe('effectiveLiveMatchRetention', () => {
  it('passes configured retention through in standard privacy mode', () => {
    const result = parseLiveMatchTelemetryConfig({
      enabled: true,
      rootDirectory: ABSOLUTE_ROOT,
      retention: { rawEvent: true, replay: true, preActionCapture: true },
      privacyMode: 'standard',
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(effectiveLiveMatchRetention(result.value)).toEqual({
      rawEvent: true,
      replay: true,
      preActionCapture: true,
    });
  });

  it('forces every tier off in strict privacy mode regardless of configured retention', () => {
    const result = parseLiveMatchTelemetryConfig({
      enabled: true,
      rootDirectory: ABSOLUTE_ROOT,
      retention: { rawEvent: true, replay: true, preActionCapture: true },
      privacyMode: 'strict',
    });
    if (!isOk(result)) throw new Error('expected ok');
    expect(effectiveLiveMatchRetention(result.value)).toEqual({
      rawEvent: false,
      replay: false,
      preActionCapture: false,
    });
  });
});

describe('liveMatchTelemetryConfigFromEnvironment', () => {
  it('matches parseLiveMatchTelemetryConfig({})\u2019s defaults when no keys are set', () => {
    const result = liveMatchTelemetryConfigFromEnvironment({});
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      enabled: false,
      rootDirectory: null,
      retention: { rawEvent: false, replay: false, preActionCapture: false },
      maxAgeDays: null,
      privacyMode: 'standard',
    });
  });

  it('parses a fully configured environment', () => {
    const keys = LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS;
    const result = liveMatchTelemetryConfigFromEnvironment({
      [keys.enabled]: 'true',
      [keys.rootDirectory]: ABSOLUTE_ROOT,
      [keys.retainRawEvent]: '1',
      [keys.retainReplay]: 'false',
      [keys.retainPreActionCapture]: 'TRUE',
      [keys.maxAgeDays]: '30',
      [keys.privacyMode]: 'standard',
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      enabled: true,
      rootDirectory: ABSOLUTE_ROOT,
      retention: { rawEvent: true, replay: false, preActionCapture: true },
      maxAgeDays: 30,
      privacyMode: 'standard',
    });
  });

  it('refuses an unparsable boolean rather than silently defaulting it', () => {
    const result = liveMatchTelemetryConfigFromEnvironment({
      [LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS.enabled]: 'yes-please',
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain(
      'live_match_telemetry/invalid_boolean',
    );
  });

  it('refuses an unparsable integer for maxAgeDays', () => {
    const result = liveMatchTelemetryConfigFromEnvironment({
      [LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS.maxAgeDays]: 'ninety',
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain(
      'live_match_telemetry/invalid_integer',
    );
  });

  it('an operator-configured root with no enabled flag set yields no root, not a leaked default-on sink', () => {
    // The exact shape of an operator who sets `TCG_LIVE_MATCH_TELEMETRY_ROOT`
    // in advance of turning collection on: `enabled` stays at its documented
    // disabled default, so `compose.ts` must not construct a live-match sink
    // from the leftover root.
    const result = liveMatchTelemetryConfigFromEnvironment({
      [LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS.rootDirectory]: ABSOLUTE_ROOT,
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.enabled).toBe(false);
    expect(result.value.rootDirectory).toBeNull();
  });

  it('delegates the cross-field enabled/root refusal to the pure parser', () => {
    const result = liveMatchTelemetryConfigFromEnvironment({
      [LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS.enabled]: 'true',
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.map((issue) => issue.code)).toContain('live_match_telemetry/root_required');
  });
});
