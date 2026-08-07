/* eslint-disable no-console */
import { INERT_KEYWORDS } from '../keywords.js';
import { runScriptedMatch } from './scripted-match.js';
import type { GameEvent } from '../schema/event.js';

/**
 * `npm run demo:match --workspace @tcg/rules-engine -- <seed>`
 *
 * Plays one complete scripted match and prints its structured event log. This
 * is the CLI harness required by the Phase 2A acceptance criteria: it proves the
 * engine runs a full match with no React, no server, no database and no clock.
 */

function describe(event: GameEvent): string {
  const { sequence, type, ...rest } = event as GameEvent & Record<string, unknown>;
  delete (rest as Record<string, unknown>).cause;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return `${String(sequence).padStart(4, ' ')}  ${type.padEnd(22, ' ')} ${detail}`;
}

const seed = process.argv[2] ?? 'demo-seed-1';
const outcome = runScriptedMatch({ seed });

for (const event of outcome.events) console.log(describe(event));

console.log('');
console.log(`seed:            ${seed}`);
console.log(`actions taken:   ${outcome.actions.length}`);
console.log(`events emitted:  ${outcome.events.length}`);
console.log(`turns played:    ${outcome.state.turn}`);
console.log(`status:          ${outcome.state.status}`);
console.log(`result:          ${JSON.stringify(outcome.state.result)}`);
if (outcome.stoppedEarly) console.log('WARNING: harness stopped before the match ended.');
console.log('');
console.log(`inert keywords (authored but not executed): ${INERT_KEYWORDS.join(', ')}`);
