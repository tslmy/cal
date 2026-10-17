import { useMemo } from "react";
import { LayoutGroup } from "motion/react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { registry, CalendarContext, owners } from "../registry";
import type { CalendarSpec } from "../shared/catalog";
import type { CalEvent } from "../shared/types";

// Renders the current view spec. Stable layoutIds in the registry make any two views morph (P13, P15).
export function CalendarView({ user, spec, events }: { user: string; spec: CalendarSpec; events: CalEvent[] }) {
  const ctx = useMemo(() => ({ events, owner: owners(spec) }), [events, spec]);
  return (
    <CalendarContext.Provider value={ctx}>
      <JSONUIProvider registry={registry}>
        <LayoutGroup id={user}>
          <Renderer key={user} spec={spec} registry={registry} />
        </LayoutGroup>
      </JSONUIProvider>
    </CalendarContext.Provider>
  );
}
