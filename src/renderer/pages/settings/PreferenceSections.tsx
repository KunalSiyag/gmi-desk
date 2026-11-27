import { BookOpen, ExternalLink, Lock, Monitor, Moon, ShieldAlert, ShieldCheck, Sun, X } from 'lucide-react';
import { GMI_URLS } from '@shared/app';
import type { AppSettings, RouterMode, ThemePreference } from '@shared/contracts/app';
import type { AuthState } from '@shared/contracts/auth';
import type { ModelKind } from '@shared/contracts/catalog';
import { formatNumber } from '@shared/lib/format';
import { ModelPicker } from '@renderer/components/ModelPicker';
import { Dino } from '@renderer/components/brand/Dino';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { microLabel, Skeleton } from '@renderer/components/ui/misc';
import { Select, type SelectOption } from '@renderer/components/ui/select';
import { Switch } from '@renderer/components/ui/switch';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { useAppInfo, useCatalog, useSettings, useUpdateSettings } from '@renderer/lib/hooks';
import { CHAT_DEFAULTS_COPY } from './copy';
import { ActionError, CopyButton, InlineNote, Mono, Row, Section, Segmented, type SegmentOption } from './parts';

const REFRESH_HOURS = [1, 3, 6, 12, 24, 48, 168];
const LLM_KINDS: ModelKind[] = ['llm'];
const NEW_WINDOW_DAYS = [7, 14, 30, 60, 90];
const MAX_TOKENS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

function hoursLabel(h: number): string {
  if (h === 168) return 'Every week';
  if (h === 1) return 'Every hour';
  if (h % 24 === 0) return `Every ${h / 24 === 1 ? 'day' : `${h / 24} days`}`;
  return `Every ${h} hours`;
}

/** Ensures the current value is selectable even when it is not a preset. */
function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

/** Select options for numeric presets (Select values are strings; callers map back with Number()). */
function numberOptions(options: number[], current: number, label: (n: number) => string): SelectOption[] {
  return withCurrent(options, current).map((n) => ({ value: String(n), label: label(n) }));
}

/** A row-shaped placeholder while settings load (label, description, control). */
function SettingsSkeleton() {
  return (
    <div className="flex min-h-14 items-center justify-between gap-6 px-4 py-3" aria-busy>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="h-7 w-36" />
    </div>
  );
}

export function SecuritySection({ state }: { state: AuthState }) {
  const backend = state.secureStorage;
  return (
    <Section id="security" title="Security" description="Where your sign-in tokens and API key are kept.">
      <Row
        label="Secret storage"
        description={
          backend === 'os'
            ? 'Encrypted with your operating system’s keychain.'
            : backend === 'basic_text'
              ? 'No OS keyring was found, so secrets are encrypted with a weak built-in key.'
              : 'Encryption is unavailable: your sign-in and API key are kept in memory and forgotten when you quit.'
        }
      >
        {backend === 'os' ? (
          <Badge variant="primary">
            <ShieldCheck /> OS keychain
          </Badge>
        ) : backend === 'basic_text' ? (
          <Badge variant="warning">
            <ShieldAlert /> Weak encryption
          </Badge>
        ) : (
          <Badge variant="danger">
            <ShieldAlert /> Memory only
          </Badge>
        )}
      </Row>
      {backend === 'basic_text' ? (
        <InlineNote tone="warning">Install or unlock a keyring (GNOME Keyring, KWallet) and restart GMI Desk for proper encryption.</InlineNote>
      ) : null}
      <InlineNote icon={<Lock />}>Tokens and the key stay in the main process; this window only ever sees the last 4 characters.</InlineNote>
    </Section>
  );
}

function usePreferences() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const set = (patch: Partial<AppSettings>) => update.mutate(patch);
  return { settings: settings.data, loading: settings.isLoading, error: settings.error ?? update.error, set };
}

const THEMES: Array<SegmentOption<ThemePreference>> = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
];

