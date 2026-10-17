# Evolve

A calendar that becomes more personal the more it is used. People add, change and remove events by typing a sentence or importing a file. A habit learner turns what they do into beliefs with confidence scores. When a belief crosses the threshold, the designer agent proposes one view change, which morphs in and can always be undone. A meta-learner watches how people react to those proposals and rewrites every agent's prompt to match, its own included.

Built for the Crusoe Recursive Agents Hackathon. All agents run on Crusoe Managed Inference. Without a key, every agent falls back to an offline mock, so the whole demo also runs with no network.

## Run it

```bash
npm install
cp .env.example .env   # add CRUSOE_API_KEY for live models; leave empty for offline mock mode
npm run dev            # web on :5173, agents on :8787
```

State is saved in `data/evolve.json`. To start everyone fresh, delete that file, or press **Start over** to reset one person.

## Demo (about 3 minutes, works offline)

1. Pick **You** (a new person with no events and nothing learned).
2. Type `lunch with Ana Thursday around noon`, check the fields, and press Enter. The time is stored as approximate and drawn with a dashed edge.
3. Type `dentist tomorrow 10am`, then `empty out my weekend for a business trip`. The preview lists what will be removed and added. Apply it, then use **Undo** on the toast.
4. **Import → Calendar file**: `samples/team-offsite.ics`. Import it again: nothing new is added. **Import → Text file**: `samples/weekend-trip.txt` produces moves and removals, not just additions.
5. In "What I've learned", choose Sam and press **Replay**. Eight simulated weeks feed the log, beliefs grow, one crosses 0.70, and a suggestion appears that cites the habit with its number.
6. Press **Try it** and the view morphs. Press **Undo** and it morphs back. Ask the designer again, try the second invented view, and undo it too.
7. The meta-learner lowers novelty appetite, rewrites the designer's learned section (the diff shows in Agent activity, and every version is listed under "What each agent is told"), and the next suggestion is a plain month view.

The view buttons (Month, Week, Work week, Work hours, Year, Years) morph too, and those switches are logged as signals.

## How it fits together

```
sentence / file ─▶ intent parser / importer ─▶ change set (preview, apply, undo)
                                                  │
           every action ─▶ interaction log ◀──────┘
                               │
        habit learner ◀────────┤  beliefs with confidence and evidence
             │                 │
   proposal gate (threshold, cadence, no repeats) ─▶ designer + critic ─▶ suggestion
                               │                                      │
        meta-learner ◀─────────┘◀──── accept / dismiss / revert ◀─────┘
             │
             └─▶ rewrites every agent's learned prompt section (versioned, replayed before adoption, rollback)
```

| Agent | File | Model (Crusoe) |
|---|---|---|
| Intent parser | `server/agents/intent.ts` | `openai/gpt-oss-120b` (role `intent`) |
| Importer | `server/agents/importer.ts` (.ics in code with ical.js; email with mailparser plus a model) | Nemotron 3.5 Lightning |
| Habit learner | `server/agents/habit.ts` | Nemotron 3 Nano (role `router`) |
| Meta-learner | `server/agents/meta.ts` | Nemotron 3 Super (role `planner`) |
| Designer + critic | `server/designer.ts`, `src/shared/critic.ts` | Lightning drafts, Super lead critic |
| Proposal gate and loop | `server/loop.ts` | plain code |

- **Prompts** (`server/prompts.ts`): each agent's system prompt is a fixed core followed by a learned "About this person" section. Only the meta-learner writes the learned part, and the core stays byte-identical so the prefix cache still hits. Each rewrite is stored as a version with its diff, reason and evidence. It is replayed against the person and the sample personas before adoption, and rolled back automatically after two reverts of proposals made under it.
- **Model calls** (`server/llm.ts`): JSON validated with Zod and retried with the validation error. Each model has its own queue under Crusoe's per-model rate limit, with backoff on 429 and 503.
- **Replay cache** (`server/cache.ts`): the intent parser's live answers are cached in `cache/llm.json`, keyed by model, source and the exact text. Re-running the same sentences or text files is instant, which helps when fast-forwarding a demo. The cache stores plans with filters rather than event ids, so a replayed plan still resolves against the current events. Set `LLM_CACHE=0` to turn it off, or delete the file to start over.
- **State** (`server/store.ts`): one JSON file via lowdb, holding events, the interaction log, beliefs, proposals, prompt versions and activity.
- **Views** (`src/shared/catalog.ts`, `src/registry.tsx`): json-render specs over six building blocks. Every day, week and month has a stable Motion `layoutId`, so any two views morph, including ones the designer invents. No view hides an event: anything filtered out shows up as an overflow marker.

## Not done yet

- Live mode has not been run end to end in the build environment, which had no Crusoe key. Check the model IDs with `GET /v1/models`; the server logs what it swapped in.
- Gmail connection (P6): email import works from `.eml` files, but there is no OAuth connection to a mailbox.
- The month and year morph shows the week bricks briefly as scaled blocks.
