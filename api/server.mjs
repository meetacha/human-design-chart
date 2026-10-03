import { createApiServer } from "./app.mjs";

const api = createApiServer();

const address = await api.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT || process.env.PLUTO_API_PORT || 8790),
});

console.log(`Human Design API listening on http://${address.address}:${address.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await api.close();
    process.exit(0);
  });
}
