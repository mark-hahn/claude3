// The pictures waiting on each session's next prompt, kept per tab in IndexedDB as the text drafts
// are kept in localStorage: a screenshot is far over localStorage's 5MB. Each picture is a stack
// of PNG data URIs, oldest first: the last is the picture, the rest its crops' undo history.
// A tab's whole list is one record, read once and rewritten on each change. The files waiting
// (the footer's File) are a record of their own, under "files:" and the tab.
export type Waiting = Record<string, string[][]>;

const database = new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open("claude3", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("waiting");
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

async function ask<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const request = run((await database).transaction("waiting", mode).objectStore("waiting"));
  return await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const loadWaiting = async <T = Waiting>(key: string): Promise<T> => ((await ask("readonly", (store) => store.get(key))) as T | undefined) ?? ({} as T);
export const saveWaiting = (key: string, waiting: object): Promise<IDBValidKey> => ask("readwrite", (store) => store.put(waiting, key));
