import { z } from 'zod';

export const idSchema = z.uuidv7();

export type Id = z.infer<typeof idSchema>;

export const localDateSchema = z.iso.date();

export type LocalDate = z.infer<typeof localDateSchema>;

export const timezoneSchema = z.string().refine(
  (value) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown IANA timezone' },
);

export type Timezone = z.infer<typeof timezoneSchema>;

export const LOCALES = ['en-US', 'de'] as const;

export const localeSchema = z.enum(LOCALES);

export type Locale = z.infer<typeof localeSchema>;

export const dayBoundaryHourSchema = z.int().min(0).max(23);

export const DEFAULT_DAY_BOUNDARY_HOUR = 4;

export const timestampSchema = z
  .union([z.date(), z.iso.datetime()])
  .transform((value) => new Date(value));

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export type Email = z.infer<typeof emailSchema>;

/** Not a security property: it stops a megabyte of input reaching Argon2. */
export const PASSWORD_MAX_LENGTH = 256;

export const passwordSchema = z.string().min(12).max(PASSWORD_MAX_LENGTH);

export const CATEGORIES = ['green', 'yellow', 'orange'] as const;

export const categorySchema = z.enum(CATEGORIES);

export type Category = z.infer<typeof categorySchema>;

export const FOOD_KINDS = ['ingredient', 'dish', 'branded'] as const;

export const foodKindSchema = z.enum(FOOD_KINDS);

export type FoodKind = z.infer<typeof foodKindSchema>;

export const CLASSIFICATION_SOURCES = ['seed', 'ai_text', 'ai_vision', 'user'] as const;

export const classificationSourceSchema = z.enum(CLASSIFICATION_SOURCES);

export type ClassificationSource = z.infer<typeof classificationSourceSchema>;

export const USER_ROLES = ['user', 'admin'] as const;

export const userRoleSchema = z.enum(USER_ROLES);

export type UserRole = z.infer<typeof userRoleSchema>;

export const SCOPES = ['read', 'write', 'admin'] as const;

export const scopeSchema = z.enum(SCOPES);

export type Scope = z.infer<typeof scopeSchema>;

const IMPLIED_SCOPES: Record<Scope, readonly Scope[]> = {
  read: ['read'],
  write: ['read', 'write'],
  admin: ['read', 'write', 'admin'],
};

export function expandScopes(granted: readonly Scope[]): readonly Scope[] {
  return SCOPES.filter((scope) => granted.some((held) => IMPLIED_SCOPES[held].includes(scope)));
}

/** Exists to be recognised: secret scanners match on shapes like this. */
export const API_TOKEN_PREFIX = 'prt_';

export const apiTokenNameSchema = z.string().trim().min(1).max(100);

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

export const mealTypeSchema = z.enum(MEAL_TYPES);

export type MealType = z.infer<typeof mealTypeSchema>;

/** Whole grams, because a kilogram stored as a float accumulates drift across a trend. */
export const weightGramsSchema = z.int().positive();
