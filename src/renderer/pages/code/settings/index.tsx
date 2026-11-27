import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { McpServerConfig, McpServerStatus } from '@shared/contracts/code';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Select } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { cn } from '@renderer/lib/cn';
import { useCodeApprovals, useCodeProjects, useCodeState } from '../data';

/** MCP server states in plain words. */
const MCP_STATE_LABEL: Record<McpServerStatus['state'], string> = {
  ready: 'Ready',
  starting: 'Starting',
  stopped: 'Stopped',
  error: 'Error',
  needs_trust: 'Needs trust',
  needs_auth: 'Needs sign-in',
};

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border/60 px-4 py-3.5 last:border-b-0">
      <h3 className="text-[13px] font-medium leading-5">{title}</h3>
      {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function AddMcpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'oauth'>('none');
  const [env, setEnv] = useState('');
  const [network, setNetwork] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      const envPairs = env
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const eq = line.indexOf('=');
          return eq > 0 ? ([line.slice(0, eq).trim(), line.slice(eq + 1)] as const) : null;
        })
        .filter((p): p is readonly [string, string] => p !== null);
      const config: Omit<McpServerConfig, 'id'> = {
        name: name.trim(),
        scope: 'global',
        projectId: null,
        enabled: true,
        toolPolicy: {},
        transport:
          type === 'stdio'
            ? { type: 'stdio', command: command.trim(), args: args.split(/\s+/).filter(Boolean), envNames: envPairs.map(([k]) => k), cwd: null, network }
            : { type: 'http', url: url.trim(), auth },
      };
      await gmi.code.addMcpServer(config, Object.fromEntries(envPairs));
      await client.invalidateQueries({ queryKey: qk.codeMcp });
      onOpenChange(false);
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      setEnv('');
    } catch (error) {
      toast.error('Could not add the MCP server', { description: describeError(error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add an MCP server"
      description="GMI Desk shows the exact command (and every environment variable name) before a stdio server is saved. Values go to the encrypted store."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !name.trim() || (type === 'stdio' ? !command.trim() : !url.trim())} onClick={() => void add()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add server
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Filesystem" autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Transport</span>
          <Select
            value={type}
            onValueChange={(v) => setType(v as 'stdio' | 'http')}
            options={[
              { value: 'stdio', label: 'Local process (stdio)' },
              { value: 'http', label: 'Remote server (HTTP)' },
            ]}
            className="w-full"
          />
        </label>
        {type === 'stdio' ? (
          <>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Command</span>
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Arguments</span>
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @scope/server@1.2.3 /path/to/folder" className="font-mono" />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={network} onCheckedChange={setNetwork} aria-label="The server needs the network" /> The server needs the network
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Environment variables (one KEY=value per line)</span>
              <Textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="font-mono text-xs" placeholder="API_KEY=…" />
            </label>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">URL</span>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className="font-mono" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Authentication</span>
              <Select
                value={auth}
                onValueChange={(v) => setAuth(v as 'none' | 'bearer' | 'oauth')}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'bearer', label: 'Bearer token' },
                  { value: 'oauth', label: 'OAuth (sign-in in the browser)' },
                ]}
                className="w-full"
              />
            </label>
          </>
        )}
      </div>
    </Dialog>
  );
}

