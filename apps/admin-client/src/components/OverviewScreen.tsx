import {
  ADMIN_API_ROOT,
  ADMIN_API_VERSION_SEGMENT,
  type Capabilities,
  type ExperimentPresetDefinitionValue,
} from '@tcg/admin-contracts';

import { FactTable, type Fact } from './FactTable.js';
import { Busy, Empty, Failure } from './Feedback.js';
import {
  EXPERIMENT_KIND_LABELS,
  PRESET_STATUS_LABELS,
  SOURCE_CLASS_LABELS,
  TEST_STYLE_LABELS,
  formatBytes,
  formatUptime,
  formatWindow,
  labelledList,
} from '../lib/vocabulary.js';
import { useAdminSession, useAdminState } from '../state/AdminContext.js';

/**
 * The one page this build has, and it holds nothing this build made up.
 *
 * Every value below is a field of the `capabilities` or `presets` answer. There
 * is no derived score, no rolled-up health colour and no number computed from
 * two others — the two things this screen calculates are how long the process
 * has been up and how large a byte limit is in KiB, and both are restatements of
 * a value that is also printed.
 *
 * ## What is deliberately absent
 *
 * **Nothing about the queue.** How many jobs are waiting, what is running and
 * how far along it is are real facts the service can answer, and they belong to
 * the screen that can act on them: M08.9 owns the queue and its ordering. An
 * Overview that counted jobs would be the first half of that screen, built
 * without the half that lets an operator do anything about what it says.
 *
 * **No automatic refresh.** The page says when it last asked and offers to ask
 * again. A poller would be choosing a cadence for state that does not change on
 * its own yet, and would keep a lab process answering requests all day for a tab
 * somebody left open.
 *
 * **No control that starts anything.** The presets are shown because *what this
 * build can run* is a capability, and their published limitations are shown
 * beside them because those limitations are what a result may never be cited
 * against. Configuring and enqueueing one is the New Test Batch screen's, which
 * M08.8 added as its own destination — this page stayed read-only.
 */
export function OverviewScreen() {
  const session = useAdminSession();
  const state = useAdminState();
  const connection = state.connection;
  if (connection.status !== 'connected') return null;

  const { capabilities, checkedAt, authenticated, restarted } = connection;

  return (
    <div className="overview">
      {restarted && (
        <p className="notice notice--warning" role="status">
          The orchestration process has restarted since this page last asked. Work that was running
          when it stopped was recovered as interrupted, and nothing resumes on its own — an operator
          has to ask.
        </p>
      )}

      <section className="panel" aria-labelledby="overview-connection">
        <h2 id="overview-connection">Connection</h2>
        <FactTable
          caption="How this page is talking to the lab"
          facts={connectionFacts(capabilities, checkedAt, authenticated)}
        />
      </section>

      <section className="panel" aria-labelledby="overview-orchestrator">
        <h2 id="overview-orchestrator">Orchestrator bound</h2>
        <p className="panel__note">
          What this machine will run at once. A job that waits is waiting on one of these three
          numbers, and they are the operator&rsquo;s configuration rather than a limit this page
          decides.
        </p>
        <FactTable caption="Resource bound" facts={orchestratorFacts(capabilities)} />
      </section>

      <section className="panel" aria-labelledby="overview-limits">
        <h2 id="overview-limits">Request limits</h2>
        <FactTable
          caption="Limits this service applies to every request"
          facts={limitFacts(capabilities)}
        />
      </section>

      <section className="panel" aria-labelledby="overview-roots">
        <h2 id="overview-roots">Evidence and format</h2>
        <p className="panel__note">
          Result roots are reported by identifier and never as a location: a request names an
          identifier the service resolves, and a path this page could print is a path a request
          could carry.
        </p>
        <FactTable
          caption="Where results are written, and what format they run"
          facts={rootFacts(capabilities)}
        />
      </section>

      <section className="panel" aria-labelledby="overview-presets">
        <h2 id="overview-presets">What this build can run</h2>
        <p className="panel__note">
          Read-only here. The precon benchmark can be configured and enqueued from New Test Batch;
          every other preset in this list is published and has no builder yet.
        </p>
        {state.presets.status === 'loading' && (
          <Busy label="Asking which tests this build offers…" />
        )}
        {state.presets.status === 'failed' && (
          <Failure
            title="The preset catalog could not be read"
            failure={state.presets.failure}
            onRetry={() => {
              void session.reloadPresets();
            }}
            retryLabel="Ask again"
          />
        )}
        {state.presets.status === 'ready' &&
          (state.presets.value.presets.length === 0 ? (
            <Empty>This build publishes no experiment presets.</Empty>
          ) : (
            <PresetTable presets={state.presets.value.presets} />
          ))}
      </section>
    </div>
  );
}

