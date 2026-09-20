import type { Category } from '@portionium/schemas';

export type ClassificationInput = { name: string };

export type ClassificationResult =
  | {
      status: 'classified';
      name: string;
      category: Category;
      confidence: number;
      model: string;
      promptVersion: string;
    }
  | { status: 'unavailable'; reason: string };

export type FoodClassifier = (input: ClassificationInput) => Promise<ClassificationResult>;

export const unavailableClassifier: FoodClassifier = () =>
  Promise.resolve({ status: 'unavailable', reason: 'no OPENAI_API_KEY set' });
