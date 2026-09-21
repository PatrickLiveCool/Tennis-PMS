import { useCallback, useEffect, useRef, useState } from "react";
import { TennisApiError, type TennisApi } from "./api";
import type { Schedule } from "./types";

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Keep same-workspace facts on screen while revalidating; never reuse another identity's cache. */
export function useScheduleRange(
  api: TennisApi,
  venueId: string,
  dates: string[],
) {
  const key = [...new Set(dates)].sort().join(",");
  const [state, setState] = useState<{
    api: TennisApi;
    venueId: string;
    days: Record<string, Schedule>;
    updatedAt: number;
    error?: unknown;
  }>();
  const [busy, setBusy] = useState(true);
  const serial = useRef(0);
  const running = useRef<
    | { api: TennisApi; venueId: string; key: string; promise: Promise<void> }
    | undefined
  >(undefined);
  const refresh = useCallback(
    (force = false) => {
      const previous = running.current;
      if (
        !force &&
        previous?.api === api &&
        previous.venueId === venueId &&
        previous.key === key
      )
        return previous.promise;
      const id = ++serial.current;
      setBusy(true);
      const promise = (async () => {
        try {
          const result = await Promise.all(
            key
              .split(",")
              .filter(Boolean)
              .map(
                async (date) =>
                  [
                    date,
                    await api<Schedule>(
                      `/venues/${venueId}/schedule?date=${date}`,
                    ),
                  ] as const,
              ),
          );
          if (id !== serial.current) return;
          setState((old) => {
            const prior =
              old?.api === api && old.venueId === venueId ? old.days : {};
            const days: Record<string, Schedule> = {};
            for (const [date, schedule] of result)
              days[date] =
                JSON.stringify(prior[date]) === JSON.stringify(schedule)
                  ? prior[date]!
                  : schedule;
            return { api, venueId, days, updatedAt: Date.now() };
          });
        } catch (error) {
          if (id !== serial.current) return;
          setState((old) => ({
            api,
            venueId,
            days:
              error instanceof TennisApiError &&
              [401, 403].includes(error.status)
                ? {}
                : old?.api === api && old.venueId === venueId
                  ? old.days
                  : {},
            updatedAt:
              old?.api === api && old.venueId === venueId ? old.updatedAt : 0,
            error,
          }));
        } finally {
          if (id === serial.current) {
            running.current = undefined;
            setBusy(false);
          }
        }
      })();
      running.current = { api, venueId, key, promise };
      return promise;
    },
    [api, venueId, key],
  );
  useEffect(() => {
    void refresh();
    return () => {
      serial.current++;
      running.current = undefined;
    };
  }, [refresh]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);
  const current =
    state?.api === api && state.venueId === venueId ? state : undefined;
  return {
    days: current?.days ?? {},
    error: current?.error,
    updatedAt: current?.updatedAt ?? 0,
    busy,
    refresh,
  };
}
