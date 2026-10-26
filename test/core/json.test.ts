import { describe, expect, it } from 'vitest';
import { parseJson } from '../../src/core/json.js';

describe('parseJson: integers beyond 2^53 kept exact', () => {
  it('keeps an int64 as a string of its digits, and leaves other numbers alone', () => {
    const body = '{"ID":4323372036854775807,"neg":-9007199254740993,"safe":9007199254740991,"price":187.5,"exp":1e21,"nested":[{"id":12345678901234567890}]}';
    expect(parseJson(body)).toEqual({
      ID: '4323372036854775807',
      neg: '-9007199254740993',
      safe: 9007199254740991,
      price: 187.5,
      exp: 1e21,
      nested: [{ id: '12345678901234567890' }],
    });
    // JSON.parse rounds it.
    expect((JSON.parse(body) as { ID: number }).ID).toBe(4323372036854776000);
  });
});
