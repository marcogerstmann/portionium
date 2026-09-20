import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

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

  // readline is used for line editing only: its output goes to a sink that discards every byte and
  // the prompt is written to the real stream by hand. Overriding `_writeToOutput` instead erases
  // the prompt, and current Node writes an appended character without going through it anyway.
  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  const rl = createInterface({ input, output: discard, terminal: true });

  const ask = async (prompt: string): Promise<string> => {
    output.write(prompt);
    const answer = await rl.question('');
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
