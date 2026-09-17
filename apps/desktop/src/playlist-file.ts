import type { PlaylistData, PlaylistFileSession, PlaylistWriteRow } from "./types";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type Stamp = { revision: string; mtime: number | null };

// A session belongs to the rows read from disk. Reading the same path elsewhere
// must never grant an older view permission to overwrite a newer revision.
export function createPlaylistAccess(invoke: Invoke, noteMtime: (path: string, mtime: number | null) => void) {
  const pending = new Map<string, Promise<unknown>>();
  const sessions = new Map<string, PlaylistFileSession>();

  function ordered<T>(path: string, work: () => Promise<T>): Promise<T> {
    const result = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(work);
    pending.set(path, result);
    const cleanup = () => { if (pending.get(path) === result) pending.delete(path); };
    void result.then(cleanup, cleanup);
    return result;
  }

  function sessionFor(path: string, revision: string): PlaylistFileSession {
    let session = sessions.get(path);
    if (!session || session.revision !== revision) {
      session = { revision };
      sessions.set(path, session);
    }
    return session;
  }

  async function readNow(path: string): Promise<PlaylistData> {
    const data = await invoke<Omit<PlaylistData, "fileSession">>("read_playlist", { path });
    noteMtime(path, data.mtime);
    return { ...data, fileSession: sessionFor(path, data.revision) };
  }

  async function writeNow(path: string, name: string, rows: PlaylistWriteRow[], session?: PlaylistFileSession, overwrite = false): Promise<PlaylistFileSession> {
    const stamp = await invoke<Stamp>("write_playlist", {
      path, name, tracks: rows, expectedRevision: session?.revision ?? null, overwrite,
    });
    const saved = session ?? { revision: stamp.revision };
    saved.revision = stamp.revision;
    sessions.set(path, saved);
    noteMtime(path, stamp.mtime);
    return saved;
  }

  const snapshot = (tracks: PlaylistWriteRow[]) =>
    tracks.map((t) => ({ path: t.path, title: t.title, duration: t.duration }));

  return {
    read(path: string): Promise<PlaylistData> {
      return ordered(path, () => readNow(path));
    },
    write(path: string, name: string, tracks: PlaylistWriteRow[], session?: PlaylistFileSession, overwrite = false): Promise<PlaylistFileSession> {
      // Snapshot the edit now; only its base revision advances as earlier saves
      // in this same session complete. Failed/conflicting saves never advance it.
      const rows = snapshot(tracks);
      return ordered(path, () => writeNow(path, name, rows, session, overwrite));
    },
    append(path: string, tracks: PlaylistWriteRow[]): Promise<void> {
      const rows = snapshot(tracks);
      // Keep the entire read/modify/write ordered, otherwise two closed-file
      // appends can read the same rows and the second loses the first addition.
      return ordered(path, async () => {
        const data = await readNow(path);
        await writeNow(path, data.name, [...snapshot(data.tracks), ...rows], data.fileSession);
      });
    },
    rename(path: string, name: string): Promise<PlaylistData> {
      return ordered(path, async () => {
        const data = await readNow(path);
        await writeNow(path, name, snapshot(data.tracks), data.fileSession);
        return readNow(path);
      });
    },
  };
}
