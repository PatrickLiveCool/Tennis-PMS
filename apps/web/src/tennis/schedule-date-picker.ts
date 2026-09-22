const DAY_MS = 86_400_000;

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date;
}

const FIRST_DATE = "0001-01-01";
const LAST_DATE = "9999-12-31";
const FIRST_TIME = utcDate(1, 0, 1).getTime();
const LAST_TIME = utcDate(9999, 11, 31).getTime();

function parseDate(value: string): Date {
  return utcDate(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
}

function formatDate(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function isScheduleDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < FIRST_DATE || value > LAST_DATE) return false;
  return formatDate(parseDate(value)) === value;
}

/** Date arithmetic uses UTC; callers validate date strings with isScheduleDate. */
export function shiftScheduleDate(value: string, days: number): string {
  const time = parseDate(value).getTime() + Math.trunc(days) * DAY_MS;
  return formatDate(new Date(Math.min(LAST_TIME, Math.max(FIRST_TIME, time))));
}

export function shiftScheduleMonth(value: string, months: number): string {
  const date = parseDate(value);
  const monthIndex = (date.getUTCFullYear() - 1) * 12 + date.getUTCMonth() + Math.trunc(months);
  if (monthIndex < 0) return FIRST_DATE;
  if (monthIndex >= 9999 * 12) return LAST_DATE;
  const year = Math.floor(monthIndex / 12) + 1;
  const month = monthIndex % 12;
  const lastDay = utcDate(year, month + 1, 0).getUTCDate();
  return formatDate(utcDate(year, month, Math.min(date.getUTCDate(), lastDay)));
}

export function scheduleWeekStart(value: string): string {
  const dayOfWeek = parseDate(value).getUTCDay();
  return shiftScheduleDate(value, -((dayOfWeek + 6) % 7));
}

/** Six full Monday-first weeks, with null only outside supported calendar years. */
export function scheduleMonthDays(value: string): Array<string | null> {
  const date = parseDate(value);
  const first = utcDate(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const startTime = first.getTime() - ((first.getUTCDay() + 6) % 7) * DAY_MS;
  return Array.from({ length: 42 }, (_, index) => {
    const time = startTime + index * DAY_MS;
    return time < FIRST_TIME || time > LAST_TIME ? null : formatDate(new Date(time));
  });
}
