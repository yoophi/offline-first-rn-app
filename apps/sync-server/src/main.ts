import { createServer } from "./server.js";
const app = await createServer({
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://todo:todo-local-only@127.0.0.1:54329/todo",
  token: process.env.SYNC_TOKEN ?? "",
});
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
});
console.log(
  `Sync server listening at ${
    (app.server.address() && process.env.PORT) || 3000
  }`
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
