import { lazy, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError, onSessionExpired } from "./api";
import { AppShell, LoginPage, ServiceFailureState, WorkspaceProvider } from "./session";
import type { PrincipalDto } from "./types";
import { LoadingBlock } from "./uiBasic";
import { SettingsPage } from "./pages/SettingsPage";

const InventoryPage = lazy(() => import("./pages/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const MembersPage = lazy(() => import("./pages/MembersPage").then((module) => ({ default: module.MembersPage })));
const OrderDetailPage = lazy(() => import("./pages/OrderDetailPage").then((module) => ({ default: module.OrderDetailPage })));
const OrdersPage = lazy(() => import("./pages/OrdersPage").then((module) => ({ default: module.OrdersPage })));
const TodayPage = lazy(() => import("./pages/TodayPage").then((module) => ({ default: module.TodayPage })));
const TokensPage = lazy(() => import("./pages/TokensPage").then((module) => ({ default: module.TokensPage })));
const RoomCatalogPage = lazy(() => import("./pages/RoomCatalogPage").then((module) => ({ default: module.RoomCatalogPage })));

function SettingsRedirect({ section }: { section: string }) {
  const location = useLocation();
  return <Navigate to={`/settings/${section}${location.search}${location.hash}`} state={location.state} replace />;
}

const AccountsPage = lazy(() => import("./pages/AccountsPage").then((module) => ({ default: module.AccountsPage })));

export default function App() {
  const [principal, setPrincipal] = useState<PrincipalDto>();
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<unknown>();
  const [expired, setExpired] = useState(false);
  const sessionRequestId = useRef(0);
  const principalRef = useRef(principal);
  principalRef.current = principal;

  async function checkSession() {
    const requestId = ++sessionRequestId.current;
    setCheckingSession(true);
    setSessionError(undefined);
    try {
      const nextPrincipal = await api.me();
      if (requestId !== sessionRequestId.current) return;
      setPrincipal(nextPrincipal);
    } catch (error) {
      if (requestId !== sessionRequestId.current) return;
      if (error instanceof ApiError && error.status === 401) {
        setPrincipal(undefined);
      } else {
        setSessionError(error);
      }
    } finally {
      if (requestId === sessionRequestId.current) setCheckingSession(false);
    }
  }

  useEffect(() => {
    const unsubscribe = onSessionExpired(() => {
      sessionRequestId.current += 1;
      setExpired(Boolean(principalRef.current));
      setPrincipal(undefined);
      setSessionError(undefined);
      setCheckingSession(false);
    });
    void checkSession();
    return () => { sessionRequestId.current += 1; unsubscribe(); };
  }, []);

  if (checkingSession) return <main className="startup-state"><LoadingBlock label="正在检查登录状态" /></main>;
  if (sessionError) {
    return <ServiceFailureState error={sessionError} title="无法确认登录状态" onRetry={() => void checkSession()} testId="session-startup-error" />;
  }
  if (!principal) return <LoginPage expired={expired} onLogin={(next) => { setExpired(false); setPrincipal(next); }} />;

  return (
    <BrowserRouter>
      <WorkspaceProvider key={principal.subjectId} principal={principal}>
        <Routes>
          <Route element={<AppShell onLogout={() => setPrincipal(undefined)} />}>
            <Route index element={<InventoryPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/:orderId" element={<OrderDetailPage />} />
            <Route path="today" element={<TodayPage />} />
            <Route path="settings" element={<SettingsPage />}>
              <Route path="rooms" element={<RoomCatalogPage />} />
              <Route path="tokens" element={<TokensPage />} />
              <Route path="accounts" element={<AccountsPage />} />
            </Route>
            <Route path="tokens" element={<SettingsRedirect section="tokens" />} />
            <Route path="accounts" element={<SettingsRedirect section="accounts" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </WorkspaceProvider>
    </BrowserRouter>
  );
}
