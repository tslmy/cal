// One Nemotron model per agent role, all on Crusoe's OpenAI-compatible endpoint.
// Rate limits are per model, so spreading roles across models gives more headroom.
// planner: lead critic that picks among passing drafts (and the future planner agent)
// designer: the parallel draft designers
// observer: the future habit agent; router: small high-volume calls
export const MODELS = {
  planner: process.env.MODEL_PLANNER ?? "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
  designer: process.env.MODEL_DESIGNER ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B",
  observer: process.env.MODEL_OBSERVER ?? "nvidia/Nemotron-3.5-Lightning-30B-A3B",
  router: process.env.MODEL_ROUTER ?? "nvidia/Nemotron-3-Nano-30B-A3B",
};

type Role = keyof typeof MODELS;
const HINT: Record<Role, string> = { planner: "super", designer: "lightning", observer: "lightning", router: "nano" };
// If the size-named model is missing, fall back to the next one that is likely there.
const FALLBACK: Record<Role, string[]> = { planner: ["super", "ultra"], designer: ["lightning", "nano", "super"], observer: ["lightning", "nano", "super"], router: ["nano", "lightning"] };

// Model IDs are case-sensitive and differ between accounts, so check them against /models once
// and swap in the closest Nemotron the endpoint actually serves. Returns one note per change.
export async function resolveModels(baseURL: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET ${baseURL}/models answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  console.log(`[models] ${baseURL} serves: ${ids.join(", ") || "(none)"}`);
  const notes: string[] = [];
  for (const role of Object.keys(MODELS) as Role[]) {
    const want = MODELS[role];
    if (ids.includes(want)) continue;
    // Prefer plain chat models over omni (vision/audio) variants.
    const nemotron = ids.filter((id) => /nemotron/i.test(id)).sort((a, b) => Number(/omni/i.test(a)) - Number(/omni/i.test(b)));
    const sameName = ids.find((id) => id.toLowerCase() === want.toLowerCase());
    if (sameName) {
      MODELS[role] = sameName; // only the capitalization differed, nothing worth showing
      continue;
    }
    const found =
      FALLBACK[role].map((h) => nemotron.find((id) => id.toLowerCase().includes(h))).find(Boolean) ??
      nemotron[0];
    if (!found) {
      notes.push(`No Nemotron model on this endpoint for ${role} (wanted ${want}, ${HINT[role]} size).`);
      continue;
    }
    MODELS[role] = found;
    notes.push(`${role}: ${want} is not served here, using ${found}.`);
  }
  notes.forEach((n) => console.log(`[models] ${n}`));
  return notes;
}
