import { WifiOff } from "lucide-react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/auth";
import { AppShell, OfflineBanner } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/misc";
import { useOnline } from "@/lib/hooks";
import { AdminPage } from "@/pages/AdminPage";
import { LoginPage, NotAuthorizedPage } from "@/pages/AuthPages";
import { DrivePage } from "@/pages/DrivePage";
import { SearchPage, SharedPage, TrashPage } from "@/pages/ListPages";
import { UploadProvider } from "@/upload/UploadProvider";

function Protected() {
  const { state, refresh } = useAuth();
  const online = useOnline();
  const loc = useLocation();
  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading FileNest" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col">
        <OfflineBanner />
        {online ? (
          <ErrorState message={state.message} onRetry={refresh} />
        ) : (
          <EmptyState icon={<WifiOff />} title="You’re offline">
            FileNest needs an internet connection to show your files.
            <div className="mt-4">
              <Button onClick={refresh}>Try again</Button>
            </div>
          </EmptyState>
        )}
      </div>
    );
  }
  if (state.status === "anon") return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  const me = state.me;
  return (
    <UploadProvider maxBytes={me.limits.maxUploadBytes}>
      <AppShell>
        <Routes>
          <Route index element={<DrivePage />} />
          <Route path="folders/:folderId" element={<DrivePage />} />
          <Route path="shared" element={<SharedPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="admin" element={me.user.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<EmptyState icon={<WifiOff />} title="Page not found" />} />
        </Routes>
      </AppShell>
    </UploadProvider>
  );
}

function LoginRoute() {
  const { state } = useAuth();
  if (state.status === "ready") return <Navigate to="/" replace />;
  return <LoginPage />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/not-authorized" element={<NotAuthorizedPage />} />
          <Route path="/*" element={<Protected />} />
        </Routes>
        <Toaster position="top-center" richColors closeButton />
      </AuthProvider>
    </BrowserRouter>
  );
}
