import type { Express } from "express";
import { getUser } from "../store";
import { logRollback } from "../agents/meta";
import type { AgentName } from "../../src/shared/types";

const AGENTS = new Set<AgentName>(["intent", "importer", "habit", "meta", "designer"]);

// Versioned learned prompt sections (E7): list them, roll any agent back to any version (0 = none).
export default function register(app: Express) {
  app.get("/api/prompts/:user", (req, res) => {
    const s = getUser(req.params.user);
    if (!s) return res.status(404).json({ error: "no such user" });
    res.json(s.prompts);
  });

  app.post("/api/prompts/:user/:agent/rollback", async (req, res) => {
    const { user, agent } = req.params;
    const version = Number(req.body?.version);
    if (!getUser(user)) return res.status(404).json({ error: "no such user" });
    if (!AGENTS.has(agent as AgentName) || !Number.isInteger(version) || version < 0) return res.status(400).json({ error: "a known agent and a version number are required" });
    if (!(await logRollback(user, agent as AgentName, version))) return res.status(404).json({ error: `no ${agent} v${version}` });
    res.json(getUser(user));
  });
}