function connectionFacts(
  capabilities: Capabilities,
  checkedAt: string,
  authenticated: boolean,
): readonly Fact[] {
  return [
    {
      label: 'Address',
      value: <code>{`${ADMIN_API_ROOT}/${ADMIN_API_VERSION_SEGMENT}`}</code>,
      note: 'On this page’s own origin. The client sends no absolute address, so it can only ever reach the lab this page was served beside.',
    },
    {
      label: 'Interface',
      value: capabilities.access.loopback ? 'Loopback only' : 'Bound to a non-loopback interface',
      ...(capabilities.access.loopback
        ? {}
        : {
            note: 'The process refuses to start off loopback without a token, so this bind is authenticated.',
          }),
    },
    {
      label: 'Authentication',
      value: capabilities.access.authenticationRequired ? 'Token required' : 'No token configured',
      note: authenticated
        ? 'This tab is sending the token, and holds it in memory only.'
        : 'This tab is sending no token.',
    },
    { label: 'Admin contract version', value: capabilities.versions.contract },
    { label: 'Catalog document version', value: capabilities.versions.catalogDocument },
    { label: 'Job event version', value: capabilities.versions.jobEvent },
    {
      label: 'Saved configuration version',
      value: capabilities.versions.savedChoice,
      note: 'What a builder form kept by this lab is stamped with. It moves when a builder gains a control, and never when a batch or a job does.',
    },
    {
      label: 'Process started',
      value: capabilities.startedAt,
      note: `Up for ${formatUptime(capabilities.startedAt, checkedAt)} at the last check.`,
    },
    { label: 'Last checked', value: checkedAt },
  ];
}

function orchestratorFacts(capabilities: Capabilities): readonly Fact[] {
  const bound = capabilities.orchestrator;
  return [
    {
      label: 'Experiments at once',
      value: bound.maxConcurrentJobs,
      note: 'Jobs beyond this wait in the queue rather than being refused.',
    },
    {
      label: 'Simulator threads, total',
      value: bound.maxWorkers,
      note: 'Across every running job, so two runs share this budget rather than each having one.',
    },
    {
      label: 'Simulator threads per job',
      value: bound.maxWorkersPerJob,
      note: 'Stops one wide run taking the whole budget.',
    },
  ];
}

function limitFacts(capabilities: Capabilities): readonly Fact[] {
  const limits = capabilities.limits;
  return [
    { label: 'Largest request body', value: formatBytes(limits.maxRequestBytes) },
    {
      label: 'Requests per window',
      value: `${String(limits.requestsPerWindow)} per ${formatWindow(limits.windowMs)}`,
      note: 'A refused request does not extend the window.',
    },
    {
      label: 'Page size',
      value: `${String(limits.pageSizeDefault)} by default, ${String(limits.pageSizeMax)} at most`,
    },
    { label: 'Filter values per field', value: limits.maxFilterValues },
    { label: 'Jobs per batch', value: limits.maxJobsPerBatch },
  ];
}

function rootFacts(capabilities: Capabilities): readonly Fact[] {
  return [
    {
      label: 'Result roots',
      value: capabilities.resultRootIds.join(', '),
      note: 'Identifiers, not paths. Experiment directories stay canonical; the catalog indexes them.',
    },
    {
      label: 'Format',
      value: capabilities.formatId,
      note: 'Every preset in this build runs in this format.',
    },
  ];
}

function PresetTable({
  presets,
}: {
  readonly presets: readonly ExperimentPresetDefinitionValue[];
}) {
  return (
    <table className="presets">
      <caption className="visually-hidden">
        Experiment presets this build publishes, with what each may not be cited for
      </caption>
      <thead>
        <tr>
          <th scope="col">Preset</th>
          <th scope="col">Test style</th>
          <th scope="col">Evidence</th>
          <th scope="col">Experiment kinds</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {presets.map((preset) => (
          <tr key={preset.id} className={preset.status === 'reserved' ? 'is-reserved' : ''}>
            <th scope="row">
              <span className="presets__label">{preset.label}</span>
              <span className="presets__summary">{preset.summary}</span>
              {preset.limitations.length === 0 ? (
                <span className="presets__limitation">
                  No published limitation, because nothing can be run from it.
                </span>
              ) : (
                <ul className="presets__limitations">
                  {preset.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
            </th>
            <td>{TEST_STYLE_LABELS[preset.testStyle]}</td>
            <td>{labelledList(preset.sourceClasses, SOURCE_CLASS_LABELS)}</td>
            <td>{labelledList(preset.kinds, EXPERIMENT_KIND_LABELS)}</td>
            <td>{PRESET_STATUS_LABELS[preset.status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
