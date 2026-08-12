import type { BoardTelemetry } from './schema.js';

/**
 * Reconciling two board-telemetry documents (M04.3).
 *
 * M04's acceptance criterion is that "the same deterministic match produces
 * identical board telemetry in spectator and simulator paths". Asserting that
 * with an equality check is enough to make a test pass and not enough to make a
 * failure legible: two documents holding forty measurements each report "not
 * equal" and leave a human to find which one moved. This says which one.
 *
 * It is a comparison and not a merge. There is no resolution step, no preference
 * for either side, and nothing is written back — a disagreement between the two
 * paths is a defect in one of them, and the only useful output is the list of
 * fields that disagree.
 */

export interface BoardTelemetryReconciliation {
  /** True when the two documents are identical field for field. */
  readonly agreed: boolean;
  /**
   * Every field that differs, as `path: left !== right`, in a stable order.
   *
   * Paths are dotted with array indices in brackets, e.g.
   * `attackOpportunity.byRound[2].seatsAble`.
   */
  readonly differences: readonly string[];
}

export function reconcileBoardTelemetry(
  left: BoardTelemetry,
  right: BoardTelemetry,
): BoardTelemetryReconciliation {
  const differences: string[] = [];
  compare('', left, right, differences);
  return { agreed: differences.length === 0, differences };
}

const MAX_DIFFERENCES = 50;

function compare(path: string, left: unknown, right: unknown, out: string[]): void {
  if (out.length >= MAX_DIFFERENCES) return;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      out.push(`${path || '(root)'}: ${describe(left)} !== ${describe(right)}`);
      return;
    }
    if (left.length !== right.length) {
      out.push(`${path}.length: ${left.length} !== ${right.length}`);
      // Still walk the overlap: a length difference is usually one missing round
      // and the rest lining up, which is worth seeing.
    }
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index += 1) {
      compare(`${path}[${index}]`, left[index], right[index], out);
    }
    return;
  }

  if (isRecord(left) && isRecord(right)) {
    // Union of both key sets, sorted, so the report is identical whichever
    // document was passed first and whichever key order they serialized in.
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const next = path === '' ? key : `${path}.${key}`;
      if (!(key in left) || !(key in right)) {
        out.push(
          `${next}: ${key in left ? 'present' : 'absent'} !== ${key in right ? 'present' : 'absent'}`,
        );
        continue;
      }
      compare(next, left[key], right[key], out);
    }
    return;
  }

  if (!Object.is(left, right)) {
    out.push(`${path || '(root)'}: ${describe(left)} !== ${describe(right)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return JSON.stringify(value) ?? String(value);
}
