/** @jest-environment node */
import { DatabaseSync } from 'node:sqlite';
import { createOpSqliteRepository } from '../src/repository';
// Execute repository SQL against a real SQLite engine; native driver behavior
// is separately exercised on the Android emulator.
let mockSql;
let mockQueue = Promise.resolve();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const execute = async (sql, params = []) => {
      const statement = mockSql.prepare(sql);
      return { rows: statement.all(...params) };
    };
    return {
      execute: (sql, params) => {
        const result = mockQueue.then(() => execute(sql, params));
        mockQueue = result.then(
          () => {},
          () => {},
        );
        return result;
      },
      transaction: fn => {
        const result = mockQueue.then(async () => {
          mockSql.exec('BEGIN');
          try {
            await fn({ execute });
            mockSql.exec('COMMIT');
          } catch (error) {
            mockSql.exec('ROLLBACK');
            throw error;
          }
        });
        mockQueue = result.catch(() => {});
        return result;
      },
    };
  },
}));
jest.mock('@offline-first/todo-app', () =>
  jest.requireActual('../../../packages/todo-app/src/sync'),
);
const config = { url: 'http://localhost:3000', token: 'test-token' };
let handler;
beforeEach(() => {
  mockSql = new DatabaseSync(':memory:');
  mockQueue = Promise.resolve();
  global.fetch = jest.fn(async (url, options) => ({
    ok: true,
    json: async () => {
      const path = String(url).replace(config.url, '');
      if (path === '/info') return { epoch: 'epoch-one' };
      return handler(path, JSON.parse(String(options?.body)));
    },
  }));
});
afterEach(() => {
  mockSql.close();
  jest.restoreAllMocks();
});
test('v1 migration preserves existing todos and uploads them', async () => {
  mockSql.exec(
    "CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,completed INTEGER,created_at INTEGER,updated_at INTEGER); INSERT INTO todos VALUES('legacy','old',0,1,1); PRAGMA user_version=1;",
  );
  const repo = createOpSqliteRepository();
  await repo.initialize();
  const sent = [];
  handler = async (path, body) => {
    if (path === '/op/push') {
      sent.push(body.mutation);
      return { mutationId: body.mutation.mutationId, version: 2 };
    }
    return { cursor: 2, rows: [] };
  };
  await repo.sync(config);
  expect((await repo.list())[0].title).toBe('old');
  expect(sent[0].baseVersion).toBe(0);
  expect(mockSql.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(0);
});
test('lost response survives repository restart and retries the exact mutation', async () => {
  let repo = createOpSqliteRepository();
  await repo.initialize();
  await repo.add('first');
  let sent;
  handler = async (_path, body) => {
    sent = body.mutation;
    throw new Error('lost response');
  };
  await expect(repo.sync(config)).rejects.toThrow('로컬 변경은 보존');
  repo = createOpSqliteRepository();
  await repo.initialize();
  handler = async (path, body) => {
    if (path === '/op/push') {
      expect(body.mutation).toEqual(sent);
      return { mutationId: sent.mutationId, version: 2 };
    }
    return { cursor: 2, rows: [] };
  };
  await repo.sync(config);
  expect((await repo.list())[0].title).toBe('first');
});
test('ACK for an in-flight edit does not erase a newer local edit', async () => {
  const repo = createOpSqliteRepository();
  await repo.initialize();
  await repo.add('first');
  const todo = (await repo.list())[0];
  handler = async (path, body) => {
    if (path === '/op/push') {
      await repo.update(todo.id, { title: 'newer' });
      return { mutationId: body.mutation.mutationId, version: 2 };
    }
    return {
      cursor: 2,
      rows: [
        {
          id: todo.id,
          record: {
            id: todo.id,
            title: 'first',
            completed: false,
            created_at: 1,
            updated_at: 1,
          },
          version: 2,
          deleted: false,
        },
      ],
    };
  };
  await expect(repo.sync(config)).rejects.toThrow('보존된 기기 변경');
  expect((await repo.list())[0].title).toBe('newer');
  const row = mockSql.prepare('SELECT * FROM todos').get();
  expect(row?.dirty).toBe(1);
  expect(row?.server_version).toBe(2);
});
test('conflicts preserve local work until explicit server selection; fresh pull restores', async () => {
  const repo = createOpSqliteRepository();
  await repo.initialize();
  await repo.add('local');
  const todo = (await repo.list())[0];
  const row = {
    id: todo.id,
    record: {
      id: todo.id,
      title: 'remote',
      completed: true,
      created_at: 1,
      updated_at: 2,
    },
    version: 5,
    deleted: false,
  };
  handler = async path =>
    path === '/op/push'
      ? { conflict: true, current: row }
      : { cursor: 5, rows: [row] };
  await expect(repo.sync(config)).rejects.toThrow('충돌');
  expect((await repo.list())[0].title).toBe('local');
  await repo.sync(config, 'server');
  expect((await repo.list())[0].title).toBe('remote');
  expect((await repo.list())[0].completed).toBe(true);
});
test('data and pull cursor roll back together on an invalid remote row', async () => {
  const repo = createOpSqliteRepository();
  await repo.initialize();
  handler = async () => ({
    cursor: 5,
    rows: [{ id: null, record: null, version: 5, deleted: true }],
  });
  // SQLite TEXT PRIMARY KEY in this schema is NOT NULL.
  await expect(repo.sync(config)).rejects.toThrow();
  expect(
    mockSql.prepare("SELECT value FROM sync_meta WHERE key='cursor'").get(),
  ).toBeUndefined();
});

test('explicit local conflict resolution creates a new mutation against the chosen version', async () => {
  const repo = createOpSqliteRepository();
  await repo.initialize();
  await repo.add('local');
  const todo = (await repo.list())[0];
  let original;
  handler = async (path, body) => {
    if (path === '/op/push') {
      original = body.mutation;
      return {
        conflict: true,
        current: {
          id: todo.id,
          record: {
            id: todo.id,
            title: 'remote',
            completed: false,
            created_at: 1,
            updated_at: 2,
          },
          version: 5,
          deleted: false,
        },
      };
    }
    return { cursor: 5, rows: [] };
  };
  await expect(repo.sync(config, 'local')).rejects.toThrow('보존된 기기 변경');
  handler = async (path, body) => {
    if (path === '/op/push') {
      expect(body.mutation.mutationId).not.toBe(original.mutationId);
      expect(body.mutation.baseVersion).toBe(5);
      expect(body.mutation.record.title).toBe('local');
      return { mutationId: body.mutation.mutationId, version: 6 };
    }
    return { cursor: 6, rows: [] };
  };
  await repo.sync(config);
  expect((await repo.list())[0].title).toBe('local');
});
