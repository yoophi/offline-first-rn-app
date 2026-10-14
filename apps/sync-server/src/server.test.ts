import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createServer } from "./server.js";

const token = "integration-test-token-only";
const baseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://todo:todo-local-only@127.0.0.1:54329/todo";
const admin = new Pool({ connectionString: baseUrl });
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(baseUrl);
url.searchParams.set("options", `-c search_path=${schema}`);
let app: Awaited<ReturnType<typeof createServer>>;
let epoch: string;
const record = (id: string, title = id) => ({
  id,
  title,
  completed: false,
  created_at: 1,
  updated_at: 1,
});
async function call(path: string, body?: unknown, auth = token) {
  const result = await app.inject({
    method: body === undefined ? "GET" : "POST",
    url: path,
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: result.statusCode, body: result.json() };
}
const pull = () => call("/op/pull", { epoch, cursor: 0 });
const push = (
  id: string,
  baseVersion: number,
  data: ReturnType<typeof record> | null,
  mutationId = randomUUID()
) =>
  call("/op/push", {
    epoch,
    mutation: { mutationId, id, baseVersion, record: data },
  });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  app = await createServer({ databaseUrl: url.toString(), token });
  epoch = (await call("/info")).body.epoch;
});
after(async () => {
  await app?.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("authentication, strict payload validation, epoch and future cursor protection", async () => {
  assert.equal((await call("/info", undefined, "wrong")).status, 401);
  assert.equal((await push("invalid", 0, record("invalid", ""))).status, 400);
  assert.equal(
    (await call("/op/pull", { epoch: "old", cursor: 0 })).status,
    412
  );
  assert.equal((await call("/op/pull", { epoch, cursor: 999999 })).status, 412);
  assert.equal(
    (await call("/watermelon/pull", { epoch, cursor: 0, schemaVersion: 2 }))
      .status,
    400
  );
});
test("Watermelon push is visible to OP; OP edits restore through Watermelon pull", async () => {
  const cursor = (await pull()).body.cursor;
  assert.equal(
    (
      await call("/watermelon/push", {
        epoch,
        cursor,
        changes: {
          todos: { created: [record("cross-app")], updated: [], deleted: [] },
        },
      })
    ).status,
    200
  );
  const row = (await pull()).body.rows.find(
    (r: { id: string }) => r.id === "cross-app"
  );
  assert.equal(row.record.title, "cross-app");
  const ack = await push(
    "cross-app",
    row.version,
    record("cross-app", "edited in OP")
  );
  assert.equal(ack.status, 200);
  const restored = await call("/watermelon/pull", {
    epoch,
    cursor: 0,
    schemaVersion: 1,
  });
  assert.equal(
    restored.body.changes.todos.created.find(
      (r: { id: string }) => r.id === "cross-app"
    ).title,
    "edited in OP"
  );
});
test("lost ACK replay is idempotent and altered mutation payload is rejected", async () => {
  const mutationId = randomUUID();
  const first = await push("replay", 0, record("replay"), mutationId);
  const replay = await push("replay", 0, record("replay"), mutationId);
  assert.deepEqual(first, replay);
  assert.equal(
    (await push("replay", 0, record("replay", "changed"), mutationId)).status,
    409
  );
});
test("concurrent edits have one winner and return the current row to the loser", async () => {
  const created = await push("race", 0, record("race"));
  const [a, b] = await Promise.all([
    push("race", created.body.version, record("race", "a")),
    push("race", created.body.version, record("race", "b")),
  ]);
  assert.equal([a, b].filter((r) => r.body.conflict).length, 1);
  assert.equal([a, b].filter((r) => r.body.version).length, 1);
});
test("Watermelon push conflict rolls back the entire batch", async () => {
  const beforeCursor = (await pull()).body.cursor;
  await push("wm-conflict", 0, record("wm-conflict"));
  const result = await call("/watermelon/push", {
    epoch,
    cursor: beforeCursor,
    changes: {
      todos: {
        created: [record("must-not-exist")],
        updated: [record("wm-conflict", "stale")],
        deleted: [],
      },
    },
  });
  assert.equal(result.status, 409);
  assert.equal(
    (await pull()).body.rows.some(
      (r: { id: string }) => r.id === "must-not-exist"
    ),
    false
  );
});
test("deletions propagate to both clients and remain absent from fresh restoration", async () => {
  const added = await push("deleted", 0, record("deleted"));
  await push("deleted", added.body.version, null);
  const wm = await call("/watermelon/pull", {
    epoch,
    cursor: 0,
    schemaVersion: 1,
  });
  assert.ok(wm.body.changes.todos.deleted.includes("deleted"));
  assert.ok(
    !wm.body.changes.todos.created.some(
      (r: { id: string }) => r.id === "deleted"
    )
  );
  const op = (await pull()).body.rows.find(
    (r: { id: string }) => r.id === "deleted"
  );
  assert.equal(op.deleted, true);
});
test("committed rows, ACKs and epoch survive server restart; new clients restore", async () => {
  const mutationId = randomUUID();
  const ack = await push("restart", 0, record("restart"), mutationId);
  await app.close();
  app = await createServer({ databaseUrl: url.toString(), token });
  assert.equal((await call("/info")).body.epoch, epoch);
  assert.deepEqual(
    await push("restart", 0, record("restart"), mutationId),
    ack
  );
  assert.ok(
    (await pull()).body.rows.some((r: { id: string }) => r.id === "restart")
  );
  assert.ok(
    (
      await call("/watermelon/pull", { epoch, cursor: 0, schemaVersion: 1 })
    ).body.changes.todos.created.some((r: { id: string }) => r.id === "restart")
  );
});

test("explicit OP resurrection is a new Watermelon creation after a tombstone", async () => {
  const added = await push("resurrect", 0, record("resurrect"));
  const deleted = await push("resurrect", added.body.version, null);
  const cursor = (await pull()).body.cursor;
  await push(
    "resurrect",
    deleted.body.version,
    record("resurrect", "restored")
  );
  const delta = await call("/watermelon/pull", {
    epoch,
    cursor,
    schemaVersion: 1,
  });
  assert.ok(
    delta.body.changes.todos.created.some(
      (r: { id: string }) => r.id === "resurrect"
    )
  );
});
