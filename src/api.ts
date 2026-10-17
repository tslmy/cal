import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserState } from "./shared/types";

// Server state lives in the agent server (E13); the browser only caches it.

export type ServerState = UserState & { mode: "live" | "mock"; designing?: boolean };

export async function api<T = ServerState>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const stateKey = (user: string) => ["state", user];

// Polls so agent work that finishes in the background (learner, meta-learner) shows up on its own.
export function useUserState(user: string) {
  return useQuery({ queryKey: stateKey(user), queryFn: () => api(`/api/state/${user}`), refetchInterval: 1500 });
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api<{ id: string; name: string; role: string }[]>("/api/users") });
}

// A POST that refreshes the person's state when it lands.
export function useAction<V = unknown, R = unknown>(user: string, run: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: run, onSettled: () => qc.invalidateQueries({ queryKey: stateKey(user) }) });
}
