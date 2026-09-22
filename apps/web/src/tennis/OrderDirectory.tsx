import { useEffect } from "react";
import type { TennisApi } from "./api";
import type { OrderListPage } from "./types";
import { useDraft, useLoad } from "./components";

export function useOrderDirectory(
  api: TennisApi,
  venueId: string,
  scope: string,
  filters: { q?: string | undefined; status?: string | undefined; date?: string | undefined },
) {
  const queryKey = JSON.stringify([venueId, filters.q ?? "", filters.status ?? "", filters.date ?? ""]);
  const [saved, setSaved] = useDraft<{ queryKey: string; cursors: (string | null)[] }>(
    `tennis:order-pagination:${scope}`,
    { queryKey, cursors: [null] },
  );
  const cursors = saved.queryKey === queryKey && saved.cursors?.length ? saved.cursors : [null];
  useEffect(() => {
    if (saved.queryKey !== queryKey) setSaved({ queryKey, cursors: [null] });
  }, [queryKey, saved.queryKey]);
  const query = new URLSearchParams({ pageSize: "25" });
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);
  if (filters.date) query.set("date", filters.date);
  const cursor = cursors.at(-1);
  if (cursor) query.set("cursor", cursor);
  const path = `/venues/${venueId}/orders?${query}`;
  const result = useLoad(() => api<OrderListPage>(path), [api, path]);
  return {
    ...result,
    page: cursors.length,
    previous: () => setSaved({ queryKey, cursors: cursors.length > 1 ? cursors.slice(0, -1) : [null] }),
    first: () => setSaved({ queryKey, cursors: [null] }),
    next: () => {
      if (result.data?.nextCursor) setSaved({ queryKey, cursors: [...cursors, result.data.nextCursor] });
    },
  };
}

export function OrderPagination({ directory }: { directory: ReturnType<typeof useOrderDirectory> }) {
  if (!directory.data && directory.page === 1) return null;
  return (
    <nav className="tennis-toolbar" aria-label="订单分页">
      <span className="text-muted">第 {directory.page} 页</span>
      {directory.page > 1 && (
        <button className="button button-secondary button-small" disabled={directory.busy} onClick={directory.first}>
          返回第一页
        </button>
      )}
      <button
        className="button button-secondary button-small"
        disabled={directory.busy || directory.page === 1}
        onClick={directory.previous}
      >
        上一页
      </button>
      <button
        className="button button-secondary button-small"
        disabled={directory.busy || !directory.data?.nextCursor}
        onClick={directory.next}
      >
        下一页
      </button>
    </nav>
  );
}
