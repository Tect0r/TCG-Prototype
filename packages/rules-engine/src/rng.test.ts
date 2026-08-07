import { describe, expect, it } from 'vitest';
import { createRngState, nextFloat, nextInt, nextUint32, rngStateSchema, shuffle } from './rng.js';

describe('seeded generator', () => {
  it('is a pure function of its state', () => {
    const state = createRngState('seed');
    const a = nextUint32(state);
    const b = nextUint32(state);
    expect(a.value).toBe(b.value);
    expect(a.state).toEqual(b.state);
  });

  it('produces the same sequence for the same seed and diverges for another', () => {
    const take = (seed: string, count: number): number[] => {
      let state = createRngState(seed);
      const values: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const step = nextUint32(state);
        state = step.state;
        values.push(step.value);
      }
      return values;
    };

    expect(take('alpha', 20)).toEqual(take('alpha', 20));
    expect(take('alpha', 20)).not.toEqual(take('alphb', 20));
  });

  it('survives a JSON round trip without losing precision', () => {
    let state = createRngState('round-trip');
    for (let i = 0; i < 50; i += 1) state = nextUint32(state).state;

    const restored = rngStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
    expect(nextUint32(restored).value).toBe(nextUint32(state).value);
  });

  it('keeps nextInt inside its bounds', () => {
    let state = createRngState('bounds');
    for (let i = 0; i < 500; i += 1) {
      const step = nextInt(state, 7);
      state = step.state;
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(7);
    }
  });

  it('rejects a non-positive bound rather than looping', () => {
    expect(() => nextInt(createRngState('x'), 0)).toThrow();
  });

  it('keeps nextFloat in [0, 1)', () => {
    let state = createRngState('floats');
    for (let i = 0; i < 200; i += 1) {
      const step = nextFloat(state);
      state = step.state;
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(1);
    }
  });

  it('shuffles reproducibly and preserves every element', () => {
    const items = Array.from({ length: 30 }, (_, index) => index);
    const left = shuffle(createRngState('shuffle'), items);
    const right = shuffle(createRngState('shuffle'), items);

    expect(left.items).toEqual(right.items);
    expect([...left.items].sort((a, b) => a - b)).toEqual(items);
    // The input is untouched.
    expect(items[0]).toBe(0);
    expect(left.items).not.toEqual(items);
  });
});
