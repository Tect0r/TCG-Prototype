import { err, ok, type Result } from '@tcg/shared';
import { botConfigVersionRefusal } from './bot-compatibility.js';
import {
  clientMessageSchema,
  protocolError,
  serverMessageSchema,
  type ClientMessage,
  type ProtocolError,
  type ServerMessage,
} from './messages.js';

/**
 * Encode/decode helpers used by both ends. Decoding always validates: a
 * malformed frame produces a structured error, never a thrown exception or a
 * half-applied message.
 *
 * A frame that fails validation gets one chance to be explained better than
 * "malformed" before that wording is used: `explain` is offered the parsed JSON
 * and may return a refusal that names the real cause. Since M09.18 exactly one
 * caller supplies one, and it recognises exactly one cause — a bot artifact
 * written by a newer build (`botConfigVersionRefusal`). Everything it does not
 * recognise keeps `protocol/malformed_message`, so the generic wording is still
 * the default rather than a fallback nobody reaches.
 */

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

function decodeWith<T>(
  raw: string,
  parse: (value: unknown) =>
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      },
  explain?: (value: unknown) => ProtocolError | null,
): Result<T, ProtocolError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(protocolError('protocol/malformed_message', 'Message is not valid JSON.'));
  }

  const result = parse(parsed);
  if (!result.success) {
    // Only ever consulted on a frame that has *already* failed, so nothing here
    // can refuse a message this build would otherwise have accepted.
    const explained = explain?.(parsed) ?? null;
    if (explained) return err(explained);
    return err(
      protocolError(
        'protocol/malformed_message',
        'Message failed schema validation.',
        result.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      ),
    );
  }
  return ok(result.data);
}

export function decodeClientMessage(raw: string): Result<ClientMessage, ProtocolError> {
  return decodeWith(raw, (value) => clientMessageSchema.safeParse(value), botConfigVersionRefusal);
}

export function decodeServerMessage(raw: string): Result<ServerMessage, ProtocolError> {
  return decodeWith(raw, (value) => serverMessageSchema.safeParse(value));
}
