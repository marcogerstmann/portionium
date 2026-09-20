import { onTestFinished, vi } from 'vitest';

export function freezeTime(instant: Date | string): Date {
  const frozen = new Date(instant);

  vi.useFakeTimers({ toFake: ['Date'], now: frozen });
  onTestFinished(() => {
    vi.useRealTimers();
  });

  return frozen;
}
