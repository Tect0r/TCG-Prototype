import {
  MAX_FILTER_VALUES,
  contentIdSchema,
  liveMatchContentVersionSchema,
  liveMatchDeckHashSchema,
  type LiveMatchSource,
  type LiveMatchTerminationOrigin,
  type MatchExplorerArtifactStatus,
  type MatchExplorerEndReason,
  type MatchExplorerParticipantKind,
  type MatchExplorerPhase,
  type PlayerMetaFilterInput,
} from '@tcg/admin-contracts';

/**
 * M08.26D — the Match Explorer panel's pure helpers: label wording for the
 * contract's closed vocabularies, and the one conversion this panel owns —
 * what a person typed into the `playerMetaFilterSchema` query
 * `matchExplorerList` reuses verbatim (see `match-explorer.ts`'s own doc
 * comment on why that is not a second filter shape).
 *
 * `contentVersions`/`commanderIds`/`deckHashes` are typed as comma-separated
 * text rather than selected from a published list, for the same reason
 * `results-view.ts` types `fullContentHash`: none of the three is a list this
 * screen already has a source to populate a menu from.
 */

const SOURCE_LABELS: Readonly<Record<LiveMatchSource, string>> = Object.freeze({
  human_human: 'Human vs human',
  human_ai: 'Human vs AI',
  ai_ai: 'AI vs AI',
});

/** A live match's source, in words. */
export function matchExplorerSourceLabel(source: LiveMatchSource): string {
  return SOURCE_LABELS[source];
}

const TERMINATION_LABELS: Readonly<Record<LiveMatchTerminationOrigin, string>> = Object.freeze({
  concede_action: 'Conceded (in-match action)',
  concede_leave: 'Conceded (left the match)',
  disconnect_timeout: 'Disconnect timeout',
  rules_victory: 'Rules victory',
  server_failure: 'Server failure',
  abandoned_unrecordable: 'Abandoned (unrecordable)',
});

/** How a match ended, in words. */
export function matchExplorerTerminationLabel(origin: LiveMatchTerminationOrigin): string {
  return TERMINATION_LABELS[origin];
}

const PARTICIPANT_KIND_LABELS: Readonly<Record<MatchExplorerParticipantKind, string>> =
  Object.freeze({
    human: 'Human',
    bot: 'Bot',
  });

/** A seat's participant kind, in words. */
export function matchExplorerParticipantKindLabel(kind: MatchExplorerParticipantKind): string {
  return PARTICIPANT_KIND_LABELS[kind];
}

const PHASE_LABELS: Readonly<Record<MatchExplorerPhase, string>> = Object.freeze({
  setup: 'Setup',
  mulligan: 'Mulligan',
  turn_start: 'Turn start',
  draw: 'Draw',
  main_1: 'Main 1',
  declare_attackers: 'Declare attackers',
  assign_blockers: 'Assign blockers',
  resolve_combat: 'Resolve combat',
  main_2: 'Main 2',
  turn_end: 'Turn end',
  reaction_window: 'Reaction window',
  complete: 'Complete',
});

/** A match phase, in words. */
export function matchExplorerPhaseLabel(phase: MatchExplorerPhase): string {
  return PHASE_LABELS[phase];
}

const END_REASON_LABELS: Readonly<Record<MatchExplorerEndReason, string>> = Object.freeze({
  health_depleted: 'Health depleted',
  empty_deck: 'Empty deck',
  concede: 'Concede',
  timeout: 'Timeout',
  simultaneous_loss: 'Simultaneous loss',
  engine_error: 'Engine error',
});

/** A match's end reason, in words. */
export function matchExplorerEndReasonLabel(reason: MatchExplorerEndReason): string {
  return END_REASON_LABELS[reason];
}

const ARTIFACT_STATUS_LABELS: Readonly<Record<MatchExplorerArtifactStatus, string>> = Object.freeze(
  {
    present: 'Present',
    not_retained: 'Not retained',
    not_applicable: 'Not applicable',
  },
);

/** An artifact's availability, in words. */
export function matchExplorerArtifactStatusLabel(status: MatchExplorerArtifactStatus): string {
  return ARTIFACT_STATUS_LABELS[status];
}

/* -------------------------------------------------------------------- filter */

export interface MatchExplorerFilterState {
  /** Comma-separated content versions, e.g. `"3, 4"`. */
  readonly contentVersions: string;
  readonly sources: readonly LiveMatchSource[];
  /** Comma-separated Commander IDs. */
  readonly commanderIds: string;
  /** Comma-separated deck hashes. */
  readonly deckHashes: string;
  readonly terminations: readonly LiveMatchTerminationOrigin[];
}

export const EMPTY_MATCH_EXPLORER_FILTER: MatchExplorerFilterState = Object.freeze({
  contentVersions: '',
  sources: [],
  commanderIds: '',
  deckHashes: '',
  terminations: [],
});

/** Whether the filter narrows anything at all, so a panel can say "showing everything". */
export function matchExplorerFilterIsEmpty(state: MatchExplorerFilterState): boolean {
  return (
    state.contentVersions.trim() === '' &&
    state.sources.length === 0 &&
    state.commanderIds.trim() === '' &&
    state.deckHashes.trim() === '' &&
    state.terminations.length === 0
  );
}

function splitList(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
  ];
}

export type MatchExplorerFilterResult =
  | { readonly ok: true; readonly value: PlayerMetaFilterInput }
  | { readonly ok: false; readonly error: string };

/**
 * Parses and validates the panel's typed filter fields into what
 * `matchExplorerList` (`playerMetaFilterSchema`) actually reads, or the first
 * problem found — the same "validate locally before any network request"
 * habit `DeckExplorerPanel`'s hash/experiment-ID form already follows.
 */
export function toMatchExplorerFilterInput(
  state: MatchExplorerFilterState,
): MatchExplorerFilterResult {
  const contentVersionTexts = splitList(state.contentVersions);
  if (contentVersionTexts.length > MAX_FILTER_VALUES) {
    return { ok: false, error: `At most ${String(MAX_FILTER_VALUES)} content versions.` };
  }
  const contentVersions: number[] = [];
  for (const text of contentVersionTexts) {
    const parsed = liveMatchContentVersionSchema.safeParse(Number(text));
    if (!parsed.success) return { ok: false, error: `"${text}" is not a valid content version.` };
    contentVersions.push(parsed.data);
  }

  const commanderIds = splitList(state.commanderIds);
  if (commanderIds.length > MAX_FILTER_VALUES) {
    return { ok: false, error: `At most ${String(MAX_FILTER_VALUES)} Commander IDs.` };
  }
  for (const text of commanderIds) {
    if (!contentIdSchema.safeParse(text).success) {
      return { ok: false, error: `"${text}" is not a valid Commander ID.` };
    }
  }

  const deckHashes = splitList(state.deckHashes);
  if (deckHashes.length > MAX_FILTER_VALUES) {
    return { ok: false, error: `At most ${String(MAX_FILTER_VALUES)} deck hashes.` };
  }
  for (const text of deckHashes) {
    if (!liveMatchDeckHashSchema.safeParse(text).success) {
      return { ok: false, error: `"${text}" is not a valid deck hash.` };
    }
  }

  return {
    ok: true,
    value: {
      contentVersions,
      sources: [...state.sources],
      commanderIds: [...commanderIds],
      deckHashes: [...deckHashes],
      terminations: [...state.terminations],
    },
  };
}
