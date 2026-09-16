import { isAbsolute } from 'node:path';
import { liveMatchRetentionConfigSchema, type LiveMatchRetentionConfig } from '@tcg/match-telemetry';
import { err, error, ok, type Issue, type Result } from '@tcg/shared';

/**
 * The dedicated live-match telemetry configuration surface (M08.R8): what a
 * deployment must decide before `LiveMatchFileStore` (`./live-match-store.ts`)
 * is ever wired into a running `MatchServer`. Wiring itself — constructing the
 * store, passing it as `MatchServerOptions.liveMatchSink`/`liveMatchRetention`
 * in `apps/multiplayer-server/src/main.ts` — is M08.R9's job; this module only
 * decides, from configuration, what that wiring should do.
 *
 * **Operator-only root, never client-settable.** `rootDirectory` is read from
 * this module's own environment/config surface, never from a protocol message
 * or a per-request value — nothing downstream of `parseLiveMatchTelemetryConfig`
 * accepts a client-supplied path. Absent when telemetry is disabled, and
 * required (with no default) when it is enabled: a server that invented a
 * default path would decide, on the operator's behalf, where real-play records
 * land.
 *
 * **Retention reuses `@tcg/match-telemetry`'s own contract** rather than
 * redefining it — `liveMatchRetentionConfigSchema`'s three tiers, all
 * "off unless configured" by that schema's own defaults.
 *
 * **`maxAgeDays` is recorded, not enforced.** M08.28B is a standing decision
 * (`docs/milestones/M08-ai-lab-and-player-meta.md`): any deletion feature must
 * be separately confirmed, path-bounded and tested, and omission is
 * preferable to an unsafe delete button. This module validates an age policy
 * as configuration a future, separately-reviewed purge slice could read; it
 * deliberately deletes nothing itself.
 *
 * **Write-failure behavior already exists** and needs no new mechanism here:
 * `MatchServer.ingestLiveMatch`/`publishLiveMatchRecord` (M08.22A/C) already
 * contain every sink failure in a `try`/`catch`, recording it without
 * throwing or corrupting the authoritative match. This config module governs
 * only what gets written and where, not how a write failure is handled.
 *
 * **Privacy mode.** `'standard'` uses `retention` as configured. `'strict'`
 * overrides it to all three tiers off regardless of what `retention` says —
 * see `effectiveLiveMatchRetention` — while still emitting the mandatory
 * envelope, since the envelope itself is never a `retention` dial
 * (`liveMatchRetentionConfigSchema`'s own doc comment).
 */

export type LiveMatchPrivacyMode = 'standard' | 'strict';

const PRIVACY_MODES: readonly LiveMatchPrivacyMode[] = ['standard', 'strict'];

/** Whole days; generous enough for any plausible retention policy, not unbounded. */
const MAX_AGE_DAYS_BOUNDS = { min: 1, max: 3650 } as const;

export interface LiveMatchTelemetryConfigInput {
  readonly enabled?: boolean;
  readonly rootDirectory?: string | null;
  readonly retention?: Partial<LiveMatchRetentionConfig>;
  readonly maxAgeDays?: number | null;
  readonly privacyMode?: LiveMatchPrivacyMode;
}

export interface LiveMatchTelemetryConfig {
  readonly enabled: boolean;
  /** Absolute path; `null` exactly when `enabled` is `false`. */
  readonly rootDirectory: string | null;
  readonly retention: LiveMatchRetentionConfig;
  /** `null` means no age-based purge is configured. Not enforced by this module — see file doc comment. */
  readonly maxAgeDays: number | null;
  readonly privacyMode: LiveMatchPrivacyMode;
}

const DEFAULT_RETENTION: LiveMatchRetentionConfig = Object.freeze({
  rawEvent: false,
  replay: false,
  preActionCapture: false,
});

/**
 * Validates a live-match telemetry configuration. Total and pure: never
 * throws, never reads the environment or the filesystem.
 */
