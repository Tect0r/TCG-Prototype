import { useEffect, useMemo, useState } from 'react';

import {
  BASIS_WORDING,
  FORCED_INCLUSION_CAVEAT,
  NO_PLAY_QUALITY_CAVEAT,
  PRESET_REGISTRY,
  type ChoiceEstimate,
  type ContentCatalog,
  type EnqueuePresetResult,
  type ExperimentPresetDefinitionValue,
  type SavedChoiceView,
} from '@tcg/admin-contracts';

import { Busy, Empty, Failure } from './Feedback.js';
import {
  EMPTY_CARD_PATCH_ROW,
  PRESET_DEPTHS,
  asBenchmarkChoice,
  asCandidateComparisonChoice,
  asCardReplacementChoice,
  asEngineSoakChoice,
  asOpenMetaChoice,
  asPilotRobustnessChoice,
  benchmarkPresets,
  candidateComparisonChoiceOf,
  candidateComparisonFormFingerprint,
  candidateComparisonFormOf,
  cardReplacementChoiceOf,
  cardReplacementFormFingerprint,
  cardReplacementFormOf,
  catalogCommanderIds,
  choiceOf,
  engineSoakChoiceOf,
  engineSoakFormFingerprint,
  engineSoakFormOf,
  formFingerprint,
  formOf,
  initialCandidateComparisonForm,
  initialCardReplacementForm,
  initialEngineSoakForm,
  initialForm,
  initialOpenMetaForm,
  initialPilotRobustnessForm,
  openMetaChoiceOf,
  openMetaFormFingerprint,
  openMetaFormOf,
  pilotRobustnessChoiceOf,
  pilotRobustnessFormFingerprint,
  pilotRobustnessFormOf,
  type BuilderForm,
  type BuilderPresetId,
  type CandidateComparisonForm,
  type CardReplacementForm,
  type EngineSoakForm,
  type OpenMetaForm,
  type PilotRobustnessForm,
} from '../lib/builder-form.js';
import { useAdminSession, useAdminState } from '../state/AdminContext.js';
import type { AdminFailure } from '../net/transport.js';

/** Which test family the screen is configuring right now. */
type Family =
  | 'benchmark'
  | 'open_meta'
  | 'candidate_comparison'
  | 'pilot_robustness'
  | 'engine_soak'
  | 'card_replacement';

/**
 * The first screen in this build that creates something.
 *
 * ## The exact total is shown before anything is enqueued, structurally
 *
 * The milestone's requirement is not "there is an estimate somewhere on the
 * page"; it is that the number is in front of the person *before* the work is
 * created. So the screen holds the fingerprint of the form the estimate was
 * obtained for, and the enqueue control exists only while that fingerprint still
 * matches what is on screen. Change one control — a precon, the depth, the seat
 * orders, the seed — and the enqueue is withdrawn until the number is asked for
 * again. That is a property a test can drive rather than a habit a reviewer has
 * to check.
 *
 * ## Every option is derived from what the service answered
 *
 * The depths come from the preset catalog filtered by test style, the precons
 * and pilots from the content answer, and the worker ceiling from
 * `capabilities.orchestrator.maxWorkersPerJob`. Nothing on this page is a list
 * this bundle holds: a precon withdrawn from the format stops being offered
 * because the service stopped sending it, and a precon this environment cannot
 * play is **shown, disabled, and given the environment's own reason** rather
 * than quietly filtered out — the difference between "this format has three
 * precons" and "this format has four and one of them is broken" is a content
 * finding somebody should see.
 *
 * ## What is deliberately not here
 *
 * **No estimated storage and no estimated runtime.** The milestone asks for both
 * *where available*, and neither is available: nothing in this build has ever
 * measured how long a match takes or how large a run directory grows, so any
 * figure would be a number this screen made up. The page says so where the
 * figures would have gone, which is the honest version of "where available".
 *
 * **No queue.** What happens after the enqueue is the Queue screen's, which
 * M08.9 built. This one reports exactly what it created — the batch, the jobs
 * and their stages — and stops. Since M08.9 it also creates nothing that is
 * running: the batch it fills is a **draft**, and releasing it is a separate,
 * confirmed act on the page that can also reorder it first.
 */
