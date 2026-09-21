import { z } from 'zod';

import {
  entryInputSchema,
  entrySchema,
  foodClassificationSchema,
  foodSchema,
  mealFavouriteSchema,
  mealSchema,
  userSchema,
  weightEntrySchema,
  type User,
  type WeightEntry,
} from './entities.js';
import {
  apiTokenNameSchema,
  categorySchema,
  emailSchema,
  foodKindSchema,
  idSchema,
  localDateSchema,
  mealTypeSchema,
  PASSWORD_MAX_LENGTH,
  passwordSchema,
  scopeSchema,
  timestampSchema,
} from './primitives.js';

export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const createFoodRequestSchema = foodSchema
  .pick({ name: true, energyDensity: true })
  .extend({ kind: foodKindSchema.default('ingredient') })
  .strict();

export type CreateFoodRequest = z.infer<typeof createFoodRequestSchema>;

export const updateFoodRequestSchema = foodSchema
  .pick({ name: true, kind: true })
  .partial()
  .strict();

export type UpdateFoodRequest = z.infer<typeof updateFoodRequestSchema>;

export const foodListQuerySchema = paginationQuerySchema.extend({
  kind: foodKindSchema.optional(),
  unclassified: z.stringbool().optional(),
  mine: z.stringbool().optional(),
});

export type FoodListQuery = z.infer<typeof foodListQuerySchema>;

