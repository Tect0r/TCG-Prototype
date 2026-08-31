import { useEffect, useMemo, useState } from 'react';

import {
  BASIS_WORDING,
  FORCED_INCLUSION_CAVEAT,
  NO_PLAY_QUALITY_CAVEAT,
  type ChoiceEstimate,
  type ContentCatalog,
  type EnqueuePresetResult,
  type ExperimentPresetDefinitionValue,
  type SavedChoiceView,
} from '@tcg/admin-contracts';

import { Busy, Empty, Failure } from './Feedback.js';
import {
  PRESET_DEPTHS,
  asBenchmarkChoice,
  benchmarkPresets,
  choiceOf,
  formFingerprint,
  formOf,
  initialForm,
  type BuilderForm,
  type BuilderPresetId,
} from '../lib/builder-form.js';
import { useAdminSession, useAdminState } from '../state/AdminContext.js';
import type { AdminFailure } from '../net/transport.js';

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
 * **No queue.** What happens after the enqueue is M08.9's screen. This one
 * reports exactly what it created — the batch, the jobs and their stages — and
 * stops.
 */
export function BuilderScreen() {
  const session = useAdminSession();
  const state = useAdminState();
  const connection = state.connection;

  const content = state.content.status === 'ready' ? state.content.value : null;
  const [form, setForm] = useState<BuilderForm>(() => initialForm(content));
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
    setSeeded(true);
  }, [content, seeded]);

  const fingerprint = formFingerprint(form);
  const result = choiceOf(form);
  const current = priced !== null && priced.fingerprint === fingerprint ? priced.estimate : null;

  const update = (change: Partial<BuilderForm>): void => {
    setForm((previous) => ({ ...previous, ...change }));
    setEnqueued(null);
    setSaved(null);
  };

  if (connection.status !== 'connected') return null;

  const presets =
    state.presets.status === 'ready' ? benchmarkPresets(state.presets.value.presets) : [];
  const maxWorkers = connection.capabilities.orchestrator.maxWorkersPerJob;

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
    const answer = await session.enqueue(form.batchLabel.trim(), result.choice);
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
    const reopened = formOf(entry.choice, entry.label);
    if (reopened === null) return;
    setForm(reopened);
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
          <DepthSection presets={presets} form={form} onChange={update} />
          <PreconSection content={content} form={form} onChange={update} />
          <PilotSection content={content} form={form} onChange={update} />
          <WorkloadSection form={form} onChange={update} maxWorkers={maxWorkers} />
          <AdvancedSection form={form} onChange={update} />
          <IdentitySection form={form} onChange={update} />

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
            form={form}
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

/* --------------------------------------------------------------- estimate */

function EstimateTables({ estimate }: { readonly estimate: ChoiceEstimate }) {
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
        Enqueued <strong>{result.jobs.length}</strong> {result.jobs.length === 1 ? 'job' : 'jobs'}{' '}
        into batch <code>{result.batchId}</code>. Work starts under this lab&rsquo;s own bound;
        nothing on this page watches it.
      </p>
      <table className="facts">
        <caption>Jobs this enqueue created</caption>
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
  form,
  saveLabel,
  onLabel,
  onKeep,
  onOpen,
  saved,
  canSave,
}: {
  readonly form: BuilderForm;
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
        ? list.value.items.filter((entry) => asBenchmarkChoice(entry.choice) !== null)
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
                <th scope="col">Depth</th>
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
        The form on screen is <code>{form.presetId}</code> over {form.preconIds.length} deck(s).
      </p>
    </section>
  );
}
