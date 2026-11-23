import { WifiOff } from "lucide-react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/auth";
import { AppShell, OfflineBanner } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Spinner } from "@/components/states";
import { useOnline } from "@/lib/hooks";
import { AdminLayout } from "@/pages/admin/AdminLayout";
import { AdminSettingsPage } from "@/pages/admin/AdminSettingsPage";
import { AuditPage } from "@/pages/admin/AuditPage";
import { InvitationsPage } from "@/pages/admin/InvitationsPage";
import { MemberDetailPage } from "@/pages/admin/MemberDetailPage";
import { MembersPage } from "@/pages/admin/MembersPage";
import { OverviewPage } from "@/pages/admin/OverviewPage";
import { PublicLinksPage } from "@/pages/admin/PublicLinksPage";
import { StoragePage } from "@/pages/admin/StoragePage";
import { InvitePage, LoginPage, MfaPage, NotAuthorizedPage, ResetPasswordPage } from "@/pages/AuthPages";
import { MfaEnrollmentScreen } from "@/pages/MfaEnrollmentScreen";
import { ReauthProvider } from "@/components/reauth";
import { DrivePage } from "@/pages/DrivePage";
import { SearchPage, SharedPage, TrashPage } from "@/pages/ListPages";
import { SettingsPage } from "@/pages/SettingsPage";
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
  if (me.mfa?.setupRequired) return <MfaEnrollmentScreen />;
  return (
    <UploadProvider maxBytes={me.limits.maxUploadBytes}>
      <AppShell>
        <Routes>
          <Route index element={<DrivePage />} />
          <Route path="folders/:folderId" element={<DrivePage />} />
          <Route path="shared" element={<SharedPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {me.user.role === "admin" ? (
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<OverviewPage />} />
              <Route path="members" element={<MembersPage />} />
              <Route path="members/:id" element={<MemberDetailPage />} />
              <Route path="invitations" element={<InvitationsPage />} />
              <Route path="links" element={<PublicLinksPage />} />
              <Route path="settings" element={<AdminSettingsPage />} />
              <Route path="storage" element={<StoragePage />} />
              <Route path="audit" element={<AuditPage />} />
            </Route>
          ) : (
            <Route path="admin/*" element={<Navigate to="/" replace />} />
          )}
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
        <TooltipProvider delayDuration={300}>
        <ReauthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/not-authorized" element={<NotAuthorizedPage />} />
          <Route path="/mfa" element={<MfaPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
          <Route path="/*" element={<Protected />} />
        </Routes>
        <Toaster position="top-center" richColors closeButton />
        </ReauthProvider>
        </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
