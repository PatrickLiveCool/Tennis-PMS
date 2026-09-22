import { useState } from "react";
import { InfoHint } from "./InfoHint";
import type { TennisApi } from "./api";
import type { VenueRecord } from "./types";
import type { StaffView } from "../../../../packages/db/src/tennis/auth";
import { ErrorNotice, Modal, Panel, useLoad } from "./components";
const permissionNames: Record<string, string> = {
  read: "查看",
  book: "预订",
  manage_assets: "场地管理",
  manage_prices: "定价",
  refund: "退款",
  hold_unpaid: "保留未付款",
  manage_members: "会员管理",
};
export function StaffPanel({ api }: { api: TennisApi }) {
  const staff = useLoad(() => api<StaffView[]>("/staff"), [api]);
  const venues = useLoad(() => api<VenueRecord[]>("/venues"), [api]);
  const [edit, setEdit] = useState<StaffView | "new" | null>(null);
  return (
    <Panel
      title="员工与权限"
      action={
        <button className="button button-primary" onClick={() => setEdit("new")}>
          新增员工
        </button>
      }
    >
      <ErrorNotice error={staff.error} />
      {staff.data?.map((person) => (
        <div className="tennis-ledger-row" key={person.subjectId}>
          <div>
            <strong>{person.displayName}</strong>
            <span>
              {person.role === "ADMIN" ? "管理员" : person.role === "VIEWER" ? "只读" : "工作人员"} ·{" "}
              {person.active ? "启用" : "停用"} · {person.allVenues ? "全部场馆" : `${person.venueIds.length} 个场馆`}
            </span>
          </div>
          <button className="button button-secondary" onClick={() => setEdit(person)}>
            权限设置
          </button>
        </div>
      ))}
      {edit && (
        <StaffEditor
          api={api}
          source={edit}
          venues={venues.data ?? []}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void staff.refresh();
          }}
        />
      )}
    </Panel>
  );
}
function StaffEditor({
  api,
  source,
  venues,
  onClose,
  onSaved,
}: {
  api: TennisApi;
  source: StaffView | "new";
  venues: VenueRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = source === "new" ? null : source;
  const [draft, setDraft] = useState({
    username: "",
    displayName: "",
    password: "",
    role: current?.role ?? "STAFF",
    permissions: (current?.permissions ?? ["read", "book"]) as string[],
    allVenues: current?.allVenues ?? false,
    venueIds: current?.venueIds ?? [],
    active: current?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save() {
    setBusy(true);
    try {
      const { username, displayName, password, permissions, ...rest } = draft;
      const grant = {
        ...rest,
        permissions: rest.role === "VIEWER" ? ["read"] : [...new Set(["read", ...permissions])],
      };
      await api(
        current ? `/staff/${current.subjectId}` : "/staff",
        current ? "PATCH" : "POST",
        current ? grant : { ...grant, username, displayName, password },
      );
      onSaved();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={current ? `${current.displayName} · 权限` : "新增员工"} onClose={onClose} closeDisabled={busy}>
      <form
        className="tennis-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNotice error={error} />
        {!current && (
          <>
            <label>
              登录账号
              <input
                autoComplete="off"
                placeholder="如 frontdesk01"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9._@+\-]{2,99}"
              />
            </label>
            <label>
              姓名
              <input
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                required
              />
            </label>
            <label>
              初始密码
              <input
                type="password"
                autoComplete="new-password"
                placeholder="至少 12 位"
                minLength={12}
                maxLength={256}
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                required
              />
            </label>
          </>
        )}
        <label>
          角色
          <select
            value={draft.role}
            onChange={(e) =>
              setDraft({
                ...draft,
                role: e.target.value as "ADMIN" | "STAFF" | "VIEWER",
                permissions: e.target.value === "VIEWER" ? ["read"] : [...new Set(["read", ...draft.permissions])],
              })
            }
          >
            <option value="STAFF">工作人员</option>
            <option value="VIEWER">只读查看</option>
            <option value="ADMIN">管理员</option>
          </select>
        </label>
        {draft.role === "STAFF" && (
          <fieldset>
            <legend>业务权限</legend>
            <div className="tennis-check-group">
              {Object.entries(permissionNames).map(([key, name]) => (
                <label key={key} className="tennis-check">
                  <input
                    type="checkbox"
                    checked={key === "read" || draft.permissions.includes(key)}
                    disabled={key === "read"}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        permissions: e.target.checked
                          ? [...draft.permissions, key]
                          : draft.permissions.filter((p) => p !== key),
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="tennis-check">
          <input
            type="checkbox"
            checked={draft.allVenues}
            onChange={(e) => setDraft({ ...draft, allVenues: e.target.checked })}
          />
          全部场馆
        </label>
        {!draft.allVenues && (
          <div className="tennis-check-group">
            {venues.map((v) => (
              <label className="tennis-check" key={v.id}>
                <input
                  type="checkbox"
                  checked={draft.venueIds.includes(v.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      venueIds: e.target.checked
                        ? [...draft.venueIds, v.id]
                        : draft.venueIds.filter((id) => id !== v.id),
                    })
                  }
                />
                {v.name}
              </label>
            ))}
          </div>
        )}
        <label className="tennis-check">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />
          账号启用
        </label>
        {draft.role === "ADMIN" && <p className="tennis-note">管理员可以管理全部业务，包括员工权限、收款和退款。</p>}
        {draft.role === "VIEWER" && <p className="tennis-muted">只读账号只能查看，不能办理预订、收款或退款。</p>}
        {!draft.active && <p className="tennis-note">停用后，该员工将无法进入当前商家的工作台。</p>}
        <div className="tennis-actions">
          <button className="button button-primary" disabled={busy}>
            保存员工权限
          </button>
          <InfoHint label="权限生效说明">保存后，请员工刷新页面以使用最新权限。</InfoHint>
        </div>
      </form>
    </Modal>
  );
}