export default function CodeSettings() {
  const client = useQueryClient();
  const state = useCodeState();
  const projects = useCodeProjects();
  const approvals = useCodeApprovals();
  const rules = useQuery({ queryKey: qk.codeRules, queryFn: () => gmi.code.listRules(), staleTime: 15_000 });
  const mcp = useQuery({ queryKey: qk.codeMcp, queryFn: () => gmi.code.listMcpServers(), staleTime: 15_000 });
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const rerun = async () => {
    setBusy('sandbox');
    try {
      const next = await gmi.code.checkSandbox();
      client.setQueryData(qk.codeState, next);
      toast.success(next.sandbox.ok ? 'Sandbox self-test passed' : 'Sandbox self-test failed', { description: next.sandbox.detail ?? undefined });
    } catch (error) {
      toast.error('Sandbox self-test failed', { description: describeError(error).message });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (server: { id: string; name: string; enabled: boolean }) => {
    setBusy(server.id);
    try {
      await gmi.code.updateMcpServer(server.id, { enabled: !server.enabled });
      await client.invalidateQueries({ queryKey: qk.codeMcp });
    } catch (error) {
      toast.error(`Could not update ${server.name}`, { description: describeError(error).message });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: { id: string; name: string }) => {
    setBusy(server.id);
    try {
      await gmi.code.removeMcpServer(server.id);
      await client.invalidateQueries({ queryKey: qk.codeMcp });
    } catch (error) {
      toast.error(`Could not remove ${server.name}`, { description: describeError(error).message });
    } finally {
      setBusy(null);
    }
  };

  const sandbox = state.data?.sandbox;
  const gateway = state.data?.gateway;

  return (
    <div>
      <Section title="Sandbox" description="Agent tools run in a bubblewrap sandbox (bwrap on Linux) with the network through the app's proxy.">
        <div className="flex items-center gap-2 text-xs">
          {sandbox ? (
            sandbox.ok ? <Check aria-hidden className="size-4 text-primary-ink" /> : <TriangleAlert aria-hidden className="size-4 text-warning-foreground" />
          ) : (
            <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
          )}
          <span className={cn('font-mono text-xs', !sandbox ? 'text-muted-foreground' : sandbox.ok ? 'text-primary-ink' : 'text-warning-foreground')}>
            {sandbox ? `${sandbox.kind} · ${sandbox.ok ? 'ready' : 'unavailable'} · network ${sandbox.network}` : 'checking…'}
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => void rerun()} disabled={busy === 'sandbox'}>
            {busy === 'sandbox' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-run self-test
          </Button>
        </div>
        {sandbox?.detail ? <p className="mt-1.5 font-mono text-2xs text-muted-foreground">{sandbox.detail}</p> : null}
        <p className="mt-2 text-2xs text-muted-foreground">
          Git {state.data?.git.ok ? `✓ ${state.data.git.version ?? ''}` : '✗ not found'} · ripgrep {state.data?.ripgrep ? '✓' : '✗'} · gateway{' '}
          {gateway ? `${gateway.online ? 'online' : 'offline'} · ${gateway.queued} queued · ${gateway.inFlight} in flight` : '—'}
        </p>
      </Section>

      <Section title="Projects" description="A project is trusted after you review its instruction files, MCP servers and permission files. A changed configuration asks again.">
        {projects.data?.length === 0 ? <p className="text-2xs text-muted-foreground">No projects yet.</p> : null}
        <ul className="space-y-1.5">
          {projects.data?.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-xs">
              <ShieldCheck aria-hidden className={cn('size-3.5 shrink-0', p.trust.state === 'trusted' ? 'text-primary-ink' : 'text-warning-foreground')} />
              <span className="min-w-0 flex-1 truncate" title={p.name}>
                {p.name}
              </span>
              <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground" title={p.rootPath}>
                {p.rootPath}
              </span>
              <Badge variant={p.trust.state === 'trusted' ? 'primary' : 'warning'} className="capitalize">
                {p.trust.state}
              </Badge>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Permission rules" description="Standing allow or deny rules for agent tools. Thread, project and global scopes; 'deny' always wins.">
        {rules.data?.length === 0 ? <p className="text-2xs text-muted-foreground">No standing rules. Every tool asks according to the thread's mode.</p> : null}
        <ul className="space-y-1">
          {rules.data?.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 text-xs">
              <Badge variant={rule.effect === 'allow' ? 'primary' : 'danger'} className="w-11 justify-center capitalize">
                {rule.effect}
              </Badge>
              <span className="font-mono text-2xs">{rule.tool}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={rule.pattern ?? undefined}>
                {rule.pattern ?? 'any call'}
              </span>
              <span className="text-3xs capitalize text-muted-foreground">{rule.scope}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Delete rule for ${rule.tool}`}
                onClick={() => {
                  void gmi.code
                    .deleteRule(rule.id)
                    .then(() => client.invalidateQueries({ queryKey: qk.codeRules }))
                    .catch((error: unknown) => toast.error('Could not delete the rule', { description: describeError(error).message }));
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="MCP servers" description="Model Context Protocol servers add tools to agent threads. Third-party transports start with the MCP transport milestone; configurations can be prepared now.">
        <ul className="space-y-1.5">
          {mcp.data?.map((server) => (
            <li key={server.id} className="rounded-md border border-border/60 px-2.5 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    server.state === 'ready' ? 'bg-primary-ink' : server.state === 'error' || server.state === 'needs_trust' ? 'bg-warning' : 'bg-muted-foreground/50',
                  )}
                />
                <span className="min-w-0 truncate font-medium" title={server.name}>
                  {server.name}
                </span>
                <Badge variant="outline" className="capitalize">
                  {server.scope}
                </Badge>
                {server.unpinned ? <Badge variant="warning">Unpinned</Badge> : null}
                <span className="flex-1" />
                <span className="text-3xs text-muted-foreground">{MCP_STATE_LABEL[server.state] ?? server.state}</span>
                <Switch checked={server.enabled} onCheckedChange={() => void toggle(server)} disabled={busy === server.id} aria-label={`Enable ${server.name}`} />
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${server.name}`} onClick={() => void remove(server)} disabled={busy === server.id}>
                  <Trash2 />
                </Button>
              </div>
              <p
                className="mt-1 truncate font-mono text-2xs text-muted-foreground"
                title={server.transport.type === 'stdio' ? `${server.transport.command} ${server.transport.args.join(' ')}` : server.transport.url}
              >
                {server.transport.type === 'stdio' ? `${server.transport.command} ${server.transport.args.join(' ')}` : server.transport.url}
              </p>
              {server.tools.length > 0 ? (
                <p className="mt-1 text-2xs text-muted-foreground">
                  {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}: {server.tools.slice(0, 4).map((t) => `${t.name} (${t.policy})`).join(', ')}
                  {server.tools.length > 4 ? '…' : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus /> Add MCP server
          </Button>
          {approvals.data?.length ? (
            <span className="text-2xs tabular-nums text-warning-foreground">
              {approvals.data.length} approval{approvals.data.length === 1 ? '' : 's'} waiting in Code
            </span>
          ) : null}
        </div>
      </Section>

      <AddMcpDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
