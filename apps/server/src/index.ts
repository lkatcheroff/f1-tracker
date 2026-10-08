import { buildApp } from "./app";
import { config } from "./config";

const app = await buildApp();
await app.listen({ port: config.port, host: "127.0.0.1" });
console.log(`f1-tracker server en http://127.0.0.1:${config.port}`);
