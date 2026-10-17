import express from "express";
import core from "./routes/core";
import intent from "./routes/intent";
import imports from "./routes/imports";
import learning from "./routes/learning";
import { startLoop } from "./loop";
import { isLive } from "./llm";

const app = express();
app.use(express.json({ limit: "5mb" }));
for (const register of [core, intent, imports, learning]) register(app);
startLoop();

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Evolve agents listening on :${port}${isLive() ? "" : " (mock mode: set CRUSOE_API_KEY for live)"}`));
