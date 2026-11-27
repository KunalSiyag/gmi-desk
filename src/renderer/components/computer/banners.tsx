// The dock's state banners (compute.md §8.7), pure so markup tests render each state:
// - SessionBanner, above every session tab: closed / unreachable (Reconnect), paused (Resume, price in main's dialog);
// - TerminalBanners, above the terminal: attached elsewhere (Take over, native confirm in main), connecting /
//   reconnecting, and the cold-resume notice with "Restart services (n)".
import { useMutation } from '@tanstack/react-query';
import { Play, RotateCw } from 'lucide-react';
import type { ComputeResource, ComputerSessionInfo } from '@shared/contracts/compute';
import { Button } from '@renderer/components/ui/button';
import { Spinner } from '@renderer/components/ui/misc';
import { gmi } from '@renderer/lib/gmi';
import { toastActionError, useResourceAction } from '@renderer/pages/compute/hooks';
import { Banner } from './parts';

/** The session is paused (by the idle guard, the user or GMI), whatever told us first. */
export function sessionPaused(session: Pick<ComputerSessionInfo, 'state'>, resource: Pick<ComputeResource, 'phase'>): boolean {
  return session.state === 'paused' || resource.phase === 'paused' || resource.phase === 'pausing';
}

/** The session cannot be used at all (ended, unreachable, paused): terminal-only banners give way. */
export function sessionBlocked(session: Pick<ComputerSessionInfo, 'state'>, resource: Pick<ComputeResource, 'phase'>): boolean {
  return session.state === 'closed' || session.state === 'unavailable' || sessionPaused(session, resource);
}

export function SessionBanner({
  session,
  resource,
  onReconnect,
}: {
  session: ComputerSessionInfo;
  resource: Pick<ComputeResource, 'id' | 'phase'>;
  onReconnect: () => void;
}) {
  const resume = useResourceAction('Could not resume', (id: string) => gmi.compute.resume(id));
  if (session.state === 'closed' || session.state === 'unavailable') {
    return (
      <Banner
        tone="danger"
        title={session.state === 'closed' ? 'This computer’s session has ended' : 'The computer is not reachable'}
        detail={session.reason ?? undefined}
        action={
          <Button size="xs" variant="outline" onClick={onReconnect}>
            <RotateCw /> Reconnect
          </Button>
        }
      />
    );
  }
  if (sessionPaused(session, resource)) {
    return (
      <Banner
        tone="warning"
        title={resource.phase === 'pausing' ? 'Pausing…' : 'Paused: the terminal is read-only'}
        detail="Resuming starts billing again; the price is shown before anything starts."
        action={
          resource.phase === 'paused' ? (
            <Button size="xs" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate([resource.id])}>
              {resume.isPending ? <Spinner className="size-3" /> : <Play />} Resume…
            </Button>
          ) : null
        }
      />
    );
  }
  return null;
}

export function TerminalBanners({ session, blocked = false }: { session: ComputerSessionInfo; blocked?: boolean }) {
  const takeOver = useMutation({
    mutationFn: () => gmi.computer.terminalTakeOver(session.sessionId),
    onError: (error) => toastActionError('Could not take over the shell', error),
  });
  const restart = useMutation({
    mutationFn: () => gmi.computer.restartServices(session.sessionId),
    onError: (error) => toastActionError('Could not restart the services', error),
  });
  if (blocked || session.state === 'closed' || session.state === 'unavailable' || session.state === 'paused') return null;
  const term = session.terminal.state;
  if (term === 'attached_elsewhere') {
    return (
      <Banner
        tone="warning"
        title="This shell is open somewhere else"
        detail="Another window or device is attached. Taking over closes that shell and every program running in it."
        action={
          <Button size="xs" variant="outline" disabled={takeOver.isPending} onClick={() => takeOver.mutate()}>
            {takeOver.isPending ? <Spinner className="size-3" /> : null} Take over…
          </Button>
        }
      />
    );
  }
  const banners = [];
  const connecting = term === 'connecting' || session.state === 'connecting';
  if (connecting || term === 'reconnecting' || session.state === 'reconnecting') {
    banners.push(
      <Banner
        key="reconnecting"
        tone="working"
        title={connecting ? 'Connecting to the shell…' : 'Reconnecting…'}
        detail={connecting ? undefined : 'The shell keeps running; output produced meanwhile may be missing.'}
      />,
    );
  }
  if (session.coldResumed) {
    const n = session.services.length;
    banners.push(
      <Banner
        key="cold"
        tone="info"
        title="Processes from before the pause may be gone"
        detail="The sandbox was resumed: servers and shells that were running have stopped."
        action={
          n > 0 ? (
            <Button size="xs" variant="outline" disabled={restart.isPending} onClick={() => restart.mutate()}>
              {restart.isPending ? <Spinner className="size-3" /> : <RotateCw />} Restart services ({n})
            </Button>
          ) : null
        }
      />,
    );
  }
  return banners.length ? <>{banners}</> : null;
}
