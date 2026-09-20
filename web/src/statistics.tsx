import {
  CATEGORIES,
  statsDaysResponseSchema,
  statsWeeklyResponseSchema,
  statsWeightResponseSchema,
  type ColourCounts,
  type LocalDate,
  type StatsWeightResponse,
  type UserResponse,
  type WeeklySummaryWeek,
  type WeightTrendDay,
} from '@portionium/schemas';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { z } from 'zod';

import { cachedStats, localDateFor, refreshStats } from './db';
import { DOTS, UNCLASSIFIED, type DotCategory } from './dot';
import { useLocale, useT } from './i18n';
import {
  changeLabel,
  changeSentence,
  CHART,
  chartGeometry,
  CHART_DAYS,
  COLOUR_DAYS,
  COLOUR_WINDOWS,
  formatKg,
  rangeEnding,
  spokenCounts,
  SUMMARY_WEEKS,
  totalColours,
  trendCaveat,
  versusSentence,
  weekLabel,
} from './stats';

const WIDE = '(min-width: 48rem)';

function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = matchMedia(WIDE);
      query.addEventListener('change', notify);

      return () => query.removeEventListener('change', notify);
    },
    () => matchMedia(WIDE).matches,
  );
}

export function useStatistic<T extends z.ZodType>(
  name: string,
  path: string,
  schema: T,
  reloadOn?: unknown,
): z.infer<T> | undefined {
  const [value, setValue] = useState<z.infer<T> | undefined>(undefined);

  useEffect(() => {
    let live = true;

    void (async () => {
      const cached = await cachedStats(name, schema);

      if (live && cached !== undefined) {
        // The updater form: React would read a callable answer as an updater, not as a value.
        setValue(() => cached);
      }

      const fresh = await refreshStats(name, path, schema).catch(() => undefined);

      if (live && fresh !== undefined) {
        setValue(() => fresh);
      }
    })();

    return () => {
      live = false;
    };
  }, [name, path, schema, reloadOn]);

  return value;
}

export function useWeightStats(
  today: LocalDate,
  reloadOn?: unknown,
): { weight: StatsWeightResponse | undefined; days: number } {
  const days = useWide() ? CHART_DAYS.wide : CHART_DAYS.narrow;
  const query = new URLSearchParams(rangeEnding(today, days)).toString();

  return {
    weight: useStatistic('weight', `/stats/weight?${query}`, statsWeightResponseSchema, reloadOn),
    days,
  };
}

const BAR_ORDER: DotCategory[] = [...CATEGORIES, UNCLASSIFIED];

function ColourBar({ counts }: { counts: ColourCounts }) {
  const t = useT();
  const locale = useLocale();
  const total = counts.green + counts.yellow + counts.orange + counts.unclassified;

  if (total === 0) {
    return <span className="text-sm text-muted">{t('statsNothingLogged')}</span>;
  }

  return (
    <span
      className="flex min-w-24 flex-1 gap-px overflow-hidden rounded-md"
      role="img"
      aria-label={spokenCounts(counts, locale)}
    >
      {BAR_ORDER.map(
        (category) =>
          counts[category] > 0 && (
            <span
              key={category}
              className={`min-w-0 py-2.5 ${DOTS[category].fill}`}
              style={{ flexGrow: counts[category] }}
            />
          ),
      )}
    </span>
  );
}

function WeightChart({ days, line }: { days: readonly WeightTrendDay[]; line: boolean }) {
  const t = useT();
  const geometry = chartGeometry(days);

  return (
    <svg
      className="my-2 block h-auto w-full"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      role="img"
      aria-label={t('statsWeightChartLabel', {
        days: days.length,
        readings: t('statsReadings', { count: geometry.raw.length }),
      })}
    >
      {geometry.raw.map((point) => (
        <circle
          key={`${point.x},${point.y}`}
          className="fill-muted opacity-50"
          cx={point.x}
          cy={point.y}
          r={CHART.step / 4}
        />
      ))}

      {line && geometry.line !== '' && (
        <polyline
          className="fill-none stroke-brand stroke-[2.5]"
          points={geometry.line}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function WeekRow({ week }: { week: WeeklySummaryWeek }) {
  const t = useT();
  const locale = useLocale();

  return (
    <p className="row">
      <span className="w-30 shrink-0">
        {weekLabel(week, locale)}
        {week.sparse && (
          <span className="block text-sm text-muted">
            {t('statsDaysOf7', { count: week.daysLogged })}
          </span>
        )}
      </span>

      <ColourBar counts={week.counts} />

      <span className="w-22 shrink-0 text-right">{changeLabel(week.weight.changeKg, locale)}</span>
    </p>
  );
}

export function Stats({ user, active }: { user: UserResponse; active: boolean }) {
  const t = useT();
  const locale = useLocale();
  const today: LocalDate = localDateFor(new Date(), user.timezone, user.dayBoundaryHour);
  const { weight, days: chartDays } = useWeightStats(today, active);

  const colours = useStatistic(
    'days',
    `/stats/days?${new URLSearchParams(rangeEnding(today, COLOUR_DAYS)).toString()}`,
    statsDaysResponseSchema,
    active,
  );

  const weekly = useStatistic(
    'weekly',
    `/stats/weekly?weeks=${SUMMARY_WEEKS}`,
    statsWeeklyResponseSchema,
    active,
  );

  const days = weight?.days ?? [];
  const caveat = trendCaveat(days, locale);
  const latest = days.at(-1);
  const versus = weight === undefined ? undefined : versusSentence(weight.versusPrevious, locale);

  return (
    <main className="max-w-3xl">
      <header>
        <h1>{t('statsTitle')}</h1>
      </header>

      <section aria-label={t('todayWeightLabel')}>
        {weight !== undefined && caveat === undefined ? (
          <>
            <p className="mt-2 mb-1 text-4xl leading-tight font-bold">
              {latest?.trendKg === null || latest?.trendKg === undefined
                ? ''
                : formatKg(latest.trendKg, locale)}{' '}
              kg
            </p>
            <p className="text-muted">
              {changeSentence(weight.change, chartDays, locale)}
              {versus !== undefined && ` ${versus}`}
            </p>
          </>
        ) : (
          <p className="my-2 text-muted">{caveat}</p>
        )}

        <WeightChart days={days} line={caveat === undefined} />
      </section>

      <section aria-label={t('statsColoursTitle')}>
        <h2>{t('statsColoursTitle')}</h2>

        {COLOUR_WINDOWS.map((window) => (
          <p key={window} className="row">
            <span className="w-30 shrink-0">{t('statsLastDays', { window })}</span>
            <ColourBar counts={totalColours(colours?.days ?? [], window)} />
          </p>
        ))}
      </section>

      <section aria-label={t('statsWeeksTitle')}>
        <h2>{t('statsWeeksTitle')}</h2>

        {[...(weekly?.weeks ?? [])].reverse().map((week) => (
          <WeekRow key={`${week.isoYear}-${week.isoWeek}`} week={week} />
        ))}
      </section>
    </main>
  );
}
