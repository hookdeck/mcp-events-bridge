import { describe, expect, it } from 'vitest';

describe('scaffold', () => {
  it('runs on Node 22 or later', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22);
  });
});
