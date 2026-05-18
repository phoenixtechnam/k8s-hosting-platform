import { useTerminalSessions } from '@/stores/terminal-sessions';
import {
  NodeTerminalModal,
  NodeTerminalStepUpDialog,
  NodeTerminalOpenErrorBanner,
  NodeTerminalOpeningOverlay,
} from './NodeTerminalModal';
import { BackgroundTerminalsDock } from './BackgroundTerminalsDock';

/**
 * App-level mount point for the node-terminal feature. Renders:
 *   - The active modal when a session is foregrounded
 *   - The step-up dialog when openFresh is waiting on credentials
 *   - The error banner when openFresh fails for a non-step-up reason
 *   - The background dock (only visible when there are minimized sessions)
 *
 * Lives in App.tsx so its children survive page navigation. The xterm
 * Terminal + WebSocket for each session live in the store's vanilla
 * ref map — outside the React tree entirely — so route changes never
 * disrupt the running shell.
 */
export function NodeTerminalHost() {
  const activeId = useTerminalSessions((s) => s.activeId);
  const sessions = useTerminalSessions((s) => s.sessions);
  const pendingStepUp = useTerminalSessions((s) => s.pendingStepUp);
  const stepUpError = useTerminalSessions((s) => s.stepUpError);
  const openError = useTerminalSessions((s) => s.openError);
  const openingFor = useTerminalSessions((s) => s.openingFor);
  const verifyStepUpPassword = useTerminalSessions((s) => s.verifyStepUpPassword);
  const verifyStepUpPasskey = useTerminalSessions((s) => s.verifyStepUpPasskey);
  const openFresh = useTerminalSessions((s) => s.openFresh);

  const active = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  // Show the provisioning overlay only when: an open-flow is in
  // progress, the modal isn't already open for it, AND we're not
  // currently in the step-up phase (which has its own dialog).
  const showOpeningOverlay = openingFor !== null && !active && !pendingStepUp;

  // Hold a reference to the pending node-name for the error banner's
  // Retry action (the openFresh state machine clears pendingStepUp on
  // success, but we want to remember which node the operator targeted).
  const errorRetryNodeName = pendingStepUp?.nodeName
    ?? sessions[sessions.length - 1]?.nodeName
    ?? null;

  return (
    <>
      {active && <NodeTerminalModal sessionId={active.id} nodeName={active.nodeName} />}
      {showOpeningOverlay && openingFor && <NodeTerminalOpeningOverlay nodeName={openingFor} />}
      {pendingStepUp && (
        <NodeTerminalStepUpDialog
          nodeName={pendingStepUp.nodeName}
          methods={pendingStepUp.methods}
          error={stepUpError}
          onVerifyPassword={verifyStepUpPassword}
          onVerifyPasskey={verifyStepUpPasskey}
          onCancel={() => useTerminalSessions.setState({ pendingStepUp: null, stepUpError: null })}
        />
      )}
      {openError && (
        <NodeTerminalOpenErrorBanner
          message={openError}
          onRetry={() => {
            if (errorRetryNodeName) void openFresh(errorRetryNodeName);
            else useTerminalSessions.setState({ openError: null });
          }}
          onDismiss={() => useTerminalSessions.setState({ openError: null })}
        />
      )}
      <BackgroundTerminalsDock />
    </>
  );
}
