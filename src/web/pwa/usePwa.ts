import { useCallback, useEffect, useRef, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** Install prompt (Chromium) / iOS instructions. Hidden when already standalone. */
export function useInstall() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(() => isStandalone());
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }, [deferred]);
  return {
    canPrompt: !standalone && !!deferred,
    showIosHint: !standalone && !deferred && isIosSafari(),
    install,
  };
}

/**
 * Service worker updates. A new SW waits (registerType: "prompt"); we only
 * activate + reload when the user agrees AND no upload is running.
 */
export function useSwUpdate(activeUploads: number) {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [pending, setPending] = useState(false);
  const updateRef = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    void import("virtual:pwa-register").then(({ registerSW }) => {
      if (cancelled) return;
      updateRef.current = registerSW({
        immediate: true,
        onNeedRefresh: () => setNeedRefresh(true),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (pending && activeUploads === 0) void updateRef.current?.(true);
  }, [pending, activeUploads]);

  return {
    needRefresh,
    waitingForUploads: pending && activeUploads > 0,
    applyUpdate: () => setPending(true),
  };
}
