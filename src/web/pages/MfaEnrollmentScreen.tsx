import { LogOut, ShieldCheck } from "lucide-react";
import { useAuth } from "@/auth";
import { Wordmark } from "@/components/Logo";
import { MfaSetup } from "@/components/MfaSetup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Shown instead of the app while policy requires 2FA and the member has not enrolled. */
export function MfaEnrollmentScreen() {
  const { refresh, logout } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center bg-muted/40 p-4">
      <div className="grid w-full max-w-lg gap-6">
        <div className="flex justify-center">
          <Wordmark />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" aria-hidden />
              <h1 className="text-xl">Set up two-factor authentication</h1>
            </CardTitle>
            <CardDescription>Your organization requires an authenticator app for your account before you can continue.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <MfaSetup onEnabled={refresh} />
            <Button variant="ghost" className="w-fit" onClick={() => void logout()}>
              <LogOut /> Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
