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

/**
 * The screen that says whether any of this is working, and the second reason the app exists.
 *
 * One rule decides its whole presentation: the trend is the headline and the daily value is
 * never the largest thing on it. A daily weight is mostly water, salt and timing, and showing
 * that number first is what makes a good fortnight look like a failure, which is the frustration
 * this project exists to remove rather than to reproduce with nicer typography. So the smoothed
 * line is drawn prominently, the readings behind it are small grey dots, and the number at the
 * top is the trend.
 *
 * The corollary is the one below it: when the server says there is not enough behind the trend
 * to stand on, the line is not drawn at all. A confident curve through two readings a fortnight
 * apart is a picture that is wrong in exactly the direction this screen is supposed to correct,
 * so it says what it does not know and leaves the dots on their own, see trendCaveat.
 *
 * Everything renders from the device first and is replaced when the server answers, the same
 * contract the Today screen has and for the same reason: a screen that opens on a spinner is a
 * screen nobody checks. There is no loading state here either.
 *
 * The charting is hand written SVG rather than a library. It is one polyline, a row of circles
 * and a pure function that turns days into coordinates, see chartGeometry, which is less code
 * than configuring a chart component would be and a good deal less than shipping one.
 */

/** Where a desktop starts. Above it the chart covers a longer range, see CHART_DAYS. */
const WIDE = '(min-width: 48rem)';

/**
 * Whether there is room for the longer range.
 *
 * `useSyncExternalStore` rather than an effect and a piece of state, because a media query is
 * exactly the external store it exists for: the value is read from the platform on every render
 * rather than mirrored into React, so there is no first paint at the wrong width to correct.
 */
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

/**
 * One statistic, from the device and then from the server.
 *
 * The cached answer may have been stored for a different range than the one being asked for
 * now, a narrower window or yesterday's. It is rendered anyway, because a slightly stale chart
 * replaced a moment later is what this cache is for, and the alternative is an empty screen
 * while the request runs. A failure is swallowed: it means there is no connection, and what is
 * on screen is already the best answer available.
 *
 * Exported, because the review queue's badge is the same kind of thing: one answer from the
 * server, keyed by the question rather than by the URL, rendered from the device first so a
 * launch with no connection still shows the last count. See useUnclassifiedCount in ./review.tsx.
 */
export function useStatistic<T extends z.ZodType>(
  name: string,
  path: string,
  schema: T,
  /** Ask again whenever this changes identity. The Today screen passes its queue, see there. */
  reloadOn?: unknown,
): z.infer<T> | undefined {
  const [value, setValue] = useState<z.infer<T> | undefined>(undefined);

  useEffect(() => {
    let live = true;

    void (async () => {
      const cached = await cachedStats(name, schema);

      if (live && cached !== undefined) {
        // The updater form, because a bare value is ambiguous to a setter whose state type is
        // still generic here: React would read a callable answer as an updater rather than as
        // the answer itself.
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
    // `schema` is a module level constant at every call site, so it is stable by construction.
  }, [name, path, schema, reloadOn]);

  return value;
}

/**
 * The weight statistics, over whatever range this screen width buys.
 *
 * Exported because the Today screen needs the same answer: the last reading is what its entry
 * field offers, and the current trend is what it confirms a new one with. One request and one
 * cached row serves both, which is also why the range is decided here rather than per screen.
 * Two callers asking for different ranges would overwrite each other's cached row on every
 * navigation, see CachedStats.
 */
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

/** The four states, in the order a traffic light reads, so every bar is the same shape. */
const BAR_ORDER: DotCategory[] = [...CATEGORIES, UNCLASSIFIED];

/**
 * A colour distribution as one bar.
 *
 * Colour and nothing else, the same as the dots on the day: the letter each part used to carry
 * went with POR-63 and no visual channel replaced it, so `aria-label` is what is left for a
 * reader who cannot separate this palette's green from its orange. A part with nothing in it is
 * left out rather than drawn at zero width, and the whole bar is one image to a screen reader,
 * which gets the counts as a sentence.
 */
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

/**
 * The weight line, as a polyline over a row of circles.
 *
 * The circles are drawn first so the line sits on top of them, which is the whole of "raw
 * de-emphasised, trend prominent" in the markup rather than only in the stylesheet. The stroke
 * is non-scaling so a wider screen gets a longer chart rather than a fatter line.
 *
 * One image with a sentence, not a table of coordinates. What a screen reader needs from a
 * chart is what it says, and the headline above it already says it in numbers.
 */
function WeightChart({ days, line }: { days: readonly WeightTrendDay[]; line: boolean }) {
  const t = useT();
  const geometry = chartGeometry(days);

  return (
    <svg
      className="my-2 block h-auto w-full"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      // A drawing, and the text around it carries the numbers, so it is labelled rather than
      // described: announcing 90 coordinates is not a summary of anything.
      role="img"
      aria-label={t('statsWeightChartLabel', {
        days: days.length,
        readings: t('statsReadings', { count: geometry.raw.length }),
      })}
    >
      {/* What was on the scale. Small and grey on purpose: these are the numbers the product
          exists to stop people reading as progress, and they are here because somebody wants to
          see the dot they stood on the scale for, not because they are the answer. */}
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

/** One ISO week: how it was eaten, and what the scale did across it. */
function WeekRow({ week }: { week: WeeklySummaryWeek }) {
  const t = useT();
  const locale = useLocale();

  return (
    <p className="row">
      {/* The label the bars line up after, so the weeks read as one comparison rather than as a
          list of separate pictures. */}
      <span className="w-30 shrink-0">
        {weekLabel(week, locale)}
        {/* Its own line rather than trailing the date, which at this column width wraps into a
            ragged second one and makes every row a different height. */}
        {week.sparse && (
          <span className="block text-sm text-muted">
            {t('statsDaysOf7', { count: week.daysLogged })}
          </span>
        )}
      </span>

      <ColourBar counts={week.counts} />

      {/* Right aligned and fixed, so a column of weekly changes reads down rather than across. */}
      <span className="w-22 shrink-0 text-right">{changeLabel(week.weight.changeKg, locale)}</span>
    </p>
  );
}

export function Stats({ user, active }: { user: UserResponse; active: boolean }) {
  const t = useT();
  const locale = useLocale();
  const today: LocalDate = localDateFor(new Date(), user.timezone, user.dayBoundaryHour);
  // This screen stays mounted behind the tab bar even while another tab is showing, see App, so
  // fetching once at mount would freeze it on whatever the day looked like at sign in. `active`
  // is the tab becoming this one, and passing it as the reload trigger is what makes opening the
  // tab ask the server again rather than repeat a number from hours ago.
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
            {/* The trend, and it is the largest thing on the screen on purpose. */}
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

        {/* Newest first, where the API answers oldest first: this is a list somebody reads from
            the top, and the top is the week they are in. */}
        {[...(weekly?.weeks ?? [])].reverse().map((week) => (
          <WeekRow key={`${week.isoYear}-${week.isoWeek}`} week={week} />
        ))}
      </section>
    </main>
  );
}
