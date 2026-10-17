import { useEffect, useRef, useState } from "react";
import { api, useAction, useUsers, useUserState } from "./api";
import { CalendarView } from "./components/CalendarView";
import { SuggestionCard, ActiveChange } from "./components/SuggestionCard";
import { LearnedPanel } from "./components/LearnedPanel";
import { DevTools } from "./components/DevTools";
import { PromptsPanel } from "./components/PromptsPanel";
import { CommandBar, type Replay } from "./components/CommandBar";
import { ImportMenu } from "./components/ImportMenu";
import { ViewSwitcher } from "./components/ViewSwitcher";

// Whether the developer tools sidebar is open, remembered per browser.
const KEY = "evolve.devtools";
const remembered = () => { try { return localStorage.getItem(KEY) !== "closed"; } catch { return true; } };
function useDevToolsOpen() {
  const [open, setOpen] = useState(remembered);
  useEffect(() => { try { localStorage.setItem(KEY, open ? "open" : "closed"); } catch { /* private window */ } }, [open]);
  return [open, setOpen] as const;
}

export default function App() {
  const [user, setUser] = useState("you");
  const users = useUsers().data ?? [];
  const { data: s, error } = useUserState(user);
  const ask = useAction(user, () => api(`/api/design/${user}`, {}));
  const react = useAction(user, ({ id, action }: { id: string; action: "accept" | "dismiss" | "revert" }) => api(`/api/proposals/${user}/${id}/${action}`, {}));
  const [dev, setDev] = useDevToolsOpen();
  const [replay, setReplay] = useState<Replay | null>(null);
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null);
  const stop = useRef(false);

  const pending = s?.proposals.find((p) => p.status === "suggested");
  const active = s?.proposals.filter((p) => p.status === "accepted").at(-1);

  return (
    <div className={`min-h-screen px-4 pb-64 pt-6 sm:px-6 ${dev ? "lg:pr-[404px]" : ""}`}>
      <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-display text-2xl font-bold tracking-tight">Evolve</div>
            <div className="text-sm text-muted">A calendar that redesigns itself around how you plan</div>
          </div>
        </header>

        {error && <div className="rounded-xl border border-[#F0B4B4] bg-[#FDECEC] p-3 text-sm">Can't reach the agent server: {error.message}</div>}

        {s && (
          <>
            <div className="flex flex-wrap items-start gap-5">
              <main className="flex min-w-0 flex-[999_1_640px] flex-col gap-4 rounded-2xl border border-line bg-white p-5">
                <ViewSwitcher user={user} spec={s.spec} />
                <CalendarView user={user} spec={s.spec} events={s.events} />
              </main>

              <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
                {pending && <SuggestionCard proposal={pending} onAccept={() => react.mutate({ id: pending.id, action: "accept" })} onDismiss={() => react.mutate({ id: pending.id, action: "dismiss" })} />}
                {active && <ActiveChange proposal={active} onRevert={() => react.mutate({ id: active.id, action: "revert" })} />}
                <LearnedPanel user={user} state={s} />
                <PromptsPanel user={user} state={s} />
              </aside>
            </div>

            <div className={`fixed inset-x-0 bottom-0 z-20 border-t ${dev ? "lg:right-[380px]" : ""} border-line bg-subtle/90 px-4 pb-3 pt-2 backdrop-blur sm:px-6`}>
              <div className="mx-auto max-w-[1400px]">
                <CommandBar user={user} replay={replay} onProgress={setProgress} stop={stop}><ImportMenu user={user} /></CommandBar>
              </div>
            </div>
          </>
        )}
      </div>
      <DevTools open={dev} onToggle={() => setDev((o) => !o)} user={user} onUser={setUser} state={s} users={users} busy={ask.isPending} onAsk={() => ask.mutate(undefined)}
        progress={progress} onReplay={(lines) => setReplay((r) => ({ id: (r?.id ?? 0) + 1, lines }))} onStop={() => (stop.current = true)} />
    </div>
  );
}
