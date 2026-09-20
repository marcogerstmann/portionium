import { describe, expect, it } from 'vitest';

import {
  type ClassificationResult,
  type FoodClassifier,
  unavailableClassifier,
} from './classifier.js';

describe('unavailableClassifier', () => {
  it('answers unavailable with a reason rather than throwing', async () => {
    await expect(unavailableClassifier({ name: 'Ofengemüse' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'no OPENAI_API_KEY set',
    });
  });
});

describe('ClassificationResult', () => {
  /** Reading `category` off one branch and `reason` off the other only compiles if both narrow. */
  it('puts the model fields on the classified branch alone', () => {
    const results: ClassificationResult[] = [
      {
        status: 'classified',
        name: 'Apfel',
        category: 'green',
        confidence: 0.9,
        model: 'gpt-4o-mini',
        promptVersion: 'v1',
      },
      { status: 'unavailable', reason: 'timed out' },
    ];

    expect(
      results.map((result) => (result.status === 'classified' ? result.category : result.reason)),
    ).toEqual(['green', 'timed out']);
  });

  it('is satisfied by a plain function, no class and no container', async () => {
    const stub: FoodClassifier = ({ name }) =>
      Promise.resolve({
        status: 'classified',
        name,
        category: 'yellow',
        confidence: 0.5,
        model: 'stub',
        promptVersion: 'v1',
      });

    await expect(stub({ name: 'Brot' })).resolves.toMatchObject({ name: 'Brot' });
  });
});
