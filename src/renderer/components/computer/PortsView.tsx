// The Ports tab (compute.md §8.3 services, §8.4 detection): listening ports, polled every 5 s only while this tab is
// mounted and the window is visible (TanStack pauses intervals in the background; main marks these execs as
// non-activity), "Preview" for ports bound beyond loopback, and the services started from the app.
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Play, Plus, Radio, RotateCw } from 'lucide-react';
import type { ComputerSessionInfo, PortInfo } from '@shared/contracts/compute';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Input, Label } from '@renderer/components/ui/input';
import { MicroLabel, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { gmi } from '@renderer/lib/gmi';
import { toastActionError } from '@renderer/pages/compute/hooks';
import { Placeholder, Toolbar } from './parts';
import { computerKeys } from './session';
import { previewTab, useComputerUi } from './store';

/** Port detection cadence while the tab is visible (§8.4). */
export const PORTS_POLL_MS = 5_000;

/** Lowest port first; duplicates (IPv4 + IPv6 of one listener) merged, previewable wins. */
export function mergePorts(ports: readonly PortInfo[]): PortInfo[] {
  const byPort = new Map<number, PortInfo>();
  for (const p of ports) {
    const seen = byPort.get(p.port);
    if (!seen) byPort.set(p.port, p);
    else if (!seen.previewable && p.previewable) byPort.set(p.port, { ...p, process: p.process ?? seen.process });
    else if (!seen.process && p.process) byPort.set(p.port, { ...seen, process: p.process });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Why a service form is not ready, or null. */
export function serviceProblem(svc: { name: string; command: string; port: string }): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(svc.name.trim())) return 'Name: letters, digits, - and _ (up to 32).';
  if (!svc.command.trim()) return 'Enter the command that starts it.';
  if (svc.port.trim()) {
    const n = Number(svc.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Port: a number from 1 to 65535.';
  }
  return null;
}

export function PortsView({ session, previewsAllowed }: { session: ComputerSessionInfo; previewsAllowed: boolean }) {
  const sessionId = session.sessionId;
  const ports = useQuery({
    queryKey: computerKeys.ports(sessionId),
    queryFn: () => gmi.computer.listPorts(sessionId),
    refetchInterval: PORTS_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false,
  });
  const addPreview = useComputerUi((s) => s.addPreview);
  const setTab = useComputerUi((s) => s.setTab);
  const open = useMutation({
    mutationFn: (port: number) => gmi.computer.openPreview(sessionId, port, '/'),
    onSuccess: (preview) => {
      addPreview(preview);
      setTab(session.resourceId, previewTab(preview.previewId));
    },
    onError: (error) => toastActionError('Could not open the preview', error),
  });
  const list = ports.data ? mergePorts(ports.data) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <MicroLabel className="flex-1 px-1">Listening ports</MicroLabel>
        {ports.isFetching ? <Spinner className="mr-1 size-3" /> : null}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ports.isPending ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        ) : ports.error ? (
          <div className="p-2">
            <ErrorNotice error={ports.error} compact onRetry={() => void ports.refetch()} />
          </div>
        ) : list.length === 0 ? (
          <Placeholder icon={<Radio />} title="Nothing is listening yet">
            Start a server bound to 0.0.0.0 and it shows up here, for example{' '}
            <code className="font-mono text-2xs text-foreground">python3 -m http.server 8000</code>.
          </Placeholder>
        ) : (
          <ul aria-label="Ports" className="py-1">
            {list.map((p) => (
              <li key={p.port} data-port={p.port} className="flex h-8 items-center gap-2.5 px-3 text-xs hover:bg-accent/50">
                <span className="w-12 shrink-0 font-mono tabular-nums text-foreground">{p.port}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={`${p.process ?? 'unknown process'} · ${p.address}`}>
                  {p.process ?? 'unknown process'}
                  <span className="font-mono text-3xs"> · {p.address}</span>
                </span>
                {p.previewable && previewsAllowed ? (
                  <Button variant="outline" size="xs" disabled={open.isPending && open.variables === p.port} onClick={() => open.mutate(p.port)}>
                    {open.isPending && open.variables === p.port ? <Spinner className="size-3" /> : <Globe />} Preview
                  </Button>
                ) : (
                  <Tooltip label={p.previewable ? 'Previews are not available for this computer.' : 'Bound to this computer only: listen on 0.0.0.0 to preview it.'}>
                    <span className="shrink-0 cursor-default font-mono text-3xs text-muted-foreground">{p.previewable ? 'no preview' : 'local only'}</span>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        )}
        <Services session={session} />
      </div>
    </div>
  );
}

/** Services started from the app (§8.3): listed so a cold resume can restart them; a small form adds one. */
function Services({ session }: { session: ComputerSessionInfo }) {
  const client = useQueryClient();
  const ids = useId();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', command: '', port: '' });
  const [touched, setTouched] = useState(false);
  const problem = serviceProblem(form);
  const start = useMutation({
    mutationFn: () =>
      gmi.computer.startService(session.sessionId, {
        name: form.name.trim(),
        command: form.command.trim(),
        port: form.port.trim() ? Number(form.port) : null,
      }),
    onSuccess: () => {
      setAdding(false);
      setForm({ name: '', command: '', port: '' });
      setTouched(false);
      void client.invalidateQueries({ queryKey: computerKeys.ports(session.sessionId) });
    },
    onError: (error) => toastActionError('Could not start the service', error),
  });
  const restart = useMutation({
    mutationFn: () => gmi.computer.restartServices(session.sessionId),
    onError: (error) => toastActionError('Could not restart the services', error),
  });

  return (
    <section aria-labelledby={`${ids}-svc`} className="border-t border-border px-3 py-2.5">
      <div className="flex min-h-6 items-center gap-2">
        <MicroLabel id={`${ids}-svc`} className="flex-1">
          Services
        </MicroLabel>
        {session.services.length > 0 ? (
          <Button variant="ghost" size="xs" disabled={restart.isPending} onClick={() => restart.mutate()}>
            {restart.isPending ? <Spinner className="size-3" /> : <RotateCw />} Restart all
          </Button>
        ) : null}
        {!adding ? (
          <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        ) : null}
      </div>
      {session.services.length ? (
        <ul className="mt-1 flex flex-col gap-1">
          {session.services.map((s) => (
            <li key={s.name} className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0 font-medium">{s.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-3xs text-muted-foreground" title={s.command}>
                {s.command}
              </code>
              {s.port ? <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">:{s.port}</span> : null}
            </li>
          ))}
        </ul>
      ) : !adding ? (
        <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
          Servers started here keep running after you close the terminal, and can be restarted after a pause.
        </p>
      ) : null}
      {adding ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!problem) start.mutate();
          }}
        >
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor={`${ids}-name`} className="text-2xs">
                Name
              </Label>
              <Input id={`${ids}-name`} value={form.name} placeholder="web" onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-7 text-xs" />
            </div>
            <div className="flex w-20 flex-col gap-1">
              <Label htmlFor={`${ids}-port`} className="text-2xs">
                Port
              </Label>
              <Input
                id={`${ids}-port`}
                inputMode="numeric"
                value={form.port}
                placeholder="8000"
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                className="h-7 font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-cmd`} className="text-2xs">
              Command
            </Label>
            <Input
              id={`${ids}-cmd`}
              value={form.command}
              placeholder="python3 -m http.server 8000 --bind 0.0.0.0"
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              className="h-7 font-mono text-xs"
            />
          </div>
          {touched && problem ? <p className="text-3xs text-destructive">{problem}</p> : null}
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="outline" size="xs" disabled={start.isPending}>
              {start.isPending ? <Spinner className="size-3" /> : <Play />} Start
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
