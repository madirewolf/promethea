// Tiny pub/sub for backend events ("torrent.finished", "metadata", "search.results", ...).

type Handler = (data: any) => void;

const handlers = new Map<string, Set<Handler>>();

export function on(name: string, fn: Handler): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

export function emit(name: string, data: unknown): void {
  const set = handlers.get(name);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (e) {
      console.error(`event handler for ${name} failed`, e);
    }
  }
}
