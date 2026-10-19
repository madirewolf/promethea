// The app was called Surge before 0.1.0 shipped, and kept this window's settings under
// "surge.*" keys. Move them over before any store reads its own (main.tsx imports this first).
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("surge.")) continue;
    const renamed = "promethea." + key.slice("surge.".length);
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(renamed) === null) localStorage.setItem(renamed, value);
    localStorage.removeItem(key);
  }
} catch {
  // Storage blocked: nothing to move.
}
