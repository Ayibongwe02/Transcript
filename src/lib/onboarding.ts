const KEY = "knowledge-hub.onboarding.completed.v1";
export const ONBOARDING_COMPLETE_EVENT = "knowledge-hub:onboarding-complete";

/** True once the person has finished or explicitly skipped the welcome tour. */
export function hasCompletedOnboarding(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingComplete(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    /* ignore — worst case the tour reappears next visit */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
  }
}

/** Used by the "Restart tour" control so people can replay it on demand. */
export function resetOnboarding(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
