//! Plugin-system logging — every line flows through here so the console is
//! greppable with one filter. Format: `[plugins]` for host-side events,
//! `[plugins(id)]` when a specific plugin caused it; disk-plugin iframe
//! pages log under `[lume bridge]` (their own console) — see
//! `iframeBridge.tsx`. debug() carries per-call detail (RPC traffic, skip
//! reasons); info() is lifecycle-level; error()/warn() always deserve eyes.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, id: string | null, msg: string, rest: unknown[]) {
  // eslint-disable-next-line no-console
  console[level]("[plugins]", ...(id ? [`(${id})`] : []), msg, ...rest);
}

export const plog = {
  debug: (id: string | null, msg: string, ...rest: unknown[]) => emit("debug", id, msg, rest),
  info: (id: string | null, msg: string, ...rest: unknown[]) => emit("info", id, msg, rest),
  warn: (id: string | null, msg: string, ...rest: unknown[]) => emit("warn", id, msg, rest),
  error: (id: string | null, msg: string, ...rest: unknown[]) => emit("error", id, msg, rest),
};
