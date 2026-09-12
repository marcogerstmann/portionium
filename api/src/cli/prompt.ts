import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/** What `readPassword` reads from and writes to. Parameterised so a test can drive both ends. */
export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/**
 * Reads a password without putting it on the screen.
 *
 * Piped input is taken whole, minus the newline the pipe added, so a script can hand one over
 * without a terminal. At a terminal, readline's echo is switched off and the answer is asked
 * for twice, because a mistyped password nobody can see is a locked out account.
 *
 * The muting is the delicate half. readline writes the prompt and the typed characters through
 * the same method, and redraws the whole line on every keystroke by clearing it first. Silencing
 * that method outright therefore erases the prompt along with the typing, and a command that
 * asks for a password without saying so is indistinguishable from one that has hung. So the
 * replacement writes the label and drops everything else: the line is cleared and redrawn as
 * `Password: ` however much has been typed into it.
 */
export async function readPassword({ input, output }: PromptStreams): Promise<string> {
  if (input.isTTY !== true) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }

  // readline is used for the line editing and nothing else: its output goes to a sink that
  // discards every byte, and the prompt is written to the real stream by hand.
  //
  // The obvious alternative, replacing readline's `_writeToOutput` so it prints nothing, is what
  // this used to do and it was wrong twice. It erased the prompt, because the same method draws
  // the prompt and redraws the line after clearing it, so the screen stayed blank and the
  // command looked hung. And it no longer hides everything anyway: current Node writes an
  // appended character straight out without going through that method, so the password reached
  // the screen regardless. A sink cannot miss a path it does not know about.
  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  const rl = createInterface({ input, output: discard, terminal: true });

  const ask = async (prompt: string): Promise<string> => {
    output.write(prompt);
    const answer = await rl.question('');
    // The newline the user typed went into the sink with everything else.
    output.write('\n');

    return answer;
  };

  try {
    const password = await ask('Password: ');
    const again = await ask('Repeat: ');

    if (password !== again) {
      throw new Error('The two passwords do not match.');
    }

    return password;
  } finally {
    rl.close();
  }
}
