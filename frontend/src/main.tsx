import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { legacyActivityPath } from "./activities/filter";
import { ApiError } from "./api/client";
import { DockProvider } from "./app/dock";
import { Shell } from "./app/Shell";
import { applyTheme } from "./app/theme";
import { InboxPage } from "./inbox/InboxPage";
import { LibraryPage } from "./library/LibraryPage";
import { CurrentWeekRedirect, WeekPage } from "./plan/WeekPage";
import { WeeksPage } from "./plan/WeeksPage";
import { SettingsPage } from "./settings/SettingsPage";
import { ToastProvider } from "./ui/toast";
import { installViewport } from "./ui/viewport";
import { AuthScreen, ChangePasswordScreen } from "./auth/AuthScreen";
import { SessionGate } from "./auth/session";
import { PrivacyNotice } from "./privacy/PrivacyNotice";
import { ScopeProvider } from "./chat/scope";
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-600.css";
import "@fontsource/doto/latin-700.css";
import "./ui/tokens.css";
import "./app/shell.css";
import "./plan/plan.css";
import "./plan/weeks.css";
import "./editor/editor.css";
import "./app/pages.css";
import "./auth/auth.css";
import "./chat/chat.css";
import "./health/health.css";

applyTheme();
installViewport();

// Charts (ECharts) load only when Health or Activities is opened; Week stays light.
const HealthPage = lazy(() => import("./health/HealthPage").then((m) => ({ default: m.HealthPage })));
const healthEl = <Suspense fallback={<div className="page"><div className="skel" style={{ margin: 14, height: 320 }} /></div>}><HealthPage /></Suspense>;

const ActivitiesPage = lazy(() => import("./activities/ActivitiesPage").then((m) => ({ default: m.ActivitiesPage })));
const activitiesEl = <Suspense fallback={<div className="page"><div className="skel" style={{ margin: 14, height: 320 }} /></div>}><ActivitiesPage /></Suspense>;

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // A 429 is a budget, not a transient error: retrying spends more of it.
      retry: (count, err) => !(err instanceof ApiError && err.status === 429) && count < 1,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: 0 },
  },
});

/** Old /health/<section> links. The bare /health path belongs to the server's probe, so the
 * Health page lives at /stats. */
function HealthRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={pathname.replace(/^\/health/, "/stats") + search} replace />;
}

/** Activities used to be a Health section: /stats/activities?activity=<id>&tab=… (and /health/…). */
function ActivitiesRedirect() {
  return <Navigate to={legacyActivityPath(useLocation().search)} replace />;
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/plan" replace /> },
      { path: "plan", element: <CurrentWeekRedirect /> },
      { path: "plan/week/:monday", element: <WeekPage /> },
      { path: "plan/weeks", element: <WeeksPage /> },
      { path: "activities/:id?", element: activitiesEl },
      { path: "stats/activities", element: <ActivitiesRedirect /> },
      { path: "stats/*", element: healthEl },
      { path: "health/*", element: <HealthRedirect /> },
      { path: "library/:tab?/:id?", element: <LibraryPage /> },
      { path: "inbox", element: <InboxPage /> },
      { path: "settings", element: <Navigate to="/settings/profile" replace /> },
      { path: "settings/*", element: <SettingsPage /> },
      { path: "week/*", element: <Navigate to="/plan" replace /> },
      // Settings replaced three older destinations: the Profile page plus the Sync and Account
      // tabs (decision 37).
      { path: "profile", element: <Navigate to="/settings/profile" replace /> },
      { path: "principles", element: <Navigate to="/settings/profile" replace /> },
      { path: "data/sync", element: <Navigate to="/settings/connections" replace /> },
      { path: "data/account", element: <Navigate to="/settings/account" replace /> },
      { path: "data/*", element: <Navigate to="/settings/connections" replace /> },
      { path: "*", element: <Navigate to="/plan" replace /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SessionGate
          signedOut={() => <AuthScreen />}
          mustChange={(me) => <ChangePasswordScreen username={me.username} forced />}
          privacy={() => <PrivacyNotice />}
          signedIn={
            <DockProvider>
              <ScopeProvider>
                <RouterProvider router={router} />
              </ScopeProvider>
            </DockProvider>
          }
        />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
