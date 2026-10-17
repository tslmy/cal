import type { Express } from "express";
import { addActivity, getUser, log } from "../store";
import { parseIntent } from "../agents/intent";

// Natural-language CRUD (P1 to P3, P5). Parsing never writes events: the client previews the
// ChangeSet and applies it through /api/changes, which logs each applied operation.
export default function register(app: Express) {
  app.post("/api/intent/:user", async (req, res) => {
    const user = req.params.user;
    const s = getUser(user);
    if (!s) return res.status(404).json({ error: "no such user" });
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });
    const source = req.body?.source === "text" ? "text" : "typed";
    try {
      const { changeSet, trace, query } = await parseIntent(s, text, source);
      await addActivity(user, trace);
      if (query) await log(user, "query", { text, answer: changeSet.answer }, source);
      res.json(changeSet);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
