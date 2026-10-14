import { createStore } from "zustand/vanilla";
import { SyncError, type SyncConfig, type Resolution } from "./sync";
import type { Filter, Todo, TodoRepository } from "./types";

type State = {
  syncing: boolean;
  syncMessage: string | null;
  conflict: boolean;
  sync(config: SyncConfig, resolution?: Resolution): Promise<void>;
  todos: Todo[];
  filter: Filter;
  draft: string;
  editingId: string | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  initialize(): Promise<void>;
  setDraft(value: string): void;
  setFilter(value: Filter): void;
  edit(todo: Todo): void;
  cancelEdit(): void;
  save(): Promise<void>;
  toggle(todo: Todo): Promise<void>;
  remove(id: string): Promise<void>;
};

// DB is durable storage. Zustand holds the current query result and UI state.
// Writes are serialized and the displayed result is refreshed only after commit.
export function createTodoStore(repository: TodoRepository) {
  let initialization: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  return createStore<State>((set, get) => {
    const run = (operation: () => Promise<void>) => {
      pending += 1;
      set({ busy: true, error: null });
      const next = queue.then(async () => {
        try {
          await operation();
          set({ todos: await repository.list(), error: null });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          pending -= 1;
          set({ busy: pending > 0 });
        }
      });
      queue = next;
      return next;
    };
    return {
      syncing: false,
      syncMessage: null,
      conflict: false,
      async sync(config, resolution) {
        if (get().syncing || !get().ready || !repository.sync) return;
        set({ syncing: true, syncMessage: null, conflict: false });
        try {
          await repository.sync(config, resolution);
          set({ syncMessage: "서버 저장·복원 완료" });
        } catch (error) {
          set({
            syncMessage: error instanceof Error ? error.message : String(error),
            conflict: error instanceof SyncError && error.status === 409,
          });
        } finally {
          // Join the local write queue so a slower query cannot overwrite newer UI data.
          await run(async () => {});
          set({ syncing: false });
        }
      },
      todos: [],
      filter: "all",
      draft: "",
      editingId: null,
      ready: false,
      busy: false,
      error: null,
      initialize() {
        if (!initialization) {
          initialization = run(async () => {
            await repository.initialize();
            // Read once before marking initialization successful.
            const todos = await repository.list();
            set({ todos, ready: true });
          }).then(() => {
            if (!get().ready) {
              initialization = undefined;
            }
          });
        }
        return initialization;
      },
      setDraft: (draft) => set({ draft }),
      setFilter: (filter) => set({ filter }),
      edit: (todo) =>
        set({ editingId: todo.id, draft: todo.title, error: null }),
      cancelEdit: () => set({ editingId: null, draft: "", error: null }),
      save() {
        const { draft, editingId, ready } = get();
        const title = draft.trim();
        if (!ready || !title) {
          return Promise.resolve();
        }
        if (title.length > 200) {
          set({ error: "제목은 200자 이하로 입력하세요." });
          return Promise.resolve();
        }
        return run(async () => {
          if (editingId) {
            await repository.update(editingId, { title });
          } else {
            await repository.add(title);
          }
          // Do not clear newer input entered while the write was pending.
          if (get().draft === draft && get().editingId === editingId) {
            set({ draft: "", editingId: null });
          }
        });
      },
      toggle(todo) {
        if (!get().ready) {
          return Promise.resolve();
        }
        return run(() =>
          repository.update(todo.id, { completed: !todo.completed })
        );
      },
      remove(id) {
        if (!get().ready) {
          return Promise.resolve();
        }
        return run(async () => {
          await repository.remove(id);
          if (get().editingId === id) {
            set({ editingId: null, draft: "" });
          }
        });
      },
    };
  });
}
