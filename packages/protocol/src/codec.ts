import { err, ok, type Result } from '@tcg/shared';
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
): Result<T, ProtocolError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(protocolError('protocol/malformed_message', 'Message is not valid JSON.'));
  }

  const result = parse(parsed);
  if (!result.success) {
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
  return decodeWith(raw, (value) => clientMessageSchema.safeParse(value));
}

export function decodeServerMessage(raw: string): Result<ServerMessage, ProtocolError> {
  return decodeWith(raw, (value) => serverMessageSchema.safeParse(value));
}
