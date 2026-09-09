/**
 * Counting events per key in a fixed window, which is what both throttles in this codebase do.
 *
 * The login lockout counts failed sign in attempts per address and per IP. The rate limiter
 * counts requests per credential and per IP. They differ in what they count and what they do
 * when the number is too high, and not at all in the bookkeeping, so the bookkeeping is here.
 *
 * Fixed window rather than sliding: the window starts at the first event and does not move, so
 * a steady drip cannot hold a key at its limit forever by refreshing it. The cost is a burst at
 * a window boundary, up to twice the limit across two adjacent windows, which is the accepted
 * trade for a counter that is one integer and one timestamp per key. See
 * docs/adr/005-no-redis-no-metrics-stack.md.
 */

/** Above this many tracked keys the map is swept for expired entries on the next write. */
const SWEEP_THRESHOLD = 10_000;

export interface CounterWindow {
  /** Events counted since the window opened. */
  count: number;
  /** Epoch milliseconds at which the window closes and the count is forgotten. */
  resetAt: number;
}

export interface WindowCounters {
  /** Counts one event against the key, opening a window if none is live. */
  hit(key: string, windowMs: number): CounterWindow;
  /** The live window for a key, or undefined when there is none. Counts nothing. */
  peek(key: string): CounterWindow | undefined;
  clear(key: string): void;
}

/**
 * Each instance owns its own map, so a test gets a fresh one by calling this and the process
 * gets exactly one per throttle, created in buildApp. A second instance of either would mean
 * two half filled sets of counters and an effective limit of twice what is documented.
 *
 * ponytail: in process memory, swept on write. Counts reset when the process does, which is
 * deliberate and is the limitation the ADR records. Move to a SQLite table if a restart loop
 * ever becomes a way through the door.
 */
export function createWindowCounters(): WindowCounters {
  const windows = new Map<string, CounterWindow>();

  function live(key: string, now: number): CounterWindow | undefined {
    const window = windows.get(key);
    if (window === undefined) {
      return undefined;
    }

    if (window.resetAt <= now) {
      windows.delete(key);
      return undefined;
    }

    return window;
  }

  return {
    hit(key, windowMs) {
      const now = Date.now();

      // Only ever reached when something is spraying keys, which is the one case where the
      // bookkeeping itself needs a bound.
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [tracked, window] of windows) {
          if (window.resetAt <= now) {
            windows.delete(tracked);
          }
        }
      }

      const window = live(key, now);
      if (window === undefined) {
        const opened = { count: 1, resetAt: now + windowMs };
        windows.set(key, opened);
        return opened;
      }

      window.count += 1;
      return window;
    },

    peek(key) {
      return live(key, Date.now());
    },

    clear(key) {
      windows.delete(key);
    },
  };
}

/** Whole seconds until the window closes, rounded up so a client that waits is past it. */
export function retryAfterSeconds(window: CounterWindow): number {
  return Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
}
