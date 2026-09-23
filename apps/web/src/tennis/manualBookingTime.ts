import {
  assertDate,
  isWithinOpeningHours,
  validateMinimumMinutes,
  type OpeningWindow,
} from "../../../../packages/domain/src/tennis-pricing";
import { atVenueTime } from "./components";

const commonDurations = [15, 30, 45, 60, 90, 120, 180, 240];

export function manualBookingDurations(minimumMinutes: number | null): number[] {
  if (minimumMinutes === null) return [];
  try {
    validateMinimumMinutes(minimumMinutes);
  } catch {
    return [];
  }
  return [...new Set([...commonDurations, minimumMinutes])]
    .filter((minutes) => minutes >= minimumMinutes)
    .sort((a, b) => a - b);
}

/** Use the same local-clock and opening-window rules as the selected interval. */
export function manualBookingStartMinutes(
  date: string,
  duration: number,
  minimumMinutes: number | null,
  timezone: string,
  openingHours: readonly OpeningWindow[],
): number[] {
  if (minimumMinutes === null || duration < minimumMinutes || duration <= 0 || duration % 15)
    return [];
  try {
    assertDate(date);
    validateMinimumMinutes(minimumMinutes);
  } catch {
    return [];
  }
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const windows = openingHours.filter((window) => window.weekday === weekday);
  const result: number[] = [];
  for (let minute = 0; minute < 1440; minute += 15) {
    if (!windows.some((window) => minute >= window.startMinute && minute < window.endMinute))
      continue;
    try {
      const interval = {
        startAt: atVenueTime(date, minute, timezone),
        endAt: atVenueTime(date, minute + duration, timezone),
      };
      if (
        Date.parse(interval.endAt) - Date.parse(interval.startAt) >= minimumMinutes * 60_000 &&
        isWithinOpeningHours(interval, timezone, openingHours)
      ) result.push(minute);
    } catch {
      // A nonexistent local time (DST) or invalid opening configuration is not selectable.
    }
  }
  return result;
}
