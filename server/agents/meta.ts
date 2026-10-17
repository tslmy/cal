import { onInteraction } from "../store";

// Meta-learner (E3 to E7): learns how the person wants to be adapted to and rewrites the agents'
// learned prompt sections. Owned by the meta-learning workstream.
export function startMetaLoop() {
  onInteraction(() => {});
}
