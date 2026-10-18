import express from "express";
import core from "./routes/core";
import intent from "./routes/intent";
import imports from "./routes/imports";
import learning from "./routes/learning";
import prompts from "./routes/prompts";
import { startLoop } from "./loop";
import { startMetaLoop } from "./agents/meta";
import { isLive } from "./llm";
import { getUser } from "./store";

const app = express();
app.use(express.json({ limit: "5mb" }));
// Every route with a :user answers 404 for someone who doesn't exist, so handlers can rely on getUser.
app.param("user", (_req, res, next, id: string) => (getUser(id) ? next() : res.status(404).json({ error: "no such user" })));
for (const register of [core, intent, imports, learning, prompts]) register(app);
startLoop();
startMetaLoop();

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Evolve agents listening on :${port}${isLive() ? "" : " (mock mode: set CRUSOE_API_KEY for live)"}`));