export const foodSearchQuerySchema = z.strictObject({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type FoodSearchQuery = z.infer<typeof foodSearchQuerySchema>;

export const createMealRequestSchema = z.strictObject({
  id: idSchema.optional(),
  type: mealTypeSchema,
  loggedAt: timestampSchema.optional(),
  notes: mealSchema.shape.notes,
  /** Order is meaning: the position stored on each entry is this array's index. */
  entries: z.array(entryInputSchema).optional(),
  fromMealId: idSchema.optional(),
});

export type CreateMealRequest = z.infer<typeof createMealRequestSchema>;

export const entryResponseSchema = entrySchema.omit({ mealId: true });

export type EntryResponse = z.infer<typeof entryResponseSchema>;

/**
 * `loggedAt` is re-typed rather than inherited: timestampSchema accepts a Date, and this is the
 * wire, which carries a string.
 */
export const mealResponseSchema = mealSchema.omit({ loggedAt: true }).extend({
  loggedAt: z.iso.datetime(),
  entries: z.array(entryResponseSchema),
});

export type MealResponse = z.infer<typeof mealResponseSchema>;

export const mealListQuerySchema = paginationQuerySchema.extend({
  type: mealTypeSchema.optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});

export type MealListQuery = z.infer<typeof mealListQuerySchema>;

export const updateMealRequestSchema = z.strictObject({
  type: mealTypeSchema.optional(),
  loggedAt: timestampSchema.optional(),
  notes: mealSchema.shape.notes,
  entries: z.array(entryInputSchema).optional(),
});

export type UpdateMealRequest = z.infer<typeof updateMealRequestSchema>;

export const mealCompositionEntryResponseSchema = z.object({
  foodId: idSchema.optional(),
  foodName: foodSchema.shape.name.optional(),
  quantity: entrySchema.shape.quantity,
  category: categorySchema.nullable(),
});

export type MealCompositionEntryResponse = z.infer<typeof mealCompositionEntryResponseSchema>;

export const mealSuggestionsQuerySchema = z.strictObject({
  type: mealTypeSchema,
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export type MealSuggestionsQuery = z.infer<typeof mealSuggestionsQuerySchema>;

export const mealSuggestionResponseSchema = z.object({
  mealId: idSchema,
  entries: z.array(mealCompositionEntryResponseSchema),
});

export type MealSuggestionResponse = z.infer<typeof mealSuggestionResponseSchema>;

export const createFavouriteRequestSchema = mealFavouriteSchema
  .pick({ name: true, type: true, entries: true })
  .strict();

export type CreateFavouriteRequest = z.infer<typeof createFavouriteRequestSchema>;

export const favouriteResponseSchema = mealFavouriteSchema
  .omit({ userId: true, createdAt: true, entries: true })
  .extend({ entries: z.array(mealCompositionEntryResponseSchema) });

export type FavouriteResponse = z.infer<typeof favouriteResponseSchema>;

export const favouriteListQuerySchema = paginationQuerySchema.extend({
  type: mealTypeSchema.optional(),
});

export type FavouriteListQuery = z.infer<typeof favouriteListQuerySchema>;

export const colourCountsSchema = z.object({
  green: z.int().nonnegative(),
  yellow: z.int().nonnegative(),
  orange: z.int().nonnegative(),
  unclassified: z.int().nonnegative(),
});

export type ColourCounts = z.infer<typeof colourCountsSchema>;

export const foodResponseSchema = foodSchema
  .omit({ createdAt: true })
  .extend({ category: categorySchema.nullable() });

export type FoodResponse = z.infer<typeof foodResponseSchema>;

export const foodClassificationResponseSchema = foodClassificationSchema
  .omit({ foodId: true, userId: true, createdAt: true })
  .extend({ createdAt: z.iso.datetime() });

export type FoodClassificationResponse = z.infer<typeof foodClassificationResponseSchema>;

export const createClassificationRequestSchema = foodClassificationSchema
  .pick({ category: true, reasoning: true })
  .strict();

export type CreateClassificationRequest = z.infer<typeof createClassificationRequestSchema>;

export const foodDetailResponseSchema = foodResponseSchema.extend({
  classification: foodClassificationResponseSchema.nullable(),
});

export type FoodDetailResponse = z.infer<typeof foodDetailResponseSchema>;

export const unclassifiedFoodsQuerySchema = z.strictObject({
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type UnclassifiedFoodsQuery = z.infer<typeof unclassifiedFoodsQuerySchema>;

export const unclassifiedCountQuerySchema = unclassifiedFoodsQuerySchema.pick({
  minConfidence: true,
});

export type UnclassifiedCountQuery = z.infer<typeof unclassifiedCountQuerySchema>;

export const unclassifiedFoodResponseSchema = foodResponseSchema
  .omit({ category: true })
  .extend({ suggestion: foodClassificationResponseSchema.nullable() });

export type UnclassifiedFoodResponse = z.infer<typeof unclassifiedFoodResponseSchema>;

export const unclassifiedCountResponseSchema = z.object({ count: z.int().nonnegative() });

export type UnclassifiedCountResponse = z.infer<typeof unclassifiedCountResponseSchema>;

export const classifyFoodRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(200),
});

export type ClassifyFoodRequest = z.infer<typeof classifyFoodRequestSchema>;

export const classifyFoodResponseSchema = z.object({
  name: foodSchema.shape.name,
  category: categorySchema,
  confidence: z.number().min(0).max(1),
});

export type ClassifyFoodResponse = z.infer<typeof classifyFoodResponseSchema>;

export const bulkClassifyItemSchema = z.strictObject({
  foodId: idSchema,
  category: categorySchema,
  reasoning: foodClassificationSchema.shape.reasoning,
});

export type BulkClassifyItem = z.infer<typeof bulkClassifyItemSchema>;

export const bulkClassifyRequestSchema = z.strictObject({
  items: z.array(bulkClassifyItemSchema).min(1).max(50),
});

export type BulkClassifyRequest = z.infer<typeof bulkClassifyRequestSchema>;

export const bulkClassifyResultSchema = z.object({
  foodId: idSchema,
  status: z.enum(['confirmed', 'not_found']),
  classification: foodClassificationResponseSchema.optional(),
});

export type BulkClassifyResult = z.infer<typeof bulkClassifyResultSchema>;

export const bulkClassifyResponseSchema = z.object({
  results: z.array(bulkClassifyResultSchema),
});

export type BulkClassifyResponse = z.infer<typeof bulkClassifyResponseSchema>;

/**
 * Kilograms on the wire, whole grams in the database. The boundary conversion happens here and in
 * toWeightEntryResponse.
 */
export const createWeightEntryRequestSchema = z
  .strictObject({
    weightKg: z.number().positive().max(1000),
    recordedAt: timestampSchema.optional(),
  })
  .transform(({ weightKg, ...rest }) => ({ ...rest, weightGrams: Math.round(weightKg * 1000) }));

export type CreateWeightEntryRequest = z.infer<typeof createWeightEntryRequestSchema>;

export const weightEntryResponseSchema = weightEntrySchema
  .omit({ weightGrams: true, recordedAt: true })
  .extend({ weightKg: z.number().positive(), recordedAt: z.iso.datetime() });

export type WeightEntryResponse = z.infer<typeof weightEntryResponseSchema>;

export function toWeightEntryResponse(entry: WeightEntry): WeightEntryResponse {
  const { weightGrams, recordedAt, ...rest } = entry;
  return { ...rest, weightKg: weightGrams / 1000, recordedAt: recordedAt.toISOString() };
}

export const weightListQuerySchema = paginationQuerySchema.extend({
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});

export type WeightListQuery = z.infer<typeof weightListQuerySchema>;

export const weightEntryCreateResponseSchema = weightEntryResponseSchema.extend({
  warning: z.string().nullable(),
});

export type WeightEntryCreateResponse = z.infer<typeof weightEntryCreateResponseSchema>;

/** Null is unlimited and zero is an allowance of none, so the two cannot collapse. */
export const weeklyBudgetLimitSchema = z.int().nonnegative().nullable();

export const weeklyBudgetsSchema = z.object({
  green: weeklyBudgetLimitSchema,
  yellow: weeklyBudgetLimitSchema,
  orange: weeklyBudgetLimitSchema,
});

export type WeeklyBudgets = z.infer<typeof weeklyBudgetsSchema>;

export const updateBudgetsRequestSchema = weeklyBudgetsSchema.partial().strict();

export type UpdateBudgetsRequest = z.infer<typeof updateBudgetsRequestSchema>;

export const budgetCategoryStatusSchema = z.object({
  limit: weeklyBudgetLimitSchema,
  count: z.int().nonnegative(),
  remaining: z.int().nullable(),
});

export type BudgetCategoryStatus = z.infer<typeof budgetCategoryStatusSchema>;

export const weeklyBudgetStatusSchema = z.object({
  green: budgetCategoryStatusSchema,
  yellow: budgetCategoryStatusSchema,
  orange: budgetCategoryStatusSchema,
  unclassified: z.int().nonnegative(),
});

export type WeeklyBudgetStatus = z.infer<typeof weeklyBudgetStatusSchema>;

export const statsBudgetQuerySchema = z.strictObject({ date: localDateSchema.optional() });

export type StatsBudgetQuery = z.infer<typeof statsBudgetQuerySchema>;

export const statsBudgetResponseSchema = z.object({
  isoYear: z.int(),
  isoWeek: z.int().min(1).max(53),
  startDate: localDateSchema,
  endDate: localDateSchema,
  budget: weeklyBudgetStatusSchema,
});

export type StatsBudgetResponse = z.infer<typeof statsBudgetResponseSchema>;

export const dayResponseSchema = z.object({
  date: localDateSchema,
  meals: z.array(mealResponseSchema),
  weightEntry: weightEntryResponseSchema.nullable(),
  colourCounts: colourCountsSchema,
  foods: z.array(foodResponseSchema),
  budget: weeklyBudgetStatusSchema,
});

export type DayResponse = z.infer<typeof dayResponseSchema>;

export const statsRangeQuerySchema = z
  .strictObject({ from: localDateSchema, to: localDateSchema })
  .refine((query) => query.to >= query.from, {
    message: '`to` must not be before `from`',
    path: ['to'],
  });

export type StatsRangeQuery = z.infer<typeof statsRangeQuerySchema>;

export const dayColourStatsSchema = z.object({
  date: localDateSchema,
  counts: colourCountsSchema,
  share: z.object({
    green: z.number().min(0).max(1),
    yellow: z.number().min(0).max(1),
    orange: z.number().min(0).max(1),
    unclassified: z.number().min(0).max(1),
  }),
});

export type DayColourStats = z.infer<typeof dayColourStatsSchema>;

export const statsDaysResponseSchema = z.object({ days: z.array(dayColourStatsSchema) });

export type StatsDaysResponse = z.infer<typeof statsDaysResponseSchema>;

export const weightTrendDaySchema = z.object({
  date: localDateSchema,
  trendKg: z.number().positive().nullable(),
  lowConfidence: z.boolean(),
  movingAverageKg: z.number().positive().nullable(),
  rawKg: z.number().positive().nullable(),
});

export type WeightTrendDay = z.infer<typeof weightTrendDaySchema>;

export const weightTrendChangeSchema = z.object({
  from: localDateSchema.nullable(),
  to: localDateSchema.nullable(),
  changeKg: z.number().nullable(),
  changePerWeekKg: z.number().nullable(),
});

export type WeightTrendChange = z.infer<typeof weightTrendChangeSchema>;

export const weightTrendComparisonSchema = z.object({
  differenceKg: z.number().nullable(),
  differencePerWeekKg: z.number().nullable(),
});

export type WeightTrendComparison = z.infer<typeof weightTrendComparisonSchema>;

export const statsWeightResponseSchema = z.object({
  days: z.array(weightTrendDaySchema),
  change: weightTrendChangeSchema,
  previous: weightTrendChangeSchema,
  versusPrevious: weightTrendComparisonSchema,
});

export type StatsWeightResponse = z.infer<typeof statsWeightResponseSchema>;

export const statsWeeklyQuerySchema = z.strictObject({
  weeks: z.coerce.number().int().min(1).max(52).default(8),
});

export type StatsWeeklyQuery = z.infer<typeof statsWeeklyQuerySchema>;

export const colourDifferenceSchema = z.object({
  green: z.int(),
  yellow: z.int(),
  orange: z.int(),
  unclassified: z.int(),
});

export type ColourDifference = z.infer<typeof colourDifferenceSchema>;

export const weeklyWeightSummarySchema = z.object({
  startKg: z.number().positive().nullable(),
  endKg: z.number().positive().nullable(),
  changeKg: z.number().nullable(),
  changePerWeekKg: z.number().nullable(),
});

export type WeeklyWeightSummary = z.infer<typeof weeklyWeightSummarySchema>;

export const weeklySummaryWeekSchema = z.object({
  isoYear: z.int(),
  isoWeek: z.int().min(1).max(53),
  startDate: localDateSchema,
  endDate: localDateSchema,
  counts: colourCountsSchema,
  share: z.object({
    green: z.number().min(0).max(1),
    yellow: z.number().min(0).max(1),
    orange: z.number().min(0).max(1),
    unclassified: z.number().min(0).max(1),
  }),
  daysLogged: z.int().min(0).max(7),
  sparse: z.boolean(),
  weight: weeklyWeightSummarySchema,
  versusPreviousWeek: colourDifferenceSchema,
});

export type WeeklySummaryWeek = z.infer<typeof weeklySummaryWeekSchema>;

export const statsWeeklyResponseSchema = z.object({ weeks: z.array(weeklySummaryWeekSchema) });

export type StatsWeeklyResponse = z.infer<typeof statsWeeklyResponseSchema>;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userResponseSchema = userSchema.omit({ createdAt: true });

export type UserResponse = z.infer<typeof userResponseSchema>;

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    timezone: user.timezone,
    dayBoundaryHour: user.dayBoundaryHour,
    locale: user.locale,
  };
}

export const updateProfileRequestSchema = userSchema
  .pick({ displayName: true, timezone: true, dayBoundaryHour: true, locale: true })
  .partial()
  .strict();

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const loginResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  user: userResponseSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const sessionResponseSchema = z.object({
  id: idSchema,
  createdAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const apiTokenResponseSchema = z.object({
  id: idSchema,
  name: apiTokenNameSchema,
  scopes: z.array(scopeSchema),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

export type ApiTokenResponse = z.infer<typeof apiTokenResponseSchema>;

export const createApiTokenRequestSchema = z.strictObject({
  name: apiTokenNameSchema,
  scopes: z.array(scopeSchema).min(1),
  expiresInDays: z.int().positive().max(365).optional(),
});

export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

export const createApiTokenResponseSchema = apiTokenResponseSchema.extend({
  token: z.string(),
});

export type CreateApiTokenResponse = z.infer<typeof createApiTokenResponseSchema>;