const ROUTER_MODES: Array<SegmentOption<RouterMode>> = [
  { value: 'cost', label: 'Cost' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality', label: 'Quality' },
];

export function AppearanceSection() {
  const { settings, loading, error, set } = usePreferences();
  return (
    <Section id="appearance" title="Appearance">
      {loading || !settings ? (
        <SettingsSkeleton />
      ) : (
        <Row label="Theme" description="System follows your OS setting.">
          <Segmented label="Theme" value={settings.theme} onChange={(theme) => set({ theme })} options={THEMES} />
        </Row>
      )}
      {error ? (
        <div className="px-4 py-2">
          <ActionError error={error} />
        </div>
      ) : null}
    </Section>
  );
}

export function CatalogSection() {
  const { settings, loading, set } = usePreferences();
  return (
    <Section id="catalog" title="Model catalog">
      {loading || !settings ? (
        <SettingsSkeleton />
      ) : (
        <>
          <Row label="Refresh models" description="How often GMI Desk checks GMI for new models and prices." htmlFor="catalog-refresh">
            <Select
              id="catalog-refresh"
              className="w-36"
              value={String(settings.catalogRefreshHours)}
              onValueChange={(v) => set({ catalogRefreshHours: Number(v) })}
              options={numberOptions(REFRESH_HOURS, settings.catalogRefreshHours, hoursLabel)}
            />
          </Row>
          <Row label="Notify about new models" description="A desktop notification when GMI adds a model." htmlFor="catalog-notify">
            <Switch id="catalog-notify" checked={settings.notifyNewModels} onCheckedChange={(notifyNewModels) => set({ notifyNewModels })} />
          </Row>
          <Row label="“New” badge" description="How long a model counts as new after GMI Desk first sees it." htmlFor="catalog-new">
            <Select
              id="catalog-new"
              className="w-36"
              value={String(settings.newModelWindowDays)}
              onValueChange={(v) => set({ newModelWindowDays: Number(v) })}
              options={numberOptions(NEW_WINDOW_DAYS, settings.newModelWindowDays, (d) => `${d} days`)}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

/** The model new chats start with (AppSettings.defaultChatModel; null = GMI's first featured chat model). */
function DefaultModelRow({ value, onChange }: { value: string | null; onChange: (modelId: string | null) => void }) {
  const catalog = useCatalog();
  // A saved default that is not in the catalog right now (retired, or the catalog is still loading) is still the default.
  const known = value === null || (catalog.data?.models ?? []).some((m) => m.id === value && m.available);
  return (
    <Row
      label="Default model"
      description={
        value && !known && catalog.data ? (
          <>
            New chats start with <span className="font-mono">{value}</span>, which GMI does not list right now.
          </>
        ) : (
          CHAT_DEFAULTS_COPY.model
        )
      }
    >
      <ModelPicker
        value={value}
        onChange={(id) => onChange(id)}
        kinds={LLM_KINDS}
        align="end"
        placeholder={value ?? 'Automatic'}
        className="w-56"
      />
      {value ? (
        <Tooltip label="Back to automatic (GMI’s first featured model)">
          <Button size="icon-xs" variant="ghost" aria-label="Reset the default model to automatic" onClick={() => onChange(null)}>
            <X />
          </Button>
        </Tooltip>
      ) : null}
    </Row>
  );
}

export function ChatSection() {
  const { settings, loading, set } = usePreferences();
  return (
    <Section id="chat" title="Chat">
      {loading || !settings ? (
        <SettingsSkeleton />
      ) : (
        <>
          <DefaultModelRow value={settings.defaultChatModel} onChange={(defaultChatModel) => set({ defaultChatModel })} />
          <Row label="Max output tokens" description={CHAT_DEFAULTS_COPY.maxTokens} htmlFor="chat-max-tokens">
            <Select
              id="chat-max-tokens"
              className="w-36 tabular-nums"
              popupClassName="tabular-nums"
              value={String(settings.chatMaxTokens)}
              onValueChange={(v) => set({ chatMaxTokens: Number(v) })}
              options={numberOptions(MAX_TOKENS, settings.chatMaxTokens, formatNumber)}
            />
          </Row>
          <Row label="GMI Router mode" description={CHAT_DEFAULTS_COPY.routerMode}>
            <Segmented
              label="GMI Router mode"
              value={settings.defaultRouterMode}
              onChange={(defaultRouterMode) => set({ defaultRouterMode })}
              options={ROUTER_MODES}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

export function MediaSection() {
  const { settings, loading, set } = usePreferences();
  return (
    <Section id="media" title="Media">
      {loading || !settings ? (
        <SettingsSkeleton />
      ) : (
        <Row label="Save outputs locally" description="Download every finished image, video and audio file to the media folder." htmlFor="media-save">
          <Switch id="media-save" checked={settings.saveMediaLocally} onCheckedChange={(saveMediaLocally) => set({ saveMediaLocally })} />
        </Row>
      )}
      <InlineNote tone="warning">
        GMI serves generated files and uploads from public, unsigned URLs — anyone with a link can open it. Keep local copies and share links with care.
      </InlineNote>
    </Section>
  );
}

export function AboutSection() {
  const info = useAppInfo();
  const data = info.data;
  return (
    <Section
      id="about"
      title="About"
      action={
        <>
          <Button size="sm" variant="ghost" onClick={() => void gmi.app.openExternal(GMI_URLS.docs)}>
            <BookOpen /> GMI docs
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void gmi.app.openConsole('home')}>
            GMI Console <ExternalLink />
          </Button>
        </>
      }
    >
      {!data ? (
        <SettingsSkeleton />
      ) : (
        <>
          <div className="flex items-center gap-3 px-4 py-4">
            <Dino still size={36} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-semibold leading-5">{data.name}</span>
                {/* Neutral: the sidebar already flags demo mode; this only names it next to the version. */}
                {data.mock ? <span className={cn(microLabel, 'shrink-0 rounded-sm px-1.5 py-px leading-4 ring-1 ring-inset ring-border')}>Demo data</span> : null}
              </div>
              <p className="mt-0.5 truncate text-2xs text-muted-foreground">A desktop client for GMI Cloud.</p>
            </div>
            <Mono className="text-xs text-foreground/80">v{data.version}</Mono>
          </div>
          <Row label="Runtime" description={`${data.platform} · ${data.arch}`}>
            <Mono>
              Electron {data.electron} · Chromium {data.chrome.split('.')[0]} · Node {data.node}
            </Mono>
          </Row>
          <Row label="Data folder" description="Settings, caches, logs and downloaded media.">
            <Mono className="max-w-72 truncate" title={data.userDataDir}>
              {data.userDataDir}
            </Mono>
            <CopyButton value={data.userDataDir} label="Copy data folder path" />
          </Row>
        </>
      )}
    </Section>
  );
}
