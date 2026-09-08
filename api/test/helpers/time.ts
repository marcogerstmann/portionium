import { onTestFinished, vi } from 'vitest';

/**
 * Pins the clock for the rest of the test.
 *
 * Day boundaries, streaks and weight trends all answer differently depending on what "now" is,
 * so a test that asserts on them against the real clock is a test that fails at four in the
 * morning, or on the first of a month, or once a year in October. Freezing is the only way
 * those assertions mean anything.
 *
 * Only Date is faked. Faking timers as well would stop better-sqlite3's busy timeout and any
 * real waiting a test does from behaving, and none of the behaviour worth pinning here is
 * driven by a timer. uuidv7 reads Date.now() for its timestamp and keeps a counter within the
 * same millisecond, so ids stay unique and still sort by insertion order under a frozen clock.
 *
 * Cleanup registers itself, so there is no afterEach to forget.
 */
export function freezeTime(instant: Date | string): Date {
  const frozen = new Date(instant);

  vi.useFakeTimers({ toFake: ['Date'], now: frozen });
  onTestFinished(() => {
    vi.useRealTimers();
  });

  return frozen;
}
