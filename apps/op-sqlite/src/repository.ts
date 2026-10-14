import { open, type DB } from '@op-engineering/op-sqlite';
import {
  assertBinding,
  syncClient,
  SyncError,
  type RemoteTodo,
  type RemoteRow,
  type Todo,
  type TodoRepository,
} from '@offline-first/todo-app';

type Mutation = {
  mutationId: string;
  id: string;
  baseVersion: number;
  record: RemoteTodo | null;
};
type Ack =
  | { mutationId: string; version: number; conflict?: false }
  | { conflict: true; current: RemoteRow };
const remote = (row: Record<string, unknown>): RemoteTodo | null =>
  Number(row.deleted)
    ? null
    : {
        id: String(row.id),
        title: String(row.title),
        completed: Number(row.completed) === 1,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      };

export function createOpSqliteRepository(): TodoRepository {
  let database: DB | undefined;
  let syncing = false;
  const db = () => (database ??= open({ name: 'op_sqlite_todos.sqlite' }));
  return {
    async initialize() {
      await db().transaction(async tx => {
        const version = Number(
          (await tx.execute('PRAGMA user_version')).rows[0]?.user_version ?? 0,
        );
        if (version > 2)
          throw new Error(
            '이 앱보다 새로운 데이터베이스입니다. 앱을 업데이트하세요.',
          );
        if (version === 0) {
          await tx.execute(
            'CREATE TABLE todos (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
          );
          await tx.execute(
            'CREATE INDEX todos_created_at ON todos(created_at DESC)',
          );
        }
        if (version < 2) {
          // Existing v1 todos become pending creates; no user data is discarded.
          await tx.execute(
            'ALTER TABLE todos ADD COLUMN server_version INTEGER NOT NULL DEFAULT 0',
          );
          await tx.execute(
            'ALTER TABLE todos ADD COLUMN local_seq INTEGER NOT NULL DEFAULT 1',
          );
          await tx.execute(
            'ALTER TABLE todos ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1',
          );
          await tx.execute(
            'ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0',
          );
          await tx.execute(
            'CREATE TABLE outbox (id TEXT PRIMARY KEY, mutation_id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL, payload TEXT NOT NULL)',
          );
          await tx.execute(
            'CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
          );
          await tx.execute('PRAGMA user_version = 2');
        }
      });
    },
    async list(): Promise<Todo[]> {
      const { rows } = await db().execute(
        'SELECT * FROM todos WHERE deleted=0 ORDER BY created_at DESC, id',
      );
      return rows.map(row => ({
        id: String(row.id),
        title: String(row.title),
        completed: Number(row.completed) === 1,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
    },
    async add(title) {
      const now = Date.now();
      await db().execute(
        'INSERT INTO todos (id,title,completed,created_at,updated_at) VALUES(lower(hex(randomblob(16))),?,0,?,?)',
        [title, now, now],
      );
    },
    async update(id, patch) {
      await db().transaction(async tx => {
        if (
          !(
            await tx.execute('SELECT id FROM todos WHERE id=? AND deleted=0', [
              id,
            ])
          ).rows.length
        )
          throw new Error('할 일을 찾을 수 없습니다.');
        await tx.execute(
          'UPDATE todos SET title=COALESCE(?,title), completed=COALESCE(?,completed), updated_at=?, local_seq=local_seq+1, dirty=1 WHERE id=?',
          [
            patch.title ?? null,
            patch.completed === undefined ? null : Number(patch.completed),
            Date.now(),
            id,
          ],
        );
      });
    },
    async remove(id) {
      await db().execute(
        'UPDATE todos SET deleted=1,dirty=1,local_seq=local_seq+1,updated_at=? WHERE id=?',
        [Date.now(), id],
      );
    },
    async sync(config, resolution) {
      if (syncing) throw new Error('동기화가 진행 중입니다.');
      syncing = true;
      try {
        const client = syncClient(config);
        const { epoch } = await client.request<{ epoch: string }>('/info');
        const binding = JSON.stringify([client.url, epoch]);
        await db().transaction(async tx => {
          const saved = (
            await tx.execute("SELECT value FROM sync_meta WHERE key='binding'")
          ).rows[0]?.value;
          assertBinding(saved ? String(saved) : null, binding);
          await tx.execute(
            "INSERT OR REPLACE INTO sync_meta(key,value) VALUES('binding',?)",
            [binding],
          );
          // Freeze one mutation per entity before any network send. Later edits
          // increment local_seq and cannot alter a possibly delivered payload.
          const rows = (
            await tx.execute(
              'SELECT * FROM todos WHERE dirty=1 AND id NOT IN (SELECT id FROM outbox)',
            )
          ).rows;
          for (const row of rows) {
            const mutationId = String(
              (await tx.execute('SELECT lower(hex(randomblob(16))) AS id'))
                .rows[0].id,
            );
            const payload: Mutation = {
              mutationId,
              id: String(row.id),
              baseVersion: Number(row.server_version),
              record: remote(row),
            };
            await tx.execute(
              'INSERT INTO outbox(id,mutation_id,seq,payload) VALUES(?,?,?,?)',
              [
                payload.id,
                mutationId,
                Number(row.local_seq),
                JSON.stringify(payload),
              ],
            );
          }
        });
        const pending = (
          await db().execute('SELECT * FROM outbox ORDER BY rowid')
        ).rows;
        for (const item of pending) {
          const payload: Mutation = JSON.parse(String(item.payload));
          const result = await client.request<Ack>('/op/push', {
            epoch,
            mutation: payload,
          });
          if (result.conflict) {
            if (!resolution)
              throw new SyncError(
                '같은 할 일이 서버에서도 변경되었습니다. 충돌 처리 방법을 선택하세요.',
                409,
              );
            await db().transaction(async tx => {
              const row = (
                await tx.execute('SELECT * FROM todos WHERE id=?', [payload.id])
              ).rows[0];
              // Never discard edits made after this request began, even when
              // the user selected the server version for the frozen mutation.
              if (
                resolution === 'server' &&
                Number(row.local_seq) === Number(item.seq)
              ) {
                const r = result.current.record;
                await tx.execute(
                  'UPDATE todos SET title=?,completed=?,created_at=?,updated_at=?,deleted=?,dirty=0,server_version=? WHERE id=?',
                  [
                    r?.title ?? '',
                    Number(r?.completed ?? false),
                    r?.created_at ?? 0,
                    r?.updated_at ?? 0,
                    Number(result.current.deleted),
                    result.current.version,
                    payload.id,
                  ],
                );
              } else {
                await tx.execute(
                  'UPDATE todos SET server_version=?,dirty=1 WHERE id=?',
                  [result.current.version, payload.id],
                );
              }
              await tx.execute('DELETE FROM outbox WHERE mutation_id=?', [
                payload.mutationId,
              ]);
            });
            // A new immutable mutation will be created on the next sync.
            continue;
          }
          await db().transaction(async tx => {
            await tx.execute(
              'UPDATE todos SET server_version=?,dirty=CASE WHEN local_seq=? THEN 0 ELSE 1 END WHERE id=?',
              [result.version, Number(item.seq), payload.id],
            );
            await tx.execute('DELETE FROM outbox WHERE mutation_id=?', [
              result.mutationId,
            ]);
          });
        }
        const cursor = Number(
          (await db().execute("SELECT value FROM sync_meta WHERE key='cursor'"))
            .rows[0]?.value ?? 0,
        );
        const pulled = await client.request<{
          cursor: number;
          rows: RemoteRow[];
        }>('/op/pull', { epoch, cursor });
        await db().transaction(async tx => {
          for (const row of pulled.rows) {
            const local = (
              await tx.execute('SELECT dirty FROM todos WHERE id=?', [row.id])
            ).rows[0];
            // Dirty rows keep their original edit basis for conflict detection.
            if (local && Number(local.dirty)) continue;
            const r = row.record;
            await tx.execute(
              'INSERT INTO todos(id,title,completed,created_at,updated_at,server_version,local_seq,dirty,deleted) VALUES(?,?,?,?,?,?,0,0,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,completed=excluded.completed,created_at=excluded.created_at,updated_at=excluded.updated_at,server_version=excluded.server_version,dirty=0,deleted=excluded.deleted',
              [
                row.id,
                r?.title ?? '',
                Number(r?.completed ?? false),
                r?.created_at ?? 0,
                r?.updated_at ?? 0,
                row.version,
                Number(row.deleted),
              ],
            );
          }
          await tx.execute(
            "INSERT OR REPLACE INTO sync_meta(key,value) VALUES('cursor',?)",
            [String(pulled.cursor)],
          );
        });
        const remaining = Number(
          (await db().execute('SELECT count(*) AS n FROM todos WHERE dirty=1'))
            .rows[0].n,
        );
        if (remaining)
          throw new SyncError(
            '보존된 기기 변경이 있습니다. 다시 동기화하면 서버에 저장됩니다.',
            202,
          );
      } finally {
        syncing = false;
      }
    },
  };
}
