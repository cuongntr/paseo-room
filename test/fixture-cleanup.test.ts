import { expect, it, vi } from 'vitest';
import { removeFixtureRootAfterConfirmedTermination } from './helpers/fixture-cleanup.js';

it('preserves private fixture evidence unless process termination was confirmed', async () => {
  const removeRoot = vi.fn<() => Promise<void>>().mockResolvedValue();
  expect(await removeFixtureRootAfterConfirmedTermination(false, removeRoot)).toBe(false);
  expect(removeRoot).not.toHaveBeenCalled();
});

it('removes the disposable root after process termination was confirmed', async () => {
  const removeRoot = vi.fn<() => Promise<void>>().mockResolvedValue();
  expect(await removeFixtureRootAfterConfirmedTermination(true, removeRoot)).toBe(true);
  expect(removeRoot).toHaveBeenCalledOnce();
});
