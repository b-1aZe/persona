import { useSyncExternalStore } from "react";

const key = "persona.confirmOutwardActions";

export function confirmationEnabled(): boolean {
  try { return localStorage.getItem(key) !== "0"; }
  catch { return true; }
}

export function setConfirmationEnabled(enabled: boolean) {
  if (enabled) localStorage.removeItem(key);
  else localStorage.setItem(key, "0");
  window.dispatchEvent(new Event(key));
}

function subscribe(listener: () => void) {
  window.addEventListener(key, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(key, listener);
    window.removeEventListener("storage", listener);
  };
}

export const useApprovalConfirmation = () => useSyncExternalStore(subscribe, confirmationEnabled, () => true);
