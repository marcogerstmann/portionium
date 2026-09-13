import type { en } from './en';

/**
 * German. Typed against `typeof en` directly rather than against ../i18n's `Dictionary`, which
 * is the same type: importing it from there would make this file and ../i18n depend on each
 * other, which .dependency-cruiser.cjs refuses on sight regardless of it being type-only. A key
 * added to one and forgotten here still fails the build, and fails the parity test in
 * i18n.test.ts besides.
 */
export const de: typeof en = {
  appLoading: 'Lädt',

  loginEmail: 'E-Mail',
  loginPassword: 'Passwort',
  loginSignIn: 'Anmelden',
  loginSigningIn: 'Anmeldung läuft',
  loginNetworkError: 'Server nicht erreichbar. Bitte erneut versuchen.',

  mealTypeBreakfast: 'Frühstück',
  mealTypeLunch: 'Mittagessen',
  mealTypeDinner: 'Abendessen',
  mealTypeSnack: 'Snack',

  dayToday: 'Heute',
  dayYesterday: 'Gestern',

  categoryGreen: 'grün',
  categoryYellow: 'gelb',
  categoryOrange: 'orange',
  categoryUnclassified: 'noch nicht eingeordnet',
  dotPending: '{label}, noch nicht gesendet',

  todayNothingLogged: 'Noch nichts eingetragen.',
  todayDayImageLabel: 'Dieser Tag: {summary}.',
  todayUnknownFood: 'Unbekanntes Lebensmittel',
  todayBareEntry: 'Etwas gegessen',
  todayClassify: 'Einordnen',
  todayDeleteMeal: '{mealType} löschen',
  todayWeightLabel: 'Gewicht',
  todayTrendForming: 'Trend bildet sich',
  todayTrendKg: 'Trend {trend} kg',
  todayAddWeight: 'Hinzufügen',
  todayWeightKgLabel: 'Gewicht in kg',
  todaySave: 'Speichern',
  todayNotSentYet: 'noch nicht gesendet',
  todayRefusedWritesLabel: 'Vom Server abgelehnte Einträge',
  todayWeightEntryNoun: 'Ein Gewichtseintrag',
  todayMealNoun: 'Eine Mahlzeit',
  todayNotSaved: '{noun} vom {date} wurde nicht gespeichert. {failure}',
  todayDiscard: 'Verwerfen',
  todayDayNav: 'Tag',
  todayPreviousDay: 'Vorheriger Tag',
  todayNextDay: 'Nächster Tag',
  todayBackToToday: 'Zurück zu heute',
  todayAddMeal: 'Mahlzeit hinzufügen',
  todayMealsLabel: 'Mahlzeiten',
  todayMealDeleted: '{mealType} gelöscht.',
  todayUndo: 'Rückgängig',

  navLabel: 'Bereiche',
  navToday: 'Heute',
  navStatistics: 'Statistik',
  navSettings: 'Einstellungen',

  settingsTitle: 'Einstellungen',
  settingsSignOut: 'Abmelden',
  settingsLanguage: 'Sprache',
  settingsLanguageAuto: 'Wie im Browser',
  settingsDisplayName: 'Anzeigename',
  settingsTimezone: 'Zeitzone',
  settingsDayBoundaryHour: 'Tagesgrenze',
  settingsDayBoundaryHelp: 'Eine Mahlzeit, die um 01:00 Uhr eingetragen wird, zählt zum Vortag.',
  settingsPasswordTitle: 'Passwort ändern',
  settingsCurrentPassword: 'Aktuelles Passwort',
  settingsNewPassword: 'Neues Passwort',
  settingsPasswordWarning:
    'Das beendet jede Sitzung, auch diese hier, und meldet dich ab. API-Tokens sind davon nicht betroffen.',
  settingsChangingPassword: 'Passwort wird geändert',

  composeMealTypeGroup: 'Mahlzeitentyp',
  composeTitle: 'Mahlzeit hinzufügen',
  composeCancel: 'Abbrechen',
  composeInThisMeal: 'In dieser Mahlzeit',
  composeRemove: 'Entfernen',
  composeAddFoodLabel: 'Lebensmittel hinzufügen',
  composeCreateError:
    'Ein neues Lebensmittel braucht eine Verbindung. Alles, was schon in der Liste ist, kann jetzt eingetragen werden.',
  composeFoodsLabel: 'Lebensmittel',
  composeAdding: '{name} wird hinzugefügt',
  composeAddAsNew: '{name} als neues Lebensmittel hinzufügen',
  composeLog: '{mealType} eintragen',

  statsNothingLogged: 'Nichts eingetragen',
  statsWeightChartLabel: 'Gewicht über {days} Tage, {readings}.',
  statsReadings: { one: '{count} Messung', other: '{count} Messungen' },
  statsDaysOf7: '{count} von 7 Tagen',
  statsTitle: 'Statistik',
  statsColoursTitle: 'Farben',
  statsLastDays: 'Letzte {window} Tage',
  statsWeeksTitle: 'Wochen',

  statsSpokenGreen: '{count} grün',
  statsSpokenYellow: '{count} gelb',
  statsSpokenOrange: '{count} orange',
  statsSpokenUnclassified: '{count} noch nicht eingeordnet',
  statsNoTrend: 'Noch kein Gewicht erfasst. Ein Eintrag, und der Trend beginnt hier.',
  statsLowConfidence:
    'Noch nicht genug Messungen für einen verlässlichen Trend. Die Punkte zeigen, was auf der Waage stand.',
  statsNoTrendYet: 'noch kein Trend',
  statsNothingToReport: 'Über {days} Tage noch nichts zu berichten.',
  statsMovedDown: 'Über {days} Tage {amount} kg runter',
  statsMovedUp: 'Über {days} Tage {amount} kg hoch',
  statsMovedLevel: 'Über {days} Tage gleich geblieben, {amount} kg',
  statsRatePerWeek: '{amount} kg pro Woche',
  statsSameRate: 'Gleiches Tempo wie im Zeitraum davor.',
  statsFurtherDown: '{rate} weiter runter als im Zeitraum davor.',
  statsFurtherUp: '{rate} weiter hoch als im Zeitraum davor.',

  outboxWriteFailed: 'Der Eintrag konnte nicht gesendet werden.',
};
