import { COLOR_INFO, type CardDatabase, type CardId } from '@tcg/card-data';

interface CommanderPickerProps {
  readonly database: CardDatabase;
  readonly value: CardId | null;
  readonly onChange: (commanderId: CardId | null) => void;
}

/**
 * Exactly one Commander per deck. Changing it never edits the deck list —
 * newly illegal cards are surfaced as validation errors instead, so the player
 * decides what to cut.
 */
export function CommanderPicker({ database, value, onChange }: CommanderPickerProps) {
  const commanders = database.commanders();
  const selected = value === null ? undefined : database.get(value);

  return (
    <div className="commander-picker">
      <label htmlFor="commander-select">Commander</label>
      <select
        id="commander-select"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">— Choose a Commander —</option>
        {commanders.map((commander) => (
          <option key={commander.id} value={commander.id}>
            {commander.name} ({commander.colorIdentity.map((c) => COLOR_INFO[c].name).join('/')})
          </option>
        ))}
      </select>

      {value !== null && selected === undefined && (
        <p className="commander-picker__unresolved">
          Saved Commander <code>{value}</code> is not in the card database.
        </p>
      )}
    </div>
  );
}
