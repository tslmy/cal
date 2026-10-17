import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { registry, CalendarContext, morph, owners } from "../registry";
import type { CalendarSpec } from "../shared/catalog";
import type { CalEvent } from "../shared/types";

// Each rendered spec carries its own context, so a view on its way out keeps its own layoutId owners while the next one morphs out of it.
function View({ spec, events }: { spec: CalendarSpec; events: CalEvent[] }) {
  const ctx = useMemo(() => ({ events, owner: owners(spec) }), [events, spec]);
  return (
    <CalendarContext.Provider value={ctx}>
      <Renderer spec={spec} registry={registry} />
    </CalendarContext.Provider>
  );
}

// Renders the current view spec. Stable layoutIds in the registry make any two views morph (P13, P15):
// a spec with the same elements (week -> work week, trimmed hours) re-renders in place so its props animate;
// a different shape (month -> week, month -> year) cross-fades the old view while shared days and weeks fly into place.
// With reduced motion every change is a plain cross-fade (P16).
export function CalendarView({ user, spec, events }: { user: string; spec: CalendarSpec; events: CalEvent[] }) {
  const reduce = useReducedMotion();
  const shape = reduce ? JSON.stringify(spec) : `${spec.root}|${Object.entries(spec.elements).map(([k, e]) => `${k}:${e.type}`).join()}`;
  // The outgoing view is popped out of flow, so the box eases to the incoming view's height instead of jumping.
  // A CSS transition, because driving it through Motion or React state would restart the layout animations underneath.
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => box.current && (box.current.style.height = `${e.contentRect.height}px`));
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, []);
  return (
    <MotionConfig reducedMotion="user" transition={morph}>
      <JSONUIProvider registry={registry}>
        <LayoutGroup id={user}>
          <div ref={box} className="transition-[height] duration-300 ease-out motion-reduce:transition-none">
            <div ref={inner} className="relative">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={`${user}|${shape}`} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.25 } }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
                  <View spec={spec} events={events} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </LayoutGroup>
      </JSONUIProvider>
    </MotionConfig>
  );
}
