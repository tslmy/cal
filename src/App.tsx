import { useState } from "react";
import { api, useAction, useUsers, useUserState } from "./api";
import { CalendarView } from "./components/CalendarView";
import { SuggestionCard, ActiveChange } from "./components/SuggestionCard";
import { LearnedPanel } from "./components/LearnedPanel";
import { ActivityPanel } from "./components/ActivityPanel";
import { CommandBar } from "./components/CommandBar";
import { ImportMenu } from "./components/ImportMenu";
import { ViewSwitcher } from "./components/ViewSwitcher";

export default function App() {
  const [user, setUser] = useState("you");
  const users = useUsers().data ?? [];
  const { data: s, error } = useUserState(user);
  const ask = useAction(user, () => api(`/api/design/${user}`, {}));
  const react = useAction(user, ({ id, action }: { id: string; action: "accept" | "dismiss" | "revert" }) => api(`/api/proposals/${user}/${id}/${action}`, {}));
  const reset = useAction(user, () => api(`/api/state/${user}/reset`, {}));

  const pending = s?.proposals.find((p) => p.status === "suggested");
  const active = s?.proposals.filter((p) => p.status === "accepted").at(-1);

  return (
    <div className="min-h-screen px-4 pb-12 pt-6 sm:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-display text-2xl font-bold tracking-tight">Evolve</div>
            <div className="text-sm text-muted">A calendar that redesigns itself around how you plan</div>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Choose a user">
            {users.map((p) => (
              <button key={p.id} type="button" aria-pressed={p.id === user} onClick={() => setUser(p.id)}
                className={`flex min-h-11 flex-col items-start rounded-xl border px-3.5 py-1.5 text-left text-sm leading-tight ${p.id === user ? "border-ink bg-ink text-white" : "border-line-strong bg-white"}`}>
                <span className="font-semibold">{p.name}</span>
                <span className={`text-xs ${p.id === user ? "text-line-strong" : "text-muted"}`}>{p.role}</span>
              </button>
            ))}
            <button type="button" onClick={() => reset.mutate(undefined)} className="min-h-11 rounded-xl border border-line-strong bg-white px-3.5 text-sm">Start over</button>
          </div>
        </header>

        {error && <div className="rounded-xl border border-[#F0B4B4] bg-[#FDECEC] p-3 text-sm">Can't reach the agent server: {error.message}</div>}

        {s && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-[1_1_480px]"><CommandBar user={user} /></div>
              <ImportMenu user={user} />
            </div>

            <div className="flex flex-wrap items-start gap-5">
              <main className="flex min-w-0 flex-[999_1_640px] flex-col gap-4 rounded-2xl border border-line bg-white p-5">
                <ViewSwitcher user={user} spec={s.spec} />
                <CalendarView user={user} spec={s.spec} events={s.events} />
              </main>

              <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
                {pending && <SuggestionCard proposal={pending} onAccept={() => react.mutate({ id: pending.id, action: "accept" })} onDismiss={() => react.mutate({ id: pending.id, action: "dismiss" })} />}
                {active && <ActiveChange proposal={active} onRevert={() => react.mutate({ id: active.id, action: "revert" })} />}
                <LearnedPanel user={user} state={s} />
                <ActivityPanel steps={s.activity} mode={s.mode} busy={ask.isPending} onAsk={() => ask.mutate(undefined)} />
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