export function parseLiveMatchTelemetryConfig(
  input: LiveMatchTelemetryConfigInput,
): Result<LiveMatchTelemetryConfig, Issue[]> {
  const problems: Issue[] = [];
  const enabled = input.enabled ?? false;

  const rawRoot = input.rootDirectory ?? null;
  const rootDirectory = rawRoot === null || rawRoot.trim() === '' ? null : rawRoot;
  if (enabled && rootDirectory === null) {
    problems.push(
      error(
        'live_match_telemetry/root_required',
        'Live-match telemetry is enabled but no root directory is configured. There is no default: a server that chose one for itself would decide, on the operator’s behalf, where real-play records are written.',
        { path: 'rootDirectory' },
      ),
    );
  } else if (rootDirectory !== null && !isAbsolute(rootDirectory)) {
    problems.push(
      error(
        'live_match_telemetry/root_not_absolute',
        `Live-match telemetry root "${rootDirectory}" must be an absolute path.`,
        { path: 'rootDirectory' },
      ),
    );
  }

  const retentionParsed = liveMatchRetentionConfigSchema.safeParse(input.retention ?? {});
  if (!retentionParsed.success) {
    problems.push(
      error(
        'live_match_telemetry/invalid_retention',
        `Live-match telemetry retention is invalid: ${retentionParsed.error.message}`,
        { path: 'retention' },
      ),
    );
  }

  const maxAgeDays = input.maxAgeDays ?? null;
  if (maxAgeDays !== null) {
    const inBounds =
      Number.isInteger(maxAgeDays) &&
      maxAgeDays >= MAX_AGE_DAYS_BOUNDS.min &&
      maxAgeDays <= MAX_AGE_DAYS_BOUNDS.max;
    if (!inBounds) {
      problems.push(
        error(
          'live_match_telemetry/invalid_max_age_days',
          `Live-match telemetry maxAgeDays must be a whole number of days between ${MAX_AGE_DAYS_BOUNDS.min} and ${MAX_AGE_DAYS_BOUNDS.max}, or unset.`,
          { path: 'maxAgeDays' },
        ),
      );
    }
  }

  const privacyMode = input.privacyMode ?? 'standard';
  if (!PRIVACY_MODES.includes(privacyMode)) {
    problems.push(
      error(
        'live_match_telemetry/invalid_privacy_mode',
        `Live-match telemetry privacyMode must be one of: ${PRIVACY_MODES.join(', ')}.`,
        { path: 'privacyMode' },
      ),
    );
  }

  if (problems.length > 0) return err(problems);

  return ok({
    enabled,
    rootDirectory,
    retention: retentionParsed.success ? retentionParsed.data : DEFAULT_RETENTION,
    maxAgeDays,
    privacyMode,
  });
}

/**
 * The retention tiers a deployment actually gets once `privacyMode` has had
 * its say. `'strict'` refuses every optional tier regardless of `retention`,
 * so a deployment cannot configure `privacyMode: 'strict'` and still keep raw
 * events or captures by also setting a `retention` flag — the two would
 * otherwise silently disagree about which one wins.
 */
export function effectiveLiveMatchRetention(
  config: LiveMatchTelemetryConfig,
): LiveMatchRetentionConfig {
  return config.privacyMode === 'strict' ? DEFAULT_RETENTION : config.retention;
}

export const LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS = Object.freeze({
  enabled: 'TCG_LIVE_MATCH_TELEMETRY_ENABLED',
  rootDirectory: 'TCG_LIVE_MATCH_TELEMETRY_ROOT',
  retainRawEvent: 'TCG_LIVE_MATCH_TELEMETRY_RETAIN_RAW_EVENT',
  retainReplay: 'TCG_LIVE_MATCH_TELEMETRY_RETAIN_REPLAY',
  retainPreActionCapture: 'TCG_LIVE_MATCH_TELEMETRY_RETAIN_PRE_ACTION_CAPTURE',
  maxAgeDays: 'TCG_LIVE_MATCH_TELEMETRY_MAX_AGE_DAYS',
  privacyMode: 'TCG_LIVE_MATCH_TELEMETRY_PRIVACY_MODE',
});

type Environment = Readonly<Record<string, string | undefined>>;

function booleanFrom(environment: Environment, key: string, problems: Issue[]): boolean | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  problems.push(
    error('live_match_telemetry/invalid_boolean', `\`${key}\` must be "true" or "false".`, {
      path: key,
    }),
  );
  return undefined;
}

function integerFrom(environment: Environment, key: string, problems: Issue[]): number | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(
      error('live_match_telemetry/invalid_integer', `\`${key}\` must be a whole number.`, {
        path: key,
      }),
    );
    return undefined;
  }
  return value;
}

/**
 * Reads live-match telemetry configuration from process environment
 * variables. Two-layer, like `apps/admin-server/src/service/config.ts`'s
 * `serviceConfigFromEnvironment`: this layer only turns strings into typed
 * values (or refuses an unparsable one), then delegates every structural and
 * cross-field rule to `parseLiveMatchTelemetryConfig`.
 */
export function liveMatchTelemetryConfigFromEnvironment(
  environment: Environment,
): Result<LiveMatchTelemetryConfig, Issue[]> {
  const keys = LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS;
  const problems: Issue[] = [];

  const enabled = booleanFrom(environment, keys.enabled, problems);
  const retainRawEvent = booleanFrom(environment, keys.retainRawEvent, problems);
  const retainReplay = booleanFrom(environment, keys.retainReplay, problems);
  const retainPreActionCapture = booleanFrom(environment, keys.retainPreActionCapture, problems);
  const maxAgeDays = integerFrom(environment, keys.maxAgeDays, problems);

  const rawPrivacyMode = environment[keys.privacyMode];
  const privacyMode =
    rawPrivacyMode === undefined || rawPrivacyMode.trim() === '' ? undefined : rawPrivacyMode.trim();

  if (problems.length > 0) return err(problems);

  const rawRoot = environment[keys.rootDirectory];
  const rootDirectory = rawRoot === undefined || rawRoot.trim() === '' ? null : rawRoot;

  return parseLiveMatchTelemetryConfig({
    enabled: enabled ?? false,
    rootDirectory,
    retention: {
      ...(retainRawEvent === undefined ? {} : { rawEvent: retainRawEvent }),
      ...(retainReplay === undefined ? {} : { replay: retainReplay }),
      ...(retainPreActionCapture === undefined ? {} : { preActionCapture: retainPreActionCapture }),
    },
    ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
    ...(privacyMode === undefined ? {} : { privacyMode: privacyMode as LiveMatchPrivacyMode }),
  });
}
