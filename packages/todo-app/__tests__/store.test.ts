import { createTodoStore } from "../src/store";
import type { Todo, TodoRepository } from "../src/types";

function fixture() {
  let rows: Todo[] = [];
  let nextId = 0;
  const repository: TodoRepository = {
    initialize: jest.fn(async () => {}),
    list: jest.fn(async () => rows.map((row) => ({ ...row }))),
    add: jest.fn(async (title) => {
      rows.push({
        id: String(++nextId),
        title,
        completed: false,
        createdAt: nextId,
        updatedAt: nextId,
      });
    }),
    update: jest.fn(async (id, patch) => {
      rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    }),
    remove: jest.fn(async (id) => {
      rows = rows.filter((row) => row.id !== id);
    }),
  };
  return { repository, store: createTodoStore(repository) };
}

test("persists CRUD and restores data into a fresh Zustand store", async () => {
  const { repository, store } = fixture();
  await store.getState().initialize();
  store.getState().setDraft("  first todo  ");
  await store.getState().save();
  const todo = store.getState().todos[0];
  expect(todo.title).toBe("first todo");
  await store.getState().toggle(todo);
  store.getState().edit(store.getState().todos[0]);
  store.getState().setDraft("edited");
  await store.getState().save();
  const restored = createTodoStore(repository);
  await restored.getState().initialize();
  expect(restored.getState().todos[0]).toMatchObject({
    title: "edited",
    completed: true,
  });
  await restored.getState().remove(todo.id);
  expect(restored.getState().todos).toEqual([]);
});

test("failed writes retain input and committed query state, then allow retry", async () => {
  const { repository, store } = fixture();
  await store.getState().initialize();
  jest.mocked(repository.add).mockRejectedValueOnce(new Error("disk full"));
  store.getState().setDraft("keep me");
  await store.getState().save();
  expect(store.getState()).toMatchObject({
    todos: [],
    draft: "keep me",
    error: "disk full",
    busy: false,
  });
  await store.getState().save();
  expect(store.getState().todos).toHaveLength(1);
  expect(store.getState().error).toBeNull();
});

test("a delayed write does not clear newer editor input", async () => {
  const { repository, store } = fixture();
  await store.getState().initialize();
  let release!: () => void;
  jest.mocked(repository.add).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  store.getState().setDraft("first");
  const saving = store.getState().save();
  await Promise.resolve();
  store.getState().setDraft("second");
  release();
  await saving;
  expect(store.getState().draft).toBe("second");
});

test("initialization can recover after native DB setup fails", async () => {
  const { repository, store } = fixture();
  jest
    .mocked(repository.initialize)
    .mockRejectedValueOnce(new Error("cannot open database"));
  await store.getState().initialize();
  expect(store.getState().ready).toBe(false);
  await store.getState().initialize();
  expect(store.getState().ready).toBe(true);
});

test("local writes remain available while a network sync is pending", async () => {
  const { repository, store } = fixture();
  let release!: () => void;
  repository.sync = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  await store.getState().initialize();
  const syncing = store
    .getState()
    .sync({ url: "http://localhost:3000", token: "token" });
  expect(store.getState().syncing).toBe(true);
  store.getState().setDraft("offline during sync");
  await store.getState().save();
  expect(store.getState().todos[0].title).toBe("offline during sync");
  release();
  await syncing;
  expect(store.getState().syncing).toBe(false);
});

test("network failure preserves local data and permits another sync", async () => {
  const { repository, store } = fixture();
  repository.sync = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(undefined);
  await store.getState().initialize();
  store.getState().setDraft("keep local");
  await store.getState().save();
  await store.getState().sync({ url: "http://localhost:3000", token: "token" });
  expect(store.getState().syncMessage).toBe("offline");
  expect(store.getState().todos).toHaveLength(1);
  await store.getState().sync({ url: "http://localhost:3000", token: "token" });
  expect(store.getState().syncMessage).toBe("서버 저장·복원 완료");
});
