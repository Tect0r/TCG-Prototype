import { z } from 'zod';

/**
 * The seat vocabulary, in a module of its own.
 *
 * It lived in `messages.ts` until M09.17, and moved for one structural reason:
 * `bot-summary.ts` describes a payload that names a seat, and `messages.ts`
 * describes the message that carries that payload. With both in one file the
 * two would have to import each other, and a circular import between two
 * modules whose top level *evaluates* Zod schemas fails at load time rather
 * than at type-check time. Splitting the shared half out is the fix that keeps
 * every schema a value built once, in order.
 *
 * Nothing about the values changed — same IDs, same bounds, same derivation —
 * so `PROTOCOL_VERSION` does not move for this file existing. `messages.ts`
 * re-exports all of it, so no caller has to know it happened.
 */

/** Up to four seats. Two is a 1v1; three or four is a free-for-all. */
export const SEAT_IDS = ['seat_1', 'seat_2', 'seat_3', 'seat_4'] as const;
export const seatIdSchema = z.enum(SEAT_IDS);
export type SeatId = z.infer<typeof seatIdSchema>;

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
export const seatCountSchema = z.number().int().min(MIN_SEATS).max(MAX_SEATS);

/**
 * How many seats at one table may hold a bot (M09.7).
 *
 * One fewer than the table can hold, because every table keeps at least one
 * human: M09 exists so a person can play against the software, and a lobby of
 * nothing but bots is a match nobody asked for. It lives beside `MAX_SEATS`
 * rather than in the server because the host's screen has to know how many bots
 * it may still offer to seat, and two copies of that number would eventually
 * disagree. It is not on a wire — no message carries a bot count — so moving it
 * would not move `PROTOCOL_VERSION`.
 */
export const MAX_BOT_SEATS = MAX_SEATS - 1;
