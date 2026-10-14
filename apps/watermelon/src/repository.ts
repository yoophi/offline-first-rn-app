import { synchronize } from '@nozbe/watermelondb/sync';
import { syncClient, assertBinding, SyncError } from '@offline-first/todo-app';
import {
  Database,
  Model,
  Q,
  appSchema,
  tableSchema,
} from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { field } from '@nozbe/watermelondb/decorators';
import type { Todo, TodoRepository } from '@offline-first/todo-app';

class TodoModel extends Model {
  static table = 'todos';
  @field('title') title!: string;
  @field('completed') completed!: boolean;
  @field('created_at') createdAt!: number;
  @field('updated_at') updatedAt!: number;
}

const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'todos',
      columns: [
        { name: 'title', type: 'string' },
        { name: 'completed', type: 'boolean' },
        { name: 'created_at', type: 'number', isIndexed: true },
        { name: 'updated_at', type: 'number' },
      ],
    }),
  ],
});

export function createWatermelonRepository(): TodoRepository {
  let database: Database | undefined;
  const getDatabase = () => {
    if (!database) {
      database = new Database({
        adapter: new SQLiteAdapter({
          schema,
          dbName: 'watermelon_todos',
          jsi: false,
        }),
        modelClasses: [TodoModel],
      });
    }
    return database;
  };
  const collection = () => getDatabase().get<TodoModel>('todos');
  let syncing = false;
  return {
    async sync(config) {
      if (syncing) throw new Error('동기화가 진행 중입니다.');
      syncing = true;
      try {
        const client = syncClient(config);
        const { epoch } = await client.request<{ epoch: string }>('/info');
        const databaseInstance = getDatabase();
        const binding = JSON.stringify([client.url, epoch]);
        assertBinding(
          await databaseInstance.localStorage.get<string>('syncBinding'),
          binding,
        );
        await databaseInstance.localStorage.set('syncBinding', binding);
        // A push race is resolved by pulling again, using Watermelon's column merge.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await synchronize({
              database: databaseInstance,
              pullChanges: ({ lastPulledAt, schemaVersion, migration }) =>
                client.request('/watermelon/pull', {
                  epoch,
                  cursor: lastPulledAt ?? 0,
                  schemaVersion,
                  migration: migration ?? null,
                }),
              pushChanges: async ({ changes, lastPulledAt }) => {
                await client.request('/watermelon/push', {
                  epoch,
                  cursor: lastPulledAt ?? 0,
                  changes,
                });
              },
            });
            break;
          } catch (error) {
            if (
              !(error instanceof SyncError) ||
              error.status !== 409 ||
              attempt === 1
            )
              throw error;
          }
        }
      } finally {
        syncing = false;
      }
    },
    async initialize() {
      await collection().query().fetchCount();
    },
    async list(): Promise<Todo[]> {
      const records = await collection()
        .query(Q.sortBy('created_at', Q.desc))
        .fetch();
      return records.map(record => ({
        id: record.id,
        title: record.title,
        completed: record.completed,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
    },
    async add(title) {
      await getDatabase().write(async () => {
        await collection().create(record => {
          record.title = title;
          record.completed = false;
          record.createdAt = Date.now();
          record.updatedAt = record.createdAt;
        });
      });
    },
    async update(id, patch) {
      await getDatabase().write(async () => {
        const record = await collection().find(id);
        await record.update(todo => {
          if (patch.title !== undefined) {
            todo.title = patch.title;
          }
          if (patch.completed !== undefined) {
            todo.completed = patch.completed;
          }
          todo.updatedAt = Date.now();
        });
      });
    },
    async remove(id) {
      await getDatabase().write(async () => {
        const record = await collection().find(id);
        // Tombstones remain until the server acknowledges deletion.
        await record.markAsDeleted();
      });
    },
  };
}
