import { Terminal as TerminalIcon, X } from 'lucide-react';
import { useTerminalSessions } from '@/stores/terminal-sessions';
import { titleCase } from './NodeTerminalModal';

/**
 * Floating dock that surfaces minimized terminal sessions. Sits bottom-
 * right of the admin UI so it's visible across navigation. Each pill
 * restores its session on click (re-mounts the modal); the small × on
 * each pill terminates that session entirely.
 *
 * Renders nothing when there are no minimized sessions — operators
 * who never minimize will never see it.
 */
export function BackgroundTerminalsDock() {
  // Pull the FULL sessions array (stable identity until state changes)
  // and filter in the component body. A `.filter()` inside the zustand
  // selector returns a new array on every render — useSyncExternalStore
  // then sees the snapshot as "changed" and schedules another render,
  // which calls the selector again, looping until React bails out
  // with "Maximum update depth exceeded".
  const sessions = useTerminalSessions((s) => s.sessions);
  const restore = useTerminalSessions((s) => s.restore);
  const terminate = useTerminalSessions((s) => s.terminate);
  const minimized = sessions.filter((sess) => sess.minimized);

  if (minimized.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2"
      data-testid="background-terminals-dock"
    >
      {minimized.map((sess) => (
        <div
          key={sess.id}
          className="group flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-1.5 py-1.5 text-zinc-200 shadow-lg"
        >
          <button
            type="button"
            onClick={() => restore(sess.id)}
            className="flex items-center gap-2.5 rounded-full px-4 py-1.5 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            aria-label={`Restore ${titleCase(sess.nodeName)} shell`}
            title={`Restore ${titleCase(sess.nodeName)} shell`}
            data-testid={`background-terminal-restore-${sess.nodeName}`}
          >
            <TerminalIcon size={16} className="text-zinc-400" aria-hidden="true" />
            <span className="text-sm font-medium">
              <span className="font-mono">{titleCase(sess.nodeName)}</span>
              <span className="ml-1.5 text-zinc-400">Shell</span>
            </span>
            {/* Status dot: green pulsing when live, red static when
                the WS has dropped. Operator sees at a glance which
                background sessions need a Reconnect once restored. */}
            {sess.status === 'disconnected' ? (
              <span className="relative ml-1 flex h-2 w-2" aria-hidden="true">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
            ) : (
              <span className="relative ml-1 flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); terminate(sess.id); }}
            className="rounded-full p-1.5 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-700/40 hover:text-red-200 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-400"
            aria-label={`Terminate ${titleCase(sess.nodeName)} shell`}
            title={`Terminate ${titleCase(sess.nodeName)} shell`}
            data-testid={`background-terminal-terminate-${sess.nodeName}`}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
