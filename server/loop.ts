import { onInteraction } from "./store";

// The adaptation loop (E8): habit learner after every few interactions, meta-learner after every
// proposal outcome, both also on a timer. Wired up by the learning workstream.
export function startLoop() {
  onInteraction(() => {});
}
