// Auto-lock (EXECUTION_PLAN T1.6): bound how long the derived key stays cached in session.
// Two triggers: an inactivity alarm (chrome.alarms) and OS screen-lock (chrome.idle). On either,
// we drop the cached key via vault.lock(). The encrypted vault on disk is never touched.
//
// This module is thin chrome.* glue and isn't unit-tested in node (no chrome) — the cache logic it
// drives lives in vault.ts and IS tested. Live SW-kill survival is a manual check (see T1.6 done-when).
import { vault } from './vault';

export const AUTO_LOCK_ALARM = 'bob:autolock';
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

// Config, not a secret — safe as a module global. Reset to default on each SW cold start.
let autoLockMinutes = DEFAULT_AUTO_LOCK_MINUTES;

/**
 * Register the lock triggers. MUST be called synchronously at SW top level so the listeners are
 * present on every cold start (MV3 requirement). Alarms persist across SW death, so we only (re)arm
 * the countdown if we woke up still unlocked and no alarm is pending.
 */
export async function initAutoLock(minutes: number = DEFAULT_AUTO_LOCK_MINUTES): Promise<void> {
  autoLockMinutes = minutes;

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) void vault.lock();
  });
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'locked') void vault.lock(); // OS lock screen → lock immediately
  });

  if (await vault.isUnlocked()) {
    const existing = await chrome.alarms.get(AUTO_LOCK_ALARM);
    if (!existing) touchAutoLock();
  }
}

/** (Re)start the inactivity countdown. Call on unlock and on each user interaction. */
export function touchAutoLock(): void {
  void chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: autoLockMinutes });
}

/** Cancel the countdown (e.g. once already locked). */
export function cancelAutoLock(): void {
  void chrome.alarms.clear(AUTO_LOCK_ALARM);
}
