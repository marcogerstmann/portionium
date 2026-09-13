/**
 * English (US), the language every other dictionary is checked against. See ../i18n.ts for how
 * a key is resolved and i18n.test.ts for the parity check that fails CI the moment this file and
 * ./de.ts disagree about which keys exist.
 *
 * A plural entry is picked with `Intl.PluralRules`, on a `count` variable the same placeholder
 * substitution fills in afterwards, so a caller passes one count and never chooses between this
 * language's "one" and "other" by hand.
 */
export const en = {
  appLoading: 'Loading',

  loginEmail: 'Email',
  loginPassword: 'Password',
  loginSignIn: 'Sign in',
  loginSigningIn: 'Signing in',
  loginNetworkError: 'Could not reach the server. Try again.',

  mealTypeBreakfast: 'Breakfast',
  mealTypeLunch: 'Lunch',
  mealTypeDinner: 'Dinner',
  mealTypeSnack: 'Snack',

  dayToday: 'Today',
  dayYesterday: 'Yesterday',

  categoryGreen: 'green',
  categoryYellow: 'yellow',
  categoryOrange: 'orange',
  categoryUnclassified: 'not classified yet',
  dotPending: '{label}, not sent yet',

  todayNothingLogged: 'Nothing logged yet.',
  todayDayImageLabel: 'This day: {summary}.',
  todayUnknownFood: 'Unknown food',
  todayClassify: 'Classify',
  todayDeleteMeal: 'Delete this {mealType}',
  todayWeightLabel: 'Weight',
  todayTrendForming: 'Trend forming',
  todayTrendKg: 'Trend {trend} kg',
  todayAddWeight: 'Add',
  todayWeightKgLabel: 'Weight in kg',
  todaySave: 'Save',
  todayNotSentYet: 'not sent yet',
  todayRefusedWritesLabel: 'Writes the server refused',
  todayWeightEntryNoun: 'A weight entry',
  todayMealNoun: 'A meal',
  todayNotSaved: '{noun} on {date} was not saved. {failure}',
  todayDiscard: 'Discard',
  todayDayNav: 'Day',
  todayPreviousDay: 'Previous day',
  todayNextDay: 'Next day',
  todayAddMeal: 'Add a meal',
  todayMealsLabel: 'Meals',
  todayMealDeleted: '{mealType} deleted.',
  todayUndo: 'Undo',

  navLabel: 'Destinations',
  navToday: 'Today',
  navStatistics: 'Statistics',
  navSettings: 'Settings',

  settingsTitle: 'Settings',
  settingsSignOut: 'Sign out',

  composeMealTypeGroup: 'Meal type',
  composeTitle: 'Add a meal',
  composeCancel: 'Cancel',
  composeInThisMeal: 'In this meal',
  composeRemove: 'Remove',
  composeAddFoodLabel: 'Add a food',
  composeCreateError:
    'A new food needs a connection. Anything already in the list can be logged now.',
  composeFoodsLabel: 'Foods',
  composeAdding: 'Adding {name}',
  composeAddAsNew: 'Add {name} as a new food',
  composeLog: 'Log {mealType}',

  statsNothingLogged: 'Nothing logged',
  statsWeightChartLabel: 'Weight over {days} days, {readings}.',
  statsReadings: { one: '{count} reading', other: '{count} readings' },
  statsDaysOf7: '{count} of 7 days',
  statsTitle: 'Statistics',
  statsColoursTitle: 'Colours',
  statsLastDays: 'Last {window} days',
  statsWeeksTitle: 'Weeks',

  statsSpokenGreen: '{count} green',
  statsSpokenYellow: '{count} yellow',
  statsSpokenOrange: '{count} orange',
  statsSpokenUnclassified: '{count} not classified yet',
  statsNoTrend: 'No weight recorded yet. Record one and the trend starts here.',
  statsLowConfidence:
    'Not enough readings yet for a meaningful trend. The dots are what was on the scale.',
  statsNoTrendYet: 'no trend yet',
  statsNothingToReport: 'Nothing to report over {days} days yet.',
  statsMovedDown: 'Down {amount} kg over {days} days',
  statsMovedUp: 'Up {amount} kg over {days} days',
  statsMovedLevel: 'Level over {amount} kg over {days} days',
  statsRatePerWeek: '{amount} kg a week',
  statsSameRate: 'The same rate as the period before.',
  statsFurtherDown: '{rate} further down than the period before.',
  statsFurtherUp: '{rate} further up than the period before.',

  outboxWriteFailed: 'The write could not be sent.',
};
