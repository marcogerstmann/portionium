const SWEEP_THRESHOLD = 10_000;

export interface CounterWindow {
  count: number;
  resetAt: number;
}

export interface WindowCounters {
  hit(key: string, windowMs: number): CounterWindow;
  peek(key: string): CounterWindow | undefined;
  clear(key: string): void;
}

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

export function retryAfterSeconds(window: CounterWindow): number {
  return Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
}