export function BuilderScreen() {
  const session = useAdminSession();
  const state = useAdminState();
  const connection = state.connection;

  const content = state.content.status === 'ready' ? state.content.value : null;
  const [family, setFamily] = useState<Family>('benchmark');
  const [form, setForm] = useState<BuilderForm>(() => initialForm(content));
  const [openMeta, setOpenMeta] = useState<OpenMetaForm>(() => initialOpenMetaForm(content));
  const [candidateComparison, setCandidateComparison] = useState<CandidateComparisonForm>(() =>
    initialCandidateComparisonForm(content),
  );
  const [pilotRobustness, setPilotRobustness] = useState<PilotRobustnessForm>(() =>
    initialPilotRobustnessForm(content),
  );
  const [engineSoak, setEngineSoak] = useState<EngineSoakForm>(() => initialEngineSoakForm());
  const [cardReplacement, setCardReplacement] = useState<CardReplacementForm>(() =>
    initialCardReplacementForm(content),
  );
  const [seeded, setSeeded] = useState(content !== null);
  const [priced, setPriced] = useState<{
    readonly fingerprint: string;
    readonly estimate: ChoiceEstimate;
  } | null>(null);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [enqueued, setEnqueued] = useState<EnqueuePresetResult | null>(null);
  const [saveLabel, setSaveLabel] = useState('');
  const [saved, setSaved] = useState<SavedChoiceView | null>(null);

  // The first content answer decides the default selection, and only the first:
  // re-seeding on every reading would throw away a selection somebody made while
  // the catalog was being re-read.
  useEffect(() => {
    if (seeded || content === null) return;
    setForm(initialForm(content));
    setOpenMeta(initialOpenMetaForm(content));
    setCandidateComparison(initialCandidateComparisonForm(content));
    setPilotRobustness(initialPilotRobustnessForm(content));
    setCardReplacement(initialCardReplacementForm(content));
    setSeeded(true);
  }, [content, seeded]);

  // Whichever family is on screen owns the fingerprint, the request and the
  // batch label the estimate, enqueue and save actions below all act on. The
  // other families' forms keep whatever was on them, unpriced, so switching
  // back does not lose them.
  const fingerprint =
    family === 'benchmark'
      ? formFingerprint(form)
      : family === 'open_meta'
        ? openMetaFormFingerprint(openMeta)
        : family === 'candidate_comparison'
          ? candidateComparisonFormFingerprint(candidateComparison)
          : family === 'pilot_robustness'
            ? pilotRobustnessFormFingerprint(pilotRobustness)
            : family === 'engine_soak'
              ? engineSoakFormFingerprint(engineSoak)
              : cardReplacementFormFingerprint(cardReplacement);
  const result =
    family === 'benchmark'
      ? choiceOf(form)
      : family === 'open_meta'
        ? openMetaChoiceOf(openMeta)
        : family === 'candidate_comparison'
          ? candidateComparisonChoiceOf(candidateComparison)
          : family === 'pilot_robustness'
            ? pilotRobustnessChoiceOf(pilotRobustness)
            : family === 'engine_soak'
              ? engineSoakChoiceOf(engineSoak)
              : cardReplacementChoiceOf(cardReplacement);
  const batchLabel =
    family === 'benchmark'
      ? form.batchLabel
      : family === 'open_meta'
        ? openMeta.batchLabel
        : family === 'candidate_comparison'
          ? candidateComparison.batchLabel
          : family === 'pilot_robustness'
            ? pilotRobustness.batchLabel
            : family === 'engine_soak'
              ? engineSoak.batchLabel
              : cardReplacement.batchLabel;
  const current = priced !== null && priced.fingerprint === fingerprint ? priced.estimate : null;

  const update = (change: Partial<BuilderForm>): void => {
    setForm((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  const updateOpenMeta = (change: Partial<OpenMetaForm>): void => {
    setOpenMeta((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  const updateCandidateComparison = (change: Partial<CandidateComparisonForm>): void => {
    setCandidateComparison((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  const updatePilotRobustness = (change: Partial<PilotRobustnessForm>): void => {
    setPilotRobustness((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  const updateEngineSoak = (change: Partial<EngineSoakForm>): void => {
    setEngineSoak((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  const updateCardReplacement = (change: Partial<CardReplacementForm>): void => {
    setCardReplacement((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  const selectFamily = (next: Family): void => {
    setFamily(next);
    setPriced(null);
    setEnqueued(null);
    setSaved(null);
    setFailure(null);
  };

  if (connection.status !== 'connected') return null;

  const presets =
    state.presets.status === 'ready' ? benchmarkPresets(state.presets.value.presets) : [];
  const maxWorkers = connection.capabilities.orchestrator.maxWorkersPerJob;
  const commanderIds = catalogCommanderIds(content);

  const price = async (): Promise<void> => {
    if (!result.ok) return;
    setFailure(null);
    const answer = await session.estimate(result.choice);
    if (answer.ok) setPriced({ fingerprint, estimate: answer.value });
    else {
      setPriced(null);
      setFailure(answer.failure);
    }
  };

  const enqueue = async (): Promise<void> => {
    if (!result.ok || current === null) return;
    setFailure(null);
    const answer = await session.enqueue(batchLabel.trim(), result.choice);
    if (answer.ok) setEnqueued(answer.value);
    else setFailure(answer.failure);
  };

  const keep = async (): Promise<void> => {
    if (!result.ok || saveLabel.trim() === '') return;
    setFailure(null);
    const answer = await session.saveChoice(saveLabel.trim(), result.choice);
    if (answer.ok) {
      setSaved(answer.value);
      setSaveLabel('');
    } else setFailure(answer.failure);
  };

  const open = (entry: SavedChoiceView): void => {
    const benchmark = formOf(entry.choice, entry.label);
    if (benchmark !== null) {
      setFamily('benchmark');
      setForm(benchmark);
    } else {
      const openMetaReopened = openMetaFormOf(entry.choice, entry.label);
      const candidateComparisonReopened =
        openMetaReopened === null ? candidateComparisonFormOf(entry.choice, entry.label) : null;
      const pilotRobustnessReopened =
        openMetaReopened === null && candidateComparisonReopened === null
          ? pilotRobustnessFormOf(entry.choice, entry.label)
          : null;
      const engineSoakReopened =
        openMetaReopened === null &&
        candidateComparisonReopened === null &&
        pilotRobustnessReopened === null
          ? engineSoakFormOf(entry.choice, entry.label)
          : null;
      const cardReplacementReopened =
        openMetaReopened === null &&
        candidateComparisonReopened === null &&
        pilotRobustnessReopened === null &&
        engineSoakReopened === null
          ? cardReplacementFormOf(entry.choice, entry.label)
          : null;
      if (openMetaReopened !== null) {
        setFamily('open_meta');
        setOpenMeta(openMetaReopened);
      } else if (candidateComparisonReopened !== null) {
        setFamily('candidate_comparison');
        setCandidateComparison(candidateComparisonReopened);
      } else if (pilotRobustnessReopened !== null) {
        setFamily('pilot_robustness');
        setPilotRobustness(pilotRobustnessReopened);
      } else if (engineSoakReopened !== null) {
        setFamily('engine_soak');
        setEngineSoak(engineSoakReopened);
      } else if (cardReplacementReopened !== null) {
        setFamily('card_replacement');
        setCardReplacement(cardReplacementReopened);
      } else return;
    }
    setPriced(null);
    setEnqueued(null);
    setSaved(null);
    setFailure(null);
  };

  return (
    <div className="builder">
      {state.content.status === 'loading' && <Busy label="Asking what content this lab runs…" />}
      {state.content.status === 'failed' && (
        <Failure
          title="The content this lab runs could not be read"
          failure={state.content.failure}
          onRetry={() => {
            void session.reloadContent();
          }}
          retryLabel="Ask again"
        />
      )}

      {content !== null && (
        <>
          <FamilySection family={family} onChange={selectFamily} />

          {family === 'benchmark' && (
            <>
              <DepthSection presets={presets} form={form} onChange={update} />
              <PreconSection content={content} form={form} onChange={update} />
              <PilotSection content={content} form={form} onChange={update} />
              <WorkloadSection form={form} onChange={update} maxWorkers={maxWorkers} />
              <AdvancedSection form={form} onChange={update} />
              <IdentitySection form={form} onChange={update} />
            </>
          )}
          {family === 'open_meta' && (
            <>
              <CommanderSection
                commanderIds={commanderIds}
                form={openMeta}
                onChange={updateOpenMeta}
              />
              <OpenMetaPilotSection content={content} form={openMeta} onChange={updateOpenMeta} />
              <PopulationSection form={openMeta} onChange={updateOpenMeta} />
              <AdvancedSearchSection form={openMeta} onChange={updateOpenMeta} />
              <OpenMetaWorkloadSection form={openMeta} onChange={updateOpenMeta} />
              <OpenMetaIdentitySection form={openMeta} onChange={updateOpenMeta} />
            </>
          )}
          {family === 'candidate_comparison' && (
            <CandidateComparisonSection
              content={content}
              form={candidateComparison}
              onChange={updateCandidateComparison}
            />
          )}
          {family === 'pilot_robustness' && (
            <PilotRobustnessSection
              content={content}
              form={pilotRobustness}
              onChange={updatePilotRobustness}
            />
          )}
          {family === 'engine_soak' && (
            <EngineSoakSection content={content} form={engineSoak} onChange={updateEngineSoak} />
          )}
          {family === 'card_replacement' && (
            <CardReplacementSection
              content={content}
              form={cardReplacement}
              onChange={updateCardReplacement}
            />
          )}

          <section className="panel" aria-labelledby="builder-estimate">
            <h2 id="builder-estimate">What this schedules</h2>
            <p className="panel__note">
              Counted by building the real schedule, not by a formula. Neither an estimated runtime
              nor an estimated storage size is shown: this build has never measured how long a match
              takes or how large a run directory grows, and a figure it made up would be worse than
              none.
            </p>

            {!result.ok && (
              <ul className="builder__problems" role="alert">
                {result.problems.map((problem) => (
                  <li key={`${problem.field}:${problem.message}`}>{problem.message}</li>
                ))}
              </ul>
            )}

            <p className="builder__actions">
              <button
                type="button"
                disabled={!result.ok || state.busy}
                onClick={() => void price()}
              >
                Check what this schedules
              </button>
            </p>

            {failure !== null && <Failure title="The lab refused this" failure={failure} />}

            {current === null ? (
              <Empty>
                {priced === null
                  ? 'No total yet. Ask what this configuration schedules before enqueueing it.'
                  : 'The form changed after the last total was taken, so that number is no longer about this configuration. Ask again.'}
              </Empty>
            ) : (
              <EstimateTables estimate={current} />
            )}
          </section>

          <section className="panel" aria-labelledby="builder-enqueue">
            <h2 id="builder-enqueue">Enqueue</h2>
            {current === null ? (
              <Empty>
                Enqueueing is offered once this build has told you exactly how many matches the
                configuration schedules.
              </Empty>
            ) : !('totalMatches' in current.estimate) || !('stages' in current.expansion) ? (
              <Empty>This preset does not enqueue a match schedule yet.</Empty>
            ) : (
              <>
                <p className="builder__summary">
                  {BASIS_WORDING[current.estimate.basis]}{' '}
                  <strong>{current.estimate.totalMatches.toLocaleString('en')}</strong> matches, in{' '}
                  {current.expansion.stages.length}{' '}
                  {current.expansion.stages.length === 1 ? 'job' : 'jobs'}.
                </p>
                <p className="builder__actions">
                  <button type="button" disabled={state.busy} onClick={() => void enqueue()}>
                    Enqueue this test batch
                  </button>
                </p>
              </>
            )}
            {enqueued !== null && <EnqueuedReport result={enqueued} />}
          </section>

          <SavedSection
            presetId={
              family === 'benchmark' ? form.presetId : family === 'open_meta' ? 'open_meta' : family
            }
            deckCount={
              family === 'benchmark'
                ? form.preconIds.length
                : family === 'candidate_comparison'
                  ? candidateComparison.referencePreconIds.length
                  : family === 'pilot_robustness'
                    ? pilotRobustness.preconIds.length
                    : family === 'engine_soak'
                      ? engineSoak.preconIds.length
                      : family === 'card_replacement'
                        ? cardReplacement.baseDeckPreconIds.length +
                          cardReplacement.opponentPreconIds.length
                        : null
            }
            saveLabel={saveLabel}
            onLabel={setSaveLabel}
            onKeep={() => void keep()}
            onOpen={open}
            saved={saved}
            canSave={result.ok}
          />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- family */

function FamilySection({
  family,
  onChange,
}: {
  readonly family: Family;
  readonly onChange: (family: Family) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-family">
      <h2 id="builder-family">Test family</h2>
      <p className="panel__note">
        Two ways to schedule work from this screen: a precon benchmark plays named decks against
        each other, and an Open Meta search lets the search choose its own decks and Commanders.
      </p>
      <ul className="builder__choices">
        <li>
          <label>
            <input
              type="radio"
              name="builder-family"
              checked={family === 'benchmark'}
              onChange={() => {
                onChange('benchmark');
              }}
            />
            <span className="builder__choice-label">Precon benchmark</span>
          </label>
          <p className="builder__choice-note">Named precons, at a fixed depth or a custom one.</p>
        </li>
        <li>
          <label>
            <input
              type="radio"
              name="builder-family"
              checked={family === 'open_meta'}
              onChange={() => {
                onChange('open_meta');
              }}
            />
            <span className="builder__choice-label">Open Meta search</span>
          </label>
          <p className="builder__choice-note">
            An evolutionary search over legal Commanders and cards — discovery, not validation.
          </p>
        </li>
        <li>
          <label>
            <input
              type="radio"
              name="builder-family"
              checked={family === 'candidate_comparison'}
              onChange={() => {
                onChange('candidate_comparison');
              }}
            />
            <span className="builder__choice-label">Candidate Patch Comparison</span>
          </label>
          <p className="builder__choice-note">{PRESET_REGISTRY.candidate_comparison.summary}</p>
        </li>
        <li>
          <label>
            <input
              type="radio"
              name="builder-family"
              checked={family === 'pilot_robustness'}
              onChange={() => {
                onChange('pilot_robustness');
              }}
            />
            <span className="builder__choice-label">Pilot Robustness</span>
          </label>
          <p className="builder__choice-note">{PRESET_REGISTRY.pilot_robustness.summary}</p>
        </li>
        <li>
          <label>
            <input
              type="radio"
              name="builder-family"
              checked={family === 'engine_soak'}
              onChange={() => {
                onChange('engine_soak');
              }}
            />
            <span className="builder__choice-label">Engine Soak</span>
          </label>
          <p className="builder__choice-note">{PRESET_REGISTRY.engine_soak.summary}</p>
        </li>
        <li>
          <label>
            <input
              type="radio"
              name="builder-family"
              checked={family === 'card_replacement'}
              onChange={() => {
                onChange('card_replacement');
              }}
            />
            <span className="builder__choice-label">Card Replacement</span>
          </label>
          <p className="builder__choice-note">{PRESET_REGISTRY.card_replacement.summary}</p>
        </li>
      </ul>
    </section>
  );
}

/** A preset's own limitations, shown wherever its family is selected. */
function LimitationsNotice({ limitations }: { readonly limitations: readonly string[] }) {
  return (
    <ul className="builder__limitations">
      {limitations.map((limitation) => (
        <li key={limitation}>{limitation}</li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ depth */

function DepthSection({
  presets,
  form,
  onChange,
}: {
  readonly presets: readonly ExperimentPresetDefinitionValue[];
  readonly form: BuilderForm;
  readonly onChange: (change: Partial<BuilderForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-depth">
      <h2 id="builder-depth">Depth</h2>
      <p className="panel__note">
        The three depths are the same test, and each publishes what its results may not be cited
        for. Choosing one sets the games per seat order; the advanced controls below can override
        it, and say so.
      </p>
      {presets.length === 0 ? (
        <Empty>This build published no precon-benchmark preset.</Empty>
      ) : (
        <ul className="builder__choices">
          {presets.map((preset) => (
            <li key={preset.id}>
              <label>
                <input
                  type="radio"
                  name="builder-depth"
                  value={preset.id}
                  checked={form.presetId === preset.id}
                  onChange={() => {
                    const id = preset.id as BuilderPresetId;
                    onChange({
                      presetId: id,
                      experimentId: preset.id.replace(/_/g, '-'),
                      gamesPerSeatOrder: PRESET_DEPTHS[id],
                    });
                  }}
                />
                <span className="builder__choice-label">{preset.label}</span>
              </label>
              <p className="builder__choice-note">{preset.summary}</p>
              <ul className="builder__limitations">
                {preset.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- precons */

function PreconSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: BuilderForm;
  readonly onChange: (change: Partial<BuilderForm>) => void;
}) {
  const playable = content.precons.filter((precon) => precon.refusals.length === 0);
  const chosen = new Set(form.preconIds);

  return (
    <section className="panel" aria-labelledby="builder-precons">
      <h2 id="builder-precons">Decks</h2>
      <p className="panel__note">
        The precons <code>{content.formatId}</code> publishes, as this lab resolves them right now.
        Each pairing is played in every seat order the advanced controls allow.
      </p>
      <p className="builder__actions">
        <button
          type="button"
          onClick={() => {
            onChange({ preconIds: playable.map((precon) => precon.preconId) });
          }}
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => {
            onChange({ preconIds: [] });
          }}
        >
          Clear selection
        </button>
      </p>
      {content.precons.length === 0 ? (
        <Empty>This format publishes no precon, so there is nothing to benchmark.</Empty>
      ) : (
        <ul className="builder__choices">
          {content.precons.map((precon) => {
            const refused = precon.refusals.length > 0;
            return (
              <li key={precon.preconId} className={refused ? 'is-refused' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(precon.preconId)}
                    disabled={refused}
                    onChange={(event) => {
                      const next = new Set(form.preconIds);
                      if (event.target.checked) next.add(precon.preconId);
                      else next.delete(precon.preconId);
                      onChange({
                        preconIds: content.precons
                          .map((entry) => entry.preconId)
                          .filter((id) => next.has(id)),
                      });
                    }}
                  />
                  <span className="builder__choice-label">{precon.name}</span>
                </label>
                <p className="builder__choice-note">
                  {precon.strategy} · {precon.cardCount} cards under{' '}
                  <code>{precon.commanderId}</code>
                </p>
                {refused && (
                  <ul className="builder__limitations" role="note">
                    {precon.refusals.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- pilots */

function PilotSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: BuilderForm;
  readonly onChange: (change: Partial<BuilderForm>) => void;
}) {
  const chosen = new Set(form.pilotIds);
  const anyPlayQuality = content.pilots.some(
    (pilot) => chosen.has(pilot.pilotId) && pilot.playQualityEvidence,
  );

  return (
    <section className="panel" aria-labelledby="builder-pilots">
      <h2 id="builder-pilots">Pilots</h2>
      <p className="panel__note">
        Every pilot in the selection flies the decks, and a run reports each agent class separately
        rather than averaged with the others.
      </p>
      <ul className="builder__choices">
        {content.pilots.map((pilot) => (
          <li key={pilot.pilotId}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(pilot.pilotId)}
                onChange={(event) => {
                  const next = new Set(form.pilotIds);
                  if (event.target.checked) next.add(pilot.pilotId);
                  else next.delete(pilot.pilotId);
                  onChange({
                    pilotIds: content.pilots
                      .map((entry) => entry.pilotId)
                      .filter((id) => next.has(id)),
                  });
                }}
              />
              <span className="builder__choice-label">{pilot.pilotId}</span>
            </label>
            <p className="builder__choice-note">
              Agent class <code>{pilot.agentClass}</code>.{' '}
              {pilot.playQualityEvidence
                ? 'Can carry a claim about how well the game was played.'
                : 'Makes no attempt to play well, so it is engine evidence and never balance evidence.'}
            </p>
          </li>
        ))}
      </ul>
      {form.pilotIds.length > 0 && !anyPlayQuality && (
        <p className="notice notice--warning" role="status">
          {NO_PLAY_QUALITY_CAVEAT}
        </p>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- workload */

function WorkloadSection({
  form,
  onChange,
  maxWorkers,
}: {
  readonly form: BuilderForm;
  readonly onChange: (change: Partial<BuilderForm>) => void;
  readonly maxWorkers: number;
}) {
  return (
    <section className="panel" aria-labelledby="builder-workload">
      <h2 id="builder-workload">Workload</h2>

      <fieldset className="builder__field">
        <legend>Games per seat order</legend>
        <label>
          <input
            type="radio"
            name="builder-workload"
            checked={form.workloadMode === 'preset'}
            onChange={() => {
              onChange({ workloadMode: 'preset' });
            }}
          />
          <span>Use the depth this preset chose ({PRESET_DEPTHS[form.presetId]})</span>
        </label>
        <label>
          <input
            type="radio"
            name="builder-workload"
            checked={form.workloadMode === 'custom'}
            onChange={() => {
              onChange({ workloadMode: 'custom' });
            }}
          />
          <span>Set my own</span>
        </label>
        <label>
          <span>Games per seat order</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={form.gamesPerSeatOrder}
            disabled={form.workloadMode !== 'custom'}
            onChange={(event) => {
              onChange({ gamesPerSeatOrder: Number(event.target.value) });
            }}
          />
        </label>
        {form.workloadMode === 'custom' && (
          <p className="builder__choice-note">
            The result will carry this preset&rsquo;s name and not the support that name implies.
            The run records who chose the depth.
          </p>
        )}
      </fieldset>

      <label className="builder__field">
        <span>Independent replicates</span>
        <input
          type="number"
          min={1}
          max={16}
          value={form.replicates}
          onChange={(event) => {
            onChange({ replicates: Number(event.target.value) });
          }}
        />
      </label>
      <p className="builder__choice-note">
        Each replicate is a separate run on its own seed family, with its own experiment directory.
        This build does not pool them into one number.
      </p>

      <label className="builder__field">
        <span>Keep a replay for one match in</span>
        <input
          type="number"
          min={0}
          max={100000}
          value={form.replaySampleRate}
          onChange={(event) => {
            onChange({ replaySampleRate: Number(event.target.value) });
          }}
        />
      </label>
      <p className="builder__choice-note">
        0 keeps none and 1 keeps all. Abnormal matches are retained whatever this says. Full action
        and decision logs are not offered: they hold every match in memory for the length of the
        run.
      </p>

      <label className="builder__field">
        <span>Simulator threads to ask for</span>
        <input
          type="number"
          min={1}
          max={maxWorkers}
          value={form.workers}
          onChange={(event) => {
            onChange({ workers: Number(event.target.value) });
          }}
        />
      </label>
      <p className="builder__choice-note">
        A request, not a grant. This lab allows at most {maxWorkers} per job and hands out the
        smallest of what was asked for, what one job may have and what is free.
      </p>
    </section>
  );
}

/* --------------------------------------------------------------- advanced */

function AdvancedSection({
  form,
  onChange,
}: {
  readonly form: BuilderForm;
  readonly onChange: (change: Partial<BuilderForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-advanced">
      <h2 id="builder-advanced">Advanced</h2>
      <details open={!form.mirrorSeats}>
        <summary>Seat orders</summary>
        <label className="builder__field">
          <input
            type="checkbox"
            checked={form.mirrorSeats}
            onChange={(event) => {
              onChange({ mirrorSeats: event.target.checked });
            }}
          />
          <span>Play every pairing in both seat orders</span>
        </label>
        {form.mirrorSeats ? (
          <p className="builder__choice-note">
            On, which is the default. Both seat orders are what lets a win rate be read as deck
            strength rather than as seat advantage.
          </p>
        ) : (
          <p className="notice notice--warning" role="status">
            Each pairing will be played one way round only. A win rate from this run cannot separate
            deck strength from seat advantage, and comparing it against a mirrored run compares two
            different measurements. The run records that this was turned off.
          </p>
        )}
      </details>
    </section>
  );
}

/* --------------------------------------------------------------- identity */

function IdentitySection({
  form,
  onChange,
}: {
  readonly form: BuilderForm;
  readonly onChange: (change: Partial<BuilderForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-identity">
      <h2 id="builder-identity">Name and seed</h2>
      <label className="builder__field">
        <span>Batch label</span>
        <input
          type="text"
          value={form.batchLabel}
          onChange={(event) => {
            onChange({ batchLabel: event.target.value });
          }}
        />
      </label>
      <label className="builder__field">
        <span>Experiment name</span>
        <input
          type="text"
          value={form.experimentId}
          onChange={(event) => {
            onChange({ experimentId: event.target.value });
          }}
        />
      </label>
      <p className="builder__choice-note">
        Lowercase, starting with a letter, hyphens and underscores inside.
      </p>
      <label className="builder__field">
        <span>Seed</span>
        <input
          type="text"
          value={form.seed}
          onChange={(event) => {
            onChange({ seed: event.target.value });
          }}
        />
      </label>
      <p className="builder__choice-note">
        Everything else is derived from it. The same seed and the same configuration reproduce the
        same run.
      </p>
    </section>
  );
}

/* -------------------------------------------------------- open meta: commanders */

function CommanderSection({
  commanderIds,
  form,
  onChange,
}: {
  readonly commanderIds: readonly string[];
  readonly form: OpenMetaForm;
  readonly onChange: (change: Partial<OpenMetaForm>) => void;
}) {
  const chosen = new Set(form.commanderIds);
  return (
    <section className="panel" aria-labelledby="builder-commanders">
      <h2 id="builder-commanders">Commanders</h2>
      <p className="panel__note">
        Every legal Commander is still &ldquo;open&rdquo;. Scoping the search to a selection asks
        the same question about a narrower field, rather than a different question.
      </p>
      <fieldset className="builder__field">
        <legend>Which Commanders the search may choose</legend>
        <label>
          <input
            type="radio"
            name="builder-commander-scope"
            checked={form.commanderScope === 'all'}
            onChange={() => {
              onChange({ commanderScope: 'all' });
            }}
          />
          <span>Every legal Commander</span>
        </label>
        <label>
          <input
            type="radio"
            name="builder-commander-scope"
            checked={form.commanderScope === 'selected'}
            onChange={() => {
              onChange({ commanderScope: 'selected' });
            }}
          />
          <span>A selection</span>
        </label>
      </fieldset>

      {form.commanderScope === 'selected' &&
        (commanderIds.length === 0 ? (
          <Empty>This build has no playable Commander to select from.</Empty>
        ) : (
          <ul className="builder__choices">
            {commanderIds.map((commanderId) => (
              <li key={commanderId}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(commanderId)}
                    onChange={(event) => {
                      const next = new Set(form.commanderIds);
                      if (event.target.checked) next.add(commanderId);
                      else next.delete(commanderId);
                      onChange({
                        commanderIds: commanderIds.filter((id) => next.has(id)),
                      });
                    }}
                  />
                  <span className="builder__choice-label">
                    <code>{commanderId}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

/* -------------------------------------------------------- open meta: pilots */

function OpenMetaPilotSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: OpenMetaForm;
  readonly onChange: (change: Partial<OpenMetaForm>) => void;
}) {
  const chosen = new Set(form.pilotIds);
  const anyPlayQuality = content.pilots.some(
    (pilot) => chosen.has(pilot.pilotId) && pilot.playQualityEvidence,
  );
  return (
    <section className="panel" aria-labelledby="builder-open-meta-pilots">
      <h2 id="builder-open-meta-pilots">Pilots</h2>
      <p className="panel__note">Every pilot in the selection flies the decks the search finds.</p>
      <ul className="builder__choices">
        {content.pilots.map((pilot) => (
          <li key={pilot.pilotId}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(pilot.pilotId)}
                onChange={(event) => {
                  const next = new Set(form.pilotIds);
                  if (event.target.checked) next.add(pilot.pilotId);
                  else next.delete(pilot.pilotId);
                  onChange({
                    pilotIds: content.pilots
                      .map((entry) => entry.pilotId)
                      .filter((id) => next.has(id)),
                  });
                }}
              />
              <span className="builder__choice-label">{pilot.pilotId}</span>
            </label>
            <p className="builder__choice-note">
              Agent class <code>{pilot.agentClass}</code>.{' '}
              {pilot.playQualityEvidence
                ? 'Can carry a claim about how well the game was played.'
                : 'Makes no attempt to play well, so it is engine evidence and never balance evidence.'}
            </p>
          </li>
        ))}
      </ul>
      {form.pilotIds.length > 0 && !anyPlayQuality && (
        <p className="notice notice--warning" role="status">
          {NO_PLAY_QUALITY_CAVEAT}
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------- open meta: population */

function PopulationSection({
  form,
  onChange,
}: {
  readonly form: OpenMetaForm;
  readonly onChange: (change: Partial<OpenMetaForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-population">
      <h2 id="builder-population">Population and seed policy</h2>
      <label className="builder__field">
        <span>Population size</span>
        <input
          type="number"
          min={4}
          max={500}
          value={form.populationSize}
          onChange={(event) => {
            onChange({ populationSize: Number(event.target.value) });
          }}
        />
      </label>
      <label className="builder__field">
        <span>Generations</span>
        <input
          type="number"
          min={1}
          max={500}
          value={form.generations}
          onChange={(event) => {
            onChange({ generations: Number(event.target.value) });
          }}
        />
      </label>

      <fieldset className="builder__field">
        <legend>Seed policy</legend>
        <label className="builder__field">
          <span>Authored deck plan (blank is unconstrained generation)</span>
          <input
            type="text"
            value={form.planId}
            onChange={(event) => {
              onChange({ planId: event.target.value });
            }}
          />
        </label>
        <p className="builder__choice-note">
          {form.planId.trim() === ''
            ? 'Unconstrained: generation is not seeded from any authored plan.'
            : 'Every generated deck is seeded from this plan, which also fixes its Commander.'}
        </p>
      </fieldset>
    </section>
  );
}

/* -------------------------------------------------------- open meta: advanced */

function AdvancedSearchSection({
  form,
  onChange,
}: {
  readonly form: OpenMetaForm;
  readonly onChange: (change: Partial<OpenMetaForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-search-advanced">
      <h2 id="builder-search-advanced">Advanced search settings</h2>
      <details>
        <summary>Elite, mutation and crossover</summary>
        <label className="builder__field">
          <span>Elites carried forward each generation</span>
          <input
            type="number"
            min={1}
            max={100}
            value={form.eliteCount}
            onChange={(event) => {
              onChange({ eliteCount: Number(event.target.value) });
            }}
          />
        </label>
        <label className="builder__field">
          <span>Mutation strength (card swaps per mutation)</span>
          <input
            type="number"
            min={1}
            max={20}
            value={form.mutationStrength}
            onChange={(event) => {
              onChange({ mutationStrength: Number(event.target.value) });
            }}
          />
        </label>
        <label className="builder__field">
          <span>Crossover share</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={form.crossoverShare}
            onChange={(event) => {
              onChange({ crossoverShare: Number(event.target.value) });
            }}
          />
        </label>
      </details>
      <details>
        <summary>Opponents and archive</summary>
        <label className="builder__field">
          <span>Opponents sampled per evaluation</span>
          <input
            type="number"
            min={1}
            max={64}
            value={form.opponentsPerEvaluation}
            onChange={(event) => {
              onChange({ opponentsPerEvaluation: Number(event.target.value) });
            }}
          />
        </label>
        <label className="builder__field">
          <span>Games per opponent</span>
          <input
            type="number"
            min={1}
            max={100}
            value={form.gamesPerOpponent}
            onChange={(event) => {
              onChange({ gamesPerOpponent: Number(event.target.value) });
            }}
          />
        </label>
        <label className="builder__field">
          <span>Archive size (hall of fame)</span>
          <input
            type="number"
            min={1}
            max={500}
            value={form.archiveSize}
            onChange={(event) => {
              onChange({ archiveSize: Number(event.target.value) });
            }}
          />
        </label>
      </details>
    </section>
  );
}

/* -------------------------------------------------------- open meta: workload */

function OpenMetaWorkloadSection({
  form,
  onChange,
}: {
  readonly form: OpenMetaForm;
  readonly onChange: (change: Partial<OpenMetaForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-open-meta-workload">
      <h2 id="builder-open-meta-workload">Replicates and retention</h2>
      <label className="builder__field">
        <span>Independent replicates</span>
        <input
          type="number"
          min={1}
          max={8}
          value={form.replicates}
          onChange={(event) => {
            onChange({ replicates: Number(event.target.value) });
          }}
        />
      </label>
      <p className="builder__choice-note">
        Each replicate is its own evolutionary run, on its own derived seed family within this
        experiment. This build does not pool them into one number.
      </p>
      <label className="builder__field">
        <span>Keep a replay for one match in</span>
        <input
          type="number"
          min={0}
          max={100000}
          value={form.replaySampleRate}
          onChange={(event) => {
            onChange({ replaySampleRate: Number(event.target.value) });
          }}
        />
      </label>
      <p className="builder__choice-note">
        0 keeps none and 1 keeps all. Abnormal matches are retained whatever this says.
      </p>
    </section>
  );
}

/* -------------------------------------------------------- open meta: identity */

function OpenMetaIdentitySection({
  form,
  onChange,
}: {
  readonly form: OpenMetaForm;
  readonly onChange: (change: Partial<OpenMetaForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-open-meta-identity">
      <h2 id="builder-open-meta-identity">Name and seed</h2>
      <label className="builder__field">
        <span>Batch label</span>
        <input
          type="text"
          value={form.batchLabel}
          onChange={(event) => {
            onChange({ batchLabel: event.target.value });
          }}
        />
      </label>
      <label className="builder__field">
        <span>Experiment name</span>
        <input
          type="text"
          value={form.experimentId}
          onChange={(event) => {
            onChange({ experimentId: event.target.value });
          }}
        />
      </label>
      <p className="builder__choice-note">
        Lowercase, starting with a letter, hyphens and underscores inside.
      </p>
      <label className="builder__field">
        <span>Seed</span>
        <input
          type="text"
          value={form.seed}
          onChange={(event) => {
            onChange({ seed: event.target.value });
          }}
        />
      </label>
      <p className="builder__choice-note">
        Everything else is derived from it. The same seed and the same configuration reproduce the
        same run.
      </p>
    </section>
  );
}

/* -------------------------------------------------------- templates: shared */

/** A generic precon checklist, for the four families with no depth/mirror controls of their own. */
function PreconChecklist({
  content,
  selected,
  onChange,
  heading,
  note,
}: {
  readonly content: ContentCatalog;
  readonly selected: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
  readonly heading: string;
  readonly note: string;
}) {
  const chosen = new Set(selected);
  return (
    <fieldset className="builder__field">
      <legend>{heading}</legend>
      <p className="builder__choice-note">{note}</p>
      {content.precons.length === 0 ? (
        <Empty>This format publishes no precon.</Empty>
      ) : (
        <ul className="builder__choices">
          {content.precons.map((precon) => {
            const refused = precon.refusals.length > 0;
            return (
              <li key={precon.preconId} className={refused ? 'is-refused' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(precon.preconId)}
                    disabled={refused}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(precon.preconId);
                      else next.delete(precon.preconId);
                      onChange(
                        content.precons.map((entry) => entry.preconId).filter((id) => next.has(id)),
                      );
                    }}
                  />
                  <span className="builder__choice-label">{precon.name}</span>
                </label>
                <p className="builder__choice-note">
                  {precon.strategy} · {precon.cardCount} cards under{' '}
                  <code>{precon.commanderId}</code>
                </p>
                {refused && (
                  <ul className="builder__limitations" role="note">
                    {precon.refusals.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

/** A generic pilot checklist, for the three families with a pilot field. */
function PilotChecklist({
  content,
  selected,
  onChange,
  heading,
}: {
  readonly content: ContentCatalog;
  readonly selected: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
  readonly heading: string;
}) {
  const chosen = new Set(selected);
  const anyPlayQuality = content.pilots.some(
    (pilot) => chosen.has(pilot.pilotId) && pilot.playQualityEvidence,
  );
  return (
    <fieldset className="builder__field">
      <legend>{heading}</legend>
      <ul className="builder__choices">
        {content.pilots.map((pilot) => (
          <li key={pilot.pilotId}>
            <label>
              <input
                type="checkbox"
                checked={chosen.has(pilot.pilotId)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(pilot.pilotId);
                  else next.delete(pilot.pilotId);
                  onChange(
                    content.pilots.map((entry) => entry.pilotId).filter((id) => next.has(id)),
                  );
                }}
              />
              <span className="builder__choice-label">{pilot.pilotId}</span>
            </label>
            <p className="builder__choice-note">
              Agent class <code>{pilot.agentClass}</code>.{' '}
              {pilot.playQualityEvidence
                ? 'Can carry a claim about how well the game was played.'
                : 'Makes no attempt to play well, so it is engine evidence and never balance evidence.'}
            </p>
          </li>
        ))}
      </ul>
      {selected.length > 0 && !anyPlayQuality && (
        <p className="notice notice--warning" role="status">
          {NO_PLAY_QUALITY_CAVEAT}
        </p>
      )}
    </fieldset>
  );
}

/** A free-text identifier field. Nothing here validates a listed identifier — the service does. */
function IdListField({
  label,
  note,
  value,
  onChange,
}: {
  readonly label: string;
  readonly note: string;
  readonly value: string;
  readonly onChange: (raw: string) => void;
}) {
  return (
    <>
      <label className="builder__field">
        <span>{label}</span>
        <input
          type="text"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </label>
      <p className="builder__choice-note">{note}</p>
    </>
  );
}

/** The `number(1-4) | 'all'` copies union, as a mode toggle plus a bounded count. */
function CopiesField({
  label,
  mode,
  count,
  onChange,
}: {
  readonly label: string;
  readonly mode: 'all' | 'custom';
  readonly count: number;
  readonly onChange: (mode: 'all' | 'custom', count: number) => void;
}) {
  return (
    <fieldset className="builder__field">
      <legend>{label}</legend>
      <label>
        <input
          type="radio"
          checked={mode === 'all'}
          onChange={() => {
            onChange('all', count);
          }}
        />
        <span>All copies</span>
      </label>
      <label>
        <input
          type="radio"
          checked={mode === 'custom'}
          onChange={() => {
            onChange('custom', count);
          }}
        />
        <span>A number of copies</span>
      </label>
      <input
        type="number"
        min={1}
        max={4}
        value={count}
        disabled={mode !== 'custom'}
        onChange={(event) => {
          onChange('custom', Number(event.target.value));
        }}
      />
    </fieldset>
  );
}

/** Games per seat order, the only workload knob these four presets expose. */
function TemplateWorkloadSection<T extends { gamesPerSeatOrder: number }>({
  form,
  onChange,
  max,
}: {
  readonly form: T;
  readonly onChange: (change: Partial<T>) => void;
  readonly max: number;
}) {
  return (
    <section className="panel" aria-labelledby="builder-template-workload">
      <h2 id="builder-template-workload">Workload</h2>
      <label className="builder__field">
        <span>Games per seat order</span>
        <input
          type="number"
          min={1}
          max={max}
          value={form.gamesPerSeatOrder}
          onChange={(event) => {
            onChange({ gamesPerSeatOrder: Number(event.target.value) } as Partial<T>);
          }}
        />
      </label>
    </section>
  );
}

/** Name and seed, shared verbatim across the four template families. */
function TemplateIdentitySection<
  T extends { batchLabel: string; experimentId: string; seed: string },
>({ form, onChange }: { readonly form: T; readonly onChange: (change: Partial<T>) => void }) {
  return (
    <section className="panel" aria-labelledby="builder-template-identity">
      <h2 id="builder-template-identity">Name and seed</h2>
      <label className="builder__field">
        <span>Batch label</span>
        <input
          type="text"
          value={form.batchLabel}
          onChange={(event) => {
            onChange({ batchLabel: event.target.value } as Partial<T>);
          }}
        />
      </label>
      <label className="builder__field">
        <span>Experiment name</span>
        <input
          type="text"
          value={form.experimentId}
          onChange={(event) => {
            onChange({ experimentId: event.target.value } as Partial<T>);
          }}
        />
      </label>
      <p className="builder__choice-note">
        Lowercase, starting with a letter, hyphens and underscores inside.
      </p>
      <label className="builder__field">
        <span>Seed</span>
        <input
          type="text"
          value={form.seed}
          onChange={(event) => {
            onChange({ seed: event.target.value } as Partial<T>);
          }}
        />
      </label>
      <p className="builder__choice-note">
        Everything else is derived from it. The same seed and the same configuration reproduce the
        same run.
      </p>
    </section>
  );
}

/* -------------------------------------------------- templates: candidate comparison */

function CandidateComparisonSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: CandidateComparisonForm;
  readonly onChange: (change: Partial<CandidateComparisonForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-candidate-comparison">
      <h2 id="builder-candidate-comparison">Candidate Patch Comparison</h2>
      <p className="panel__note">{PRESET_REGISTRY.candidate_comparison.summary}</p>
      <LimitationsNotice limitations={PRESET_REGISTRY.candidate_comparison.limitations} />

      <PreconChecklist
        content={content}
        selected={form.referencePreconIds}
        onChange={(referencePreconIds) => {
          onChange({ referencePreconIds });
        }}
        heading="Reference decks"
        note="Played unchanged in both environments."
      />
      <PilotChecklist
        content={content}
        selected={form.pilotIds}
        onChange={(pilotIds) => {
          onChange({ pilotIds });
        }}
        heading="Pilots"
      />

      <fieldset className="builder__field">
        <legend>The candidate change</legend>
        <IdListField
          label="Remove cards (identifiers, comma or newline separated)"
          note="Cards removed from the candidate environment's pool."
          value={form.removeCardIdsRaw}
          onChange={(removeCardIdsRaw) => {
            onChange({ removeCardIdsRaw });
          }}
        />

        <p className="builder__choice-note">
          Card patches: up to three numeric balance dials per card — cost, attack, health. Leave a
          dial blank to leave it unchanged.
        </p>
        {form.cardPatchRows.map((row, index) => (
          <fieldset className="builder__field" key={index}>
            <legend>Patch {index + 1}</legend>
            <label>
              <span>Card ID</span>
              <input
                type="text"
                value={row.cardId}
                onChange={(event) => {
                  const next = form.cardPatchRows.map((entry, i) =>
                    i === index ? { ...entry, cardId: event.target.value } : entry,
                  );
                  onChange({ cardPatchRows: next });
                }}
              />
            </label>
            <label>
              <span>Cost</span>
              <input
                type="text"
                value={row.cost}
                onChange={(event) => {
                  const next = form.cardPatchRows.map((entry, i) =>
                    i === index ? { ...entry, cost: event.target.value } : entry,
                  );
                  onChange({ cardPatchRows: next });
                }}
              />
            </label>
            <label>
              <span>Attack</span>
              <input
                type="text"
                value={row.attack}
                onChange={(event) => {
                  const next = form.cardPatchRows.map((entry, i) =>
                    i === index ? { ...entry, attack: event.target.value } : entry,
                  );
                  onChange({ cardPatchRows: next });
                }}
              />
            </label>
            <label>
              <span>Health</span>
              <input
                type="text"
                value={row.health}
                onChange={(event) => {
                  const next = form.cardPatchRows.map((entry, i) =>
                    i === index ? { ...entry, health: event.target.value } : entry,
                  );
                  onChange({ cardPatchRows: next });
                }}
              />
            </label>
            <p className="builder__actions">
              <button
                type="button"
                onClick={() => {
                  onChange({ cardPatchRows: form.cardPatchRows.filter((_, i) => i !== index) });
                }}
              >
                Remove this patch
              </button>
            </p>
          </fieldset>
        ))}
        <p className="builder__actions">
          <button
            type="button"
            onClick={() => {
              onChange({ cardPatchRows: [...form.cardPatchRows, EMPTY_CARD_PATCH_ROW] });
            }}
          >
            Add a card patch
          </button>
        </p>

        <label>
          <input
            type="checkbox"
            checked={form.searchBothEnvironments}
            onChange={(event) => {
              onChange({ searchBothEnvironments: event.target.checked });
            }}
          />
          <span>Also run an independent search in both environments</span>
        </label>
      </fieldset>

      <TemplateWorkloadSection form={form} onChange={onChange} max={200} />
      <TemplateIdentitySection form={form} onChange={onChange} />
    </section>
  );
}

/* -------------------------------------------------- templates: pilot robustness */

function PilotRobustnessSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: PilotRobustnessForm;
  readonly onChange: (change: Partial<PilotRobustnessForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-pilot-robustness">
      <h2 id="builder-pilot-robustness">Pilot Robustness</h2>
      <p className="panel__note">{PRESET_REGISTRY.pilot_robustness.summary}</p>
      <LimitationsNotice limitations={PRESET_REGISTRY.pilot_robustness.limitations} />

      <PreconChecklist
        content={content}
        selected={form.preconIds}
        onChange={(preconIds) => {
          onChange({ preconIds });
        }}
        heading="Decks"
        note="Played by every perturbation profile below, on identical seeds."
      />
      <PilotChecklist
        content={content}
        selected={form.pilotIds}
        onChange={(pilotIds) => {
          onChange({ pilotIds });
        }}
        heading="Pilots"
      />
      <IdListField
        label="Perturbation profiles (identifiers, comma or newline separated)"
        note="`published` is always the reference arm, whether or not it is listed here."
        value={form.profileIdsRaw}
        onChange={(profileIdsRaw) => {
          onChange({ profileIdsRaw });
        }}
      />

      <TemplateWorkloadSection form={form} onChange={onChange} max={200} />
      <TemplateIdentitySection form={form} onChange={onChange} />
    </section>
  );
}

/* -------------------------------------------------- templates: engine soak */

function EngineSoakSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: EngineSoakForm;
  readonly onChange: (change: Partial<EngineSoakForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-engine-soak">
      <h2 id="builder-engine-soak">Engine Soak</h2>
      <p className="panel__note">{PRESET_REGISTRY.engine_soak.summary}</p>
      <LimitationsNotice limitations={PRESET_REGISTRY.engine_soak.limitations} />

      <PreconChecklist
        content={content}
        selected={form.preconIds}
        onChange={(preconIds) => {
          onChange({ preconIds });
        }}
        heading="Decks"
        note="Flown by the random-legal pilot only; there is no pilot selection for a soak run."
      />

      <TemplateWorkloadSection form={form} onChange={onChange} max={500} />
      <TemplateIdentitySection form={form} onChange={onChange} />
    </section>
  );
}

/* -------------------------------------------------- templates: card replacement */

function CardReplacementSection({
  content,
  form,
  onChange,
}: {
  readonly content: ContentCatalog;
  readonly form: CardReplacementForm;
  readonly onChange: (change: Partial<CardReplacementForm>) => void;
}) {
  return (
    <section className="panel" aria-labelledby="builder-card-replacement">
      <h2 id="builder-card-replacement">Card Replacement</h2>
      <p className="panel__note">{PRESET_REGISTRY.card_replacement.summary}</p>
      <LimitationsNotice limitations={PRESET_REGISTRY.card_replacement.limitations} />

      <PreconChecklist
        content={content}
        selected={form.baseDeckPreconIds}
        onChange={(baseDeckPreconIds) => {
          onChange({ baseDeckPreconIds });
        }}
        heading="Base decks"
        note="Decks the substitution is applied to."
      />
      <PreconChecklist
        content={content}
        selected={form.opponentPreconIds}
        onChange={(opponentPreconIds) => {
          onChange({ opponentPreconIds });
        }}
        heading="Opponent field"
        note="The fixed opponent field every variant is measured against."
      />
      <PilotChecklist
        content={content}
        selected={form.pilotIds}
        onChange={(pilotIds) => {
          onChange({ pilotIds });
        }}
        heading="Pilots"
      />

      <label className="builder__field">
        <span>Subject card ID</span>
        <input
          type="text"
          value={form.subjectCardId}
          onChange={(event) => {
            onChange({ subjectCardId: event.target.value });
          }}
        />
      </label>
      <p className="builder__choice-note">The card taken out of the base decks.</p>

      <IdListField
        label="Candidate replacements (identifiers, comma or newline separated)"
        note="Empty means the simulator picks comparable cards automatically by cost, type, role, tags, colour legality and power class."
        value={form.candidateCardIdsRaw}
        onChange={(candidateCardIdsRaw) => {
          onChange({ candidateCardIdsRaw });
        }}
      />

      <CopiesField
        label="Copies swapped out per variant"
        mode={form.copiesMode}
        count={form.copiesCount}
        onChange={(copiesMode, copiesCount) => {
          onChange({ copiesMode, copiesCount });
        }}
      />

      <label className="builder__field">
        <input
          type="checkbox"
          checked={form.includeInsertion}
          onChange={(event) => {
            onChange({ includeInsertion: event.target.checked });
          }}
        />
        <span>Also insert the subject into base decks that do not run it</span>
      </label>

      {form.includeInsertion && (
        <>
          <CopiesField
            label="Copies inserted per insertion variant"
            mode={form.insertionCopiesMode}
            count={form.insertionCopiesCount}
            onChange={(insertionCopiesMode, insertionCopiesCount) => {
              onChange({ insertionCopiesMode, insertionCopiesCount });
            }}
          />
          <IdListField
            label="Cards that must pay for an insertion, in priority order"
            note="Empty means the builder ranks the base deck's own cards by comparability to the inserted card."
            value={form.insertionRemoveCardIdsRaw}
            onChange={(insertionRemoveCardIdsRaw) => {
              onChange({ insertionRemoveCardIdsRaw });
            }}
          />
        </>
      )}

      <TemplateWorkloadSection form={form} onChange={onChange} max={200} />
      <TemplateIdentitySection form={form} onChange={onChange} />
    </section>
  );
}

/* --------------------------------------------------------------- estimate */

function EstimateTables({ estimate }: { readonly estimate: ChoiceEstimate }) {
  if (!('totalMatches' in estimate.estimate) || !('stages' in estimate.expansion)) {
    return (
      <Empty>
        This preset does not schedule matches the same way; there is no stage table for it yet.
      </Empty>
    );
  }
  return (
    <div className="builder__estimate">
      <p className="builder__summary">
        {BASIS_WORDING[estimate.estimate.basis]}{' '}
        <strong>{estimate.estimate.totalMatches.toLocaleString('en')}</strong> matches.
      </p>

      <table className="facts">
        <caption>Stages this configuration schedules</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Matches</th>
            <th scope="col">Games per seat order</th>
            <th scope="col">Decks</th>
            <th scope="col">Pilot tuples</th>
            <th scope="col">Seat orders</th>
          </tr>
        </thead>
        <tbody>
          {estimate.estimate.stages.map((stage) => (
            <tr key={stage.stageId}>
              <th scope="row">{stage.label}</th>
              <td>{stage.matches.toLocaleString('en')}</td>
              <td>{stage.gamesPerSeatOrder}</td>
              <td>{stage.decks.count}</td>
              <td>{stage.pilotTuples}</td>
              <td>
                {stage.seatOrders
                  .map((entry) => `${String(entry.orientation)}: ${String(entry.matches)}`)
                  .join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {estimate.estimate.forcedInclusion.length > 0 && (
        <>
          <table className="facts">
            <caption>What the format leaves each Commander</caption>
            <thead>
              <tr>
                <th scope="col">Commander</th>
                <th scope="col">Legal pool</th>
                <th scope="col">Deck size</th>
                <th scope="col">Forced-inclusion floor</th>
              </tr>
            </thead>
            <tbody>
              {estimate.estimate.forcedInclusion.map((floor) => (
                <tr key={floor.commanderId}>
                  <th scope="row">{floor.commanderId}</th>
                  <td>{floor.legalPoolSize}</td>
                  <td>{floor.deckSize}</td>
                  <td>{floor.forcedInclusionFloor}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="builder__choice-note">{FORCED_INCLUSION_CAVEAT}</p>
        </>
      )}

      <h3>What a result from this may not be cited for</h3>
      <ul className="builder__limitations">
        {estimate.estimate.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </div>
  );
}

function EnqueuedReport({ result }: { readonly result: EnqueuePresetResult }) {
  return (
    <div className="builder__enqueued" role="status">
      <p>
        Added <strong>{result.jobs.length}</strong> {result.jobs.length === 1 ? 'job' : 'jobs'} to
        draft batch <code>{result.batchId}</code>. <strong>Nothing has started.</strong> The batch
        is a draft until it is started from Queue, which is also where its jobs can be reordered,
        duplicated or withdrawn.
      </p>
      <table className="facts">
        <caption>Jobs this added to the draft</caption>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">Label</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {result.jobs.map((job) => (
            <tr key={job.jobId}>
              <th scope="row">
                <code>{job.jobId}</code>
              </th>
              <td>{job.label}</td>
              <td>{job.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------- saved configurations */

function SavedSection({
  presetId,
  deckCount,
  saveLabel,
  onLabel,
  onKeep,
  onOpen,
  saved,
  canSave,
}: {
  readonly presetId: string;
  /** Deck count, for a precon benchmark; `null` for an Open Meta search. */
  readonly deckCount: number | null;
  readonly saveLabel: string;
  readonly onLabel: (value: string) => void;
  readonly onKeep: () => void;
  readonly onOpen: (entry: SavedChoiceView) => void;
  readonly saved: SavedChoiceView | null;
  readonly canSave: boolean;
}) {
  const session = useAdminSession();
  const state = useAdminState();
  const list = state.savedChoices;

  const openable = useMemo(
    () =>
      list.status === 'ready'
        ? list.value.items.filter(
            (entry) =>
              asBenchmarkChoice(entry.choice) !== null ||
              asOpenMetaChoice(entry.choice) !== null ||
              asCandidateComparisonChoice(entry.choice) !== null ||
              asPilotRobustnessChoice(entry.choice) !== null ||
              asEngineSoakChoice(entry.choice) !== null ||
              asCardReplacementChoice(entry.choice) !== null,
          )
        : [],
    [list],
  );

  return (
    <section className="panel" aria-labelledby="builder-saved">
      <h2 id="builder-saved">Saved configurations</h2>
      <p className="panel__note">
        Kept by the lab rather than by this browser, so they survive a reload and are visible from
        whichever browser is pointed at this process. Saving one schedules nothing.
      </p>

      <label className="builder__field">
        <span>Name this configuration</span>
        <input
          type="text"
          value={saveLabel}
          onChange={(event) => {
            onLabel(event.target.value);
          }}
        />
      </label>
      <p className="builder__actions">
        <button
          type="button"
          disabled={!canSave || saveLabel.trim() === '' || state.busy}
          onClick={onKeep}
        >
          Save this configuration
        </button>
      </p>
      {saved !== null && (
        <p className="feedback feedback--empty" role="status">
          Saved as &ldquo;{saved.label}&rdquo;. To duplicate one, open it, change what you need and
          save it under another name.
        </p>
      )}

      {list.status === 'loading' && <Busy label="Reading the configurations this lab has kept…" />}
      {list.status === 'failed' && (
        <Failure
          title="The saved configurations could not be read"
          failure={list.failure}
          onRetry={() => {
            void session.reloadSavedChoices();
          }}
          retryLabel="Ask again"
        />
      )}
      {list.status === 'ready' &&
        (openable.length === 0 ? (
          <Empty>
            This lab has kept no configuration this builder can open
            {list.value.unreadable > 0
              ? `. ${String(list.value.unreadable)} stored configuration(s) could not be read by this build.`
              : '.'}
          </Empty>
        ) : (
          <table className="facts">
            <caption>Configurations this lab has kept</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Saved</th>
                <th scope="col">Preset</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {openable.map((entry) => (
                <tr key={entry.savedChoiceId}>
                  <th scope="row">{entry.label}</th>
                  <td>{entry.timestamps.createdAt}</td>
                  <td>{entry.choice.presetId}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(entry);
                      }}
                    >
                      Open &ldquo;{entry.label}&rdquo;
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      <p className="builder__choice-note">
        The form on screen is <code>{presetId}</code>
        {deckCount === null ? '' : ` over ${String(deckCount)} deck(s)`}.
      </p>
    </section>
  );
}
