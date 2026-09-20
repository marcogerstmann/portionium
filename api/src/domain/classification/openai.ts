import { CATEGORIES, categorySchema } from '@portionium/schemas';
import { z } from 'zod';

import { createWindowCounters, retryAfterSeconds } from '../window-counter.js';
import type { ClassificationResult, FoodClassifier } from './classifier.js';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const BUDGET_KEY = 'calls';

export const RESPONSE_FORMAT = {
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
} as const;

const answerSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  color: categorySchema,
  confidence: z.number().min(0).max(1),
});

const completionSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().nullish(),
        refusal: z.string().nullish(),
      }),
    }),
  ),
});

export interface OpenAIClassifierOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxCallsPerDay: number;
}

/** `retry` is the attempt's own verdict on whether a second one could answer differently. */
interface Attempt {
  result: ClassificationResult;
  retry: boolean;
}

function unavailable(reason: string, retry: boolean): Attempt {
  return { result: { status: 'unavailable', reason }, retry };
}

/**
 * Reasons never carry the text that was classified. That is what keeps a caller's log line free of
 * what somebody ate without a redaction path per call site.
 */
export function createOpenAIClassifier(options: OpenAIClassifierOptions): FoodClassifier {
  const { apiKey, model, baseUrl, timeoutMs, maxCallsPerDay } = options;
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const counters = createWindowCounters();

  async function ask(name: string): Promise<Attempt> {
    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        // The system prompt is long, identical on every call and first in the body, which is the
        // shape OpenAI discounts through automatic prompt caching. Anything variable ahead of it
        // throws that away.
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: name },
          ],
          response_format: RESPONSE_FORMAT,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A timeout is the one failure not retried: a second attempt doubles the wall clock the hard
      // timeout exists to bound, and a provider slow once is slow twice.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return unavailable(
        timedOut ? `timed out after ${timeoutMs}ms` : 'request to the provider failed',
        !timedOut,
      );
    }

    if (!response.ok) {
      return unavailable(`provider answered ${response.status}`, response.status >= 500);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unavailable('provider answered something that is not json', true);
    }

    const completion = completionSchema.safeParse(body);
    if (!completion.success) {
      return unavailable('provider answered an unrecognised completion', true);
    }

    const message = completion.data.choices[0]?.message;
    if (message === undefined) {
      return unavailable('provider answered no choices', true);
    }

    if (typeof message.refusal === 'string' && message.refusal !== '') {
      return unavailable('model refused to answer', true);
    }

    let content: unknown;
    try {
      content = JSON.parse(message.content ?? '');
    } catch {
      return unavailable('model answered something that is not json', true);
    }

    // The strict schema is the provider's promise; this is ours.
    const answer = answerSchema.safeParse(content);
    if (!answer.success) {
      return unavailable('model answered outside the schema', true);
    }

    return {
      result: {
        status: 'classified',
        name: answer.data.name,
        category: answer.data.color,
        confidence: answer.data.confidence,
        model,
        promptVersion: PROMPT_VERSION,
      },
      retry: false,
    };
  }

  async function askWithinBudget(name: string): Promise<Attempt> {
    const window = counters.hit(BUDGET_KEY, DAY_MS);
    if (window.count > maxCallsPerDay) {
      return unavailable(
        `daily model call cap of ${maxCallsPerDay} is spent, it resets in ${retryAfterSeconds(window)} seconds`,
        false,
      );
    }

    return ask(name);
  }

  return async (input) => {
    const name = input.name.trim();
    if (name === '') {
      return { status: 'unavailable', reason: 'nothing to classify' };
    }

    const first = await askWithinBudget(name);
    if (first.result.status === 'classified' || !first.retry) {
      return first.result;
    }

    // One retry, not a loop: a second failure is a broken prompt or a broken provider, and neither
    // gets better on a third attempt.
    return (await askWithinBudget(name)).result;
  };
}
