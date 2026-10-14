import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const todo = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  completed: z.boolean(),
  created_at: counter,
  updated_at: counter,
});
const cursorBody = z.object({ epoch: z.string(), cursor: counter });
const mutation = z
  .object({ mutationId: id, id, baseVersion: counter, record: todo.nullable() })
  .refine((v) => !v.record || v.record.id === v.id);
class Failure extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
type Row = {
  id: string;
  data: z.infer<typeof todo> | null;
  created_rev: string;
  rev: string;
  deleted: boolean;
};
const wire = (r: Row) => ({
  id: r.id,
  record: r.data,
  version: Number(r.rev),
  deleted: r.deleted,
});

export async function createServer(options: {
  databaseUrl: string;
  token: string;
}) {
  if (options.token.length < 16)
    throw new Error("SYNC_TOKEN must contain at least 16 characters");
  const pool = new Pool({ connectionString: options.databaseUrl, max: 8 });
  await pool.query(`CREATE TABLE IF NOT EXISTS sync_state (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), epoch text NOT NULL, cursor bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS todos (id text PRIMARY KEY, data jsonb, created_rev bigint NOT NULL, rev bigint NOT NULL, deleted boolean NOT NULL);
    CREATE INDEX IF NOT EXISTS todos_rev ON todos(rev);
    CREATE TABLE IF NOT EXISTS mutations (id text PRIMARY KEY, payload jsonb NOT NULL, response jsonb NOT NULL);`);
  await pool.query(
    "INSERT INTO sync_state(singleton,epoch,cursor) VALUES(true,$1,1) ON CONFLICT DO NOTHING",
    [randomUUID()]
  );
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, logger: false });
  app.addHook("onClose", async () => pool.end());
  const digest = (value: string) => createHash("sha256").update(value).digest();
  app.addHook("onRequest", async (req) => {
    if (
      !timingSafeEqual(
        digest(req.headers.authorization ?? ""),
        digest(`Bearer ${options.token}`)
      )
    )
      throw new Failure(401, "인증 토큰을 확인하세요.");
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ message: "Invalid sync payload" });
    const reportedStatus = (error as { statusCode?: number }).statusCode;
    const status =
      reportedStatus && reportedStatus >= 400 && reportedStatus < 500
        ? reportedStatus
        : 500;
    return reply.code(status).send({
      message: status === 500 ? "Server error" : (error as Error).message,
    });
  });
  // Every reader/writer takes the SAME state row lock. The cursor therefore orders
  // committed transactions, not sequence allocation or client clocks.
  async function transaction<T>(
    fn: (
      client: PoolClient,
      state: { epoch: string; cursor: number }
    ) => Promise<T>
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const state = (
        await client.query(
          "SELECT * FROM sync_state WHERE singleton=true FOR UPDATE"
        )
      ).rows[0];
      const result = await fn(client, {
        epoch: state.epoch,
        cursor: Number(state.cursor),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  function check(
    state: { epoch: string; cursor: number },
    epoch: string,
    cursor: number
  ) {
    if (epoch !== state.epoch || cursor > state.cursor)
      throw new Failure(
        412,
        "서버 이력이 변경되었습니다. 로컬 데이터를 보존하고 관리자에게 문의하세요."
      );
  }
  async function write(
    client: PoolClient,
    recordId: string,
    record: z.infer<typeof todo> | null
  ) {
    const version = Number(
      (
        await client.query(
          "UPDATE sync_state SET cursor=cursor+1 RETURNING cursor"
        )
      ).rows[0].cursor
    );
    await client.query(
      "INSERT INTO todos(id,data,created_rev,rev,deleted) VALUES($1,$2,$3,$3,$4) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, created_rev=CASE WHEN todos.deleted AND NOT EXCLUDED.deleted THEN EXCLUDED.rev ELSE todos.created_rev END, rev=EXCLUDED.rev, deleted=EXCLUDED.deleted",
      [recordId, record, version, record === null]
    );
    return version;
  }
  app.get("/info", () =>
    transaction(async (_client, state) => ({ epoch: state.epoch, protocol: 1 }))
  );
  app.post("/op/pull", async (req) => {
    const body = cursorBody.parse(req.body);
    return transaction(async (client, state) => {
      check(state, body.epoch, body.cursor);
      const rows = (
        await client.query<Row>(
          "SELECT * FROM todos WHERE rev > $1 ORDER BY rev",
          [body.cursor]
        )
      ).rows;
      return { cursor: state.cursor, rows: rows.map(wire) };
    });
  });
  app.post("/op/push", async (req) => {
    const body = z.object({ epoch: z.string(), mutation }).parse(req.body);
    return transaction(async (client, state) => {
      check(state, body.epoch, 0);
      const m = body.mutation;
      const previous = (
        await client.query("SELECT * FROM mutations WHERE id=$1", [
          m.mutationId,
        ])
      ).rows[0];
      if (previous) {
        // jsonb normalizes key order; compare semantically through PostgreSQL.
        const same = (
          await client.query(
            "SELECT payload=$2::jsonb AS same FROM mutations WHERE id=$1",
            [m.mutationId, m]
          )
        ).rows[0].same;
        if (!same)
          throw new Failure(409, "Mutation ID reused with a different payload");
        return previous.response;
      }
      const current = (
        await client.query<Row>("SELECT * FROM todos WHERE id=$1", [m.id])
      ).rows[0];
      if (Number(current?.rev ?? 0) !== m.baseVersion) {
        return {
          conflict: true,
          current: current
            ? wire(current)
            : { id: m.id, record: null, version: 0, deleted: true },
        };
      }
      const version = await write(client, m.id, m.record);
      const response = { mutationId: m.mutationId, version };
      await client.query(
        "INSERT INTO mutations(id,payload,response) VALUES($1,$2,$3)",
        [m.mutationId, m, response]
      );
      return response;
    });
  });
  app.post("/watermelon/pull", async (req) => {
    const body = cursorBody
      .extend({ schemaVersion: z.literal(1), migration: z.null().optional() })
      .parse(req.body);
    return transaction(async (client, state) => {
      check(state, body.epoch, body.cursor);
      const rows = (
        await client.query<Row>(
          "SELECT * FROM todos WHERE rev > $1 ORDER BY rev",
          [body.cursor]
        )
      ).rows;
      return {
        timestamp: state.cursor,
        changes: {
          todos: {
            created: rows
              .filter((r) => !r.deleted && Number(r.created_rev) > body.cursor)
              .map((r) => r.data),
            updated: rows
              .filter((r) => !r.deleted && Number(r.created_rev) <= body.cursor)
              .map((r) => r.data),
            deleted: rows.filter((r) => r.deleted).map((r) => r.id),
          },
        },
      };
    });
  });
  app.post("/watermelon/push", async (req) => {
    const body = cursorBody
      .extend({
        changes: z.object({
          todos: z.object({
            created: z.array(todo),
            updated: z.array(todo),
            deleted: z.array(id),
          }),
        }),
      })
      .parse(req.body);
    return transaction(async (client, state) => {
      check(state, body.epoch, body.cursor);
      const changes = body.changes.todos;
      const ids = [...changes.created, ...changes.updated]
        .map((r) => r.id)
        .concat(changes.deleted);
      if (new Set(ids).size !== ids.length)
        throw new Failure(400, "Duplicate record IDs");
      const existing = (
        await client.query<Row>(
          "SELECT * FROM todos WHERE id=ANY($1::text[])",
          [ids]
        )
      ).rows;
      if (existing.some((r) => Number(r.rev) > body.cursor))
        throw new Failure(409, "서버 변경이 있습니다. 다시 동기화하세요.");
      for (const r of [...changes.created, ...changes.updated]) {
        if (existing.some((old) => old.id === r.id && old.deleted))
          throw new Failure(409, "삭제된 항목을 다시 가져와야 합니다.");
        await write(client, r.id, r);
      }
      for (const recordId of changes.deleted) {
        if (existing.some((r) => r.id === recordId && !r.deleted))
          await write(client, recordId, null);
      }
      return { ok: true };
    });
  });
  return app;
}
