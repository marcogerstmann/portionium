import { CATEGORIES } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { CALIBRATION_EXAMPLES, SYSTEM_PROMPT } from './prompt.js';

describe('SYSTEM_PROMPT', () => {
  it('carries every calibration example, so the smoke test scores what was shown', () => {
    for (const example of CALIBRATION_EXAMPLES) {
      expect(SYSTEM_PROMPT).toContain(`"${example.input}"`);
      expect(SYSTEM_PROMPT).toContain(`"color": "${example.color}"`);
    }
  });

  it('calibrates all three colours', () => {
    expect(new Set(CALIBRATION_EXAMPLES.map((example) => example.color))).toEqual(
      new Set(CATEGORIES),
    );
  });
});
