import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readPassword } from './prompt.js';

/** Lets readline act on what was written before the next line is sent. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A fake terminal. `isTTY` is what sends `readPassword` down the interactive branch. */
function terminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  input.isTTY = true;
  input.setRawMode = () => {};

  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });

  return { input, output, written: () => written };
}

describe('readPassword', () => {
  it('takes piped input whole, without the newline the pipe added', async () => {
    const input = new PassThrough();
    const answer = readPassword({ input, output: new PassThrough() });
    input.end('a-piped-password\n');

    await expect(answer).resolves.toBe('a-piped-password');
  });

  /**
   * The regression this file exists for. readline writes the prompt and the typing through one
   * method and clears the line before each redraw, so silencing that method outright leaves a
   * blank screen and a command that looks hung. The prompt has to survive; the password must not.
   */
  it('keeps the prompt visible at a terminal and never echoes the password', async () => {
    const { input, output, written } = terminal();
    const answer = readPassword({ input, output });

    await tick();
    input.write('hunter2\n');
    await tick();
    input.write('hunter2\n');

    await expect(answer).resolves.toBe('hunter2');
    expect(written()).toContain('Password: ');
    expect(written()).toContain('Repeat: ');
    expect(written()).not.toContain('hunter2');
  });

  it('refuses two answers that do not match', async () => {
    const { input, output } = terminal();
    const answer = readPassword({ input, output });

    await tick();
    input.write('one-password\n');
    await tick();
    input.write('another-password\n');

    await expect(answer).rejects.toThrow('do not match');
  });
});
