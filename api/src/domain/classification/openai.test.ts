import { CATEGORIES } from '@portionium/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenAIClassifier, type OpenAIClassifierOptions } from './openai.js';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.js';

const OPTIONS: OpenAIClassifierOptions = {
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.test/v1',
  timeoutMs: 10_000,
  maxCallsPerDay: 100,
};

type FetchMock = ReturnType<typeof stubFetch>;

function stubFetch(...answers: readonly (Response | Error)[]) {
  const queue = [...answers];

  const mock = vi.fn((_url: string, _init: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('the classifier called the provider more often than the test allowed');
    }

    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });

  vi.stubGlobal('fetch', mock);
  return mock;
}

function completion(message: unknown): Response {
  return Response.json({ choices: [{ message }] });
}

function verdict(answer: unknown): Response {
  return completion({ content: JSON.stringify(answer) });
}

function requestBody(mock: FetchMock, call = 0): Record<string, unknown> {
  const body = mock.mock.calls[call]?.[1].body;
  return JSON.parse(typeof body === 'string' ? body : '') as Record<string, unknown>;
}

const timeout = () => Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenAIClassifier', () => {
  it('answers with the category, the model and the prompt version', async () => {
    stubFetch(verdict({ name: 'Nussschnecke', color: 'orange', confidence: 0.85 }));

    await expect(
      createOpenAIClassifier(OPTIONS)({ name: 'nussschnecke vom bäcker' }),
    ).resolves.toEqual({
      status: 'classified',
      name: 'Nussschnecke',
      category: 'orange',
      confidence: 0.85,
      model: 'gpt-4o-mini',
      promptVersion: PROMPT_VERSION,
    });
  });

  it('sends the text that was typed and nothing else', async () => {
    const mock = stubFetch(verdict({ name: 'Apfel', color: 'green', confidence: 0.9 }));

    await createOpenAIClassifier(OPTIONS)({ name: 'apfel vom markt' });

    const body = requestBody(mock);
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'response_format']);
    expect(body.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'apfel vom markt' },
    ]);
  });

  it('puts the fixed prompt first, which is what the provider discounts', async () => {
    const mock = stubFetch(verdict({ name: 'Apfel', color: 'green', confidence: 0.9 }));

    await createOpenAIClassifier(OPTIONS)({ name: 'apfel' });

    const [first] = requestBody(mock).messages as { role: string; content: string }[];
    expect(first).toEqual({ role: 'system', content: SYSTEM_PROMPT });
  });

  it('asks for a strict json schema over the three colours', async () => {
    const mock = stubFetch(verdict({ name: 'Apfel', color: 'green', confidence: 0.9 }));

    await createOpenAIClassifier(OPTIONS)({ name: 'apfel' });

    expect(requestBody(mock).response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'food_classification',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            color: { type: 'string', enum: CATEGORIES },
            confidence: { type: 'number' },
          },
          required: ['name', 'color', 'confidence'],
          additionalProperties: false,
        },
      },
    });
  });

  it('validates the answer anyway, a colour outside the union is not classified', async () => {
    const mock = stubFetch(
      verdict({ name: 'Apfel', color: 'red', confidence: 0.9 }),
      verdict({ name: 'Apfel', color: 'red', confidence: 0.9 }),
    );

    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('rejects an answer carrying fields nobody asked for', async () => {
    stubFetch(
      verdict({ name: 'Apfel', color: 'green', confidence: 0.9, reasoning: 'because' }),
      verdict({ name: 'Apfel', color: 'green', confidence: 0.9, reasoning: 'because' }),
    );

    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('retries a malformed answer once and then gives up', async () => {
    const mock = stubFetch(
      completion({ content: 'Das ist ein Apfel, also grün.' }),
      verdict({ name: 'Apfel', color: 'green', confidence: 0.9 }),
    );

    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toMatchObject({
      status: 'classified',
      category: 'green',
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('answers unavailable when the model refuses twice', async () => {
    const refusal = { content: null, refusal: 'I cannot help with that' };
    const mock = stubFetch(completion(refusal), completion(refusal));

    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'model refused to answer',
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('retries a provider failure but not a rejected request', async () => {
    const serverError = () => new Response('', { status: 503 });
    const retried = stubFetch(
      serverError(),
      verdict({ name: 'Apfel', color: 'green', confidence: 0.9 }),
    );
    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toMatchObject({
      status: 'classified',
    });
    expect(retried).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();

    const refused = stubFetch(new Response('', { status: 401 }));
    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'provider answered 401',
    });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('cancels on the timeout and does not spend a second call waiting again', async () => {
    const mock = stubFetch(timeout());

    await expect(createOpenAIClassifier(OPTIONS)({ name: 'apfel' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'timed out after 10000ms',
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[1].signal?.aborted).toBe(false);
  });

  it('stops calling once the daily cap is spent', async () => {
    const mock = stubFetch(verdict({ name: 'Apfel', color: 'green', confidence: 0.9 }));
    const classify = createOpenAIClassifier({ ...OPTIONS, maxCallsPerDay: 1 });

    await expect(classify({ name: 'apfel' })).resolves.toMatchObject({ status: 'classified' });

    const capped = await classify({ name: 'birne' });
    expect(capped.status === 'unavailable' && capped.reason).toContain(
      'daily model call cap of 1 is spent',
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('never puts what somebody ate into a reason', async () => {
    const eaten = 'currywurst mit pommes';
    const failures = [
      () => stubFetch(timeout()),
      () => stubFetch(new Response('', { status: 401 })),
      () => stubFetch(completion({ content: 'nope' }), completion({ content: 'nope' })),
    ];

    for (const failure of failures) {
      vi.unstubAllGlobals();
      failure();

      const result = await createOpenAIClassifier(OPTIONS)({ name: eaten });
      expect(result.status === 'unavailable' && result.reason).not.toContain('currywurst');
    }
  });

  it('does not call the provider for an empty input', async () => {
    const mock = stubFetch();

    await expect(createOpenAIClassifier(OPTIONS)({ name: '   ' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'nothing to classify',
    });
    expect(mock).not.toHaveBeenCalled();
  });
});
