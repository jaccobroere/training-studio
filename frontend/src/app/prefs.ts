/** Per-device view preferences. Server state never lives here. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`sports.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`sports.${key}`, JSON.stringify(value));
  } catch {
    /* private mode: preferences just don't persist */
  }
}
