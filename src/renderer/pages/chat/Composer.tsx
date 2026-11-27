import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AlertTriangle, ArrowUp, Brain, Gauge, KeyRound, SlidersHorizontal, Square, X } from 'lucide-react';
import type { RouterMode } from '@shared/contracts/app';
import type { ModelKind } from '@shared/contracts/catalog';
import type { ChatSettings, ChatThread, ReasoningEffort } from '@shared/contracts/chat';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { AUTO_MODEL, ModelPicker } from '@renderer/components/ModelPicker';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Textarea } from '@renderer/components/ui/input';
import { Popover } from '@renderer/components/ui/popover';
import { Select, type SelectOption } from '@renderer/components/ui/select';
import { pressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { useAuth, useCatalog } from '@renderer/lib/hooks';
import { useUi } from '@renderer/lib/store';
import { draftFromSettings, settingsPatchFromDraft, type SettingsDraft } from './drafts';
import { shortModelName } from './format';
import { useChatUi } from './hooks';
import { keyStorageClause } from '../settings/copy';

const LLM_KINDS: ModelKind[] = ['llm'];

const ROUTER_MODE_OPTIONS: SelectOption<RouterMode>[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality', label: 'Quality' },
];

const EFFORT_OPTIONS: SelectOption<ReasoningEffort | ''>[] = [
  { value: '', label: 'Default effort' },
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
];

/**
 * Compact select for the composer toolbar: the kit Select's ghost trigger (no box, leading icon, its chevron and
 * keyboard ring), opening upwards like the model picker next to it.
 */
function ToolbarSelect<V extends string>({
  icon,
  label,
  tooltip,
  value,
  onChange,
  options,
}: {
  icon: ReactNode;
  label: string;
  tooltip: string;
  value: V;
  onChange: (value: V) => void;
  options: ReadonlyArray<SelectOption<V>>;
}) {
  return (
    <Tooltip label={tooltip}>
      <span className="flex shrink-0">
        <Select variant="ghost" side="top" icon={icon} aria-label={label} value={value} onValueChange={onChange} options={options} />
      </span>
    </Tooltip>
  );
}

export interface ComposerProps {
  thread: ChatThread;
  streaming: boolean;
  /** Shows the "add an inference key" notice instead of the input. */
  keyState: 'ok' | 'missing' | 'invalid';
  error: unknown;
  /** A budget limit is reached but not enforced (warn-only): the last message went out anyway. */
  budgetWarning?: string | null;
  onDismissBudgetWarning?: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onSettingsChange: (patch: Partial<ChatSettings>) => void;
  pickerRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function Composer({
  thread,
  streaming,
  keyState,
  error,
  budgetWarning,
  onDismissBudgetWarning,
  onSend,
  onStop,
  onSettingsChange,
  pickerRef,
  inputRef,
}: ComposerProps) {
  const initial = useChatUi((s) => s.drafts[thread.id] ?? '');
  const setDraft = useChatUi((s) => s.setDraft);
  const [text, setText] = useState(initial);
  const [sending, setSending] = useState(false);
  const settings = thread.settings;
  const auto = settings.mode === 'auto';
  const catalog = useCatalog();
  const catalogModel = settings.model ? catalog.data?.models.find((m) => m.id === settings.model) : undefined;
  const modelName = settings.model ? (catalogModel?.name ?? shortModelName(settings.model)) : null;
  const modelApi = auto ? null : (catalogModel?.api ?? null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text, inputRef]);

  const update = (value: string) => {
    setText(value);
    setDraft(thread.id, value);
  };

  const canSend = text.trim().length > 0 && !streaming && !sending;
  const submit = () => {
    if (!canSend) return;
    const value = text;
    update('');
    setSending(true);
    // Keep focus here (Esc stops the reply): a clicked Send button is about to be replaced by Stop.
    inputRef.current?.focus();
    onSend(value)
      .catch(() => update(value))
      .finally(() => setSending(false));
  };

  const pickerValue = auto ? AUTO_MODEL : settings.model;
  const onModel = (id: string) => {
    if (id === AUTO_MODEL) onSettingsChange({ mode: 'auto' });
    else onSettingsChange({ mode: 'model', model: id });
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          'rounded-xl border border-border bg-card shadow-xs transition-[border-color,box-shadow] duration-150 ease-out dark:shadow-none',
          keyState === 'ok' && 'focus-within:border-foreground/20 focus-within:shadow-sm dark:focus-within:border-white/[0.16]',
        )}
      >
        {keyState === 'ok' ? (
          <Textarea
            ref={inputRef}
            autoFocus
            rows={1}
            value={text}
            aria-label="Message"
            placeholder={auto ? 'Ask anything — GMI Router picks the model' : `Message ${modelName ?? 'the model'}`}
            onChange={(e) => update(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape' && streaming) {
                e.preventDefault();
                onStop();
              }
            }}
            className="block min-h-[3.25rem] resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 text-[14px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 dark:bg-transparent"
          />
        ) : (
          <KeyNotice invalid={keyState === 'invalid'} />
        )}
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <div ref={pickerRef} className="min-w-0">
            <ModelPicker
              value={pickerValue}
              onChange={onModel}
              kinds={LLM_KINDS}
              allowAuto
              side="top"
              placeholder={settings.model ? shortModelName(settings.model) : 'Choose a model'}
              className="h-7 max-w-64 border-transparent px-2 text-xs hover:bg-accent dark:bg-transparent"
            />
          </div>
          {auto ? (
            <ToolbarSelect
              icon={<Gauge />}
              label="Router mode"
              tooltip="What GMI Router optimises when it picks a model: cost, a balance, or quality"
              value={settings.routerMode}
              onChange={(routerMode) => onSettingsChange({ routerMode })}
              options={ROUTER_MODE_OPTIONS}
            />
          ) : (
            <ToolbarSelect
              icon={<Brain />}
              label="Reasoning effort"
              tooltip="Reasoning effort (sent only when set; models without reasoning ignore it)"
              value={settings.reasoningEffort ?? ''}
              onChange={(effort) => onSettingsChange({ reasoningEffort: effort || null })}
              options={EFFORT_OPTIONS}
            />
          )}
          <ThreadSettingsButton settings={settings} onChange={onSettingsChange} noTemperature={modelApi === 'responses'} />
          <div className="flex-1" />
          {streaming ? (
            <Tooltip label="Stop (Esc)">
              <Button variant="secondary" size="icon-sm" aria-label="Stop generating" onClick={onStop} className="rounded-lg border border-input text-foreground">
                <Square className="size-2.5 fill-current" />
              </Button>
            </Tooltip>
          ) : keyState === 'ok' ? (
            // Lime only once there is something to send; empty, it is a quiet grey key.
            <Button
              size="icon-sm"
              aria-label="Send message"
              onClick={submit}
              disabled={!canSend}
              className="rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none [&_svg]:size-4 [&_svg]:stroke-[2.25]"
            >
              <ArrowUp />
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorNotice compact error={error} /> : null}
      {budgetWarning && !error ? <BudgetWarning text={budgetWarning} onDismiss={onDismissBudgetWarning} /> : null}
    </div>
  );
}

/** Warn-only budgets: the limit is reached, chat keeps working, the user is told (Usage → Budget explains "Off"). */
function BudgetWarning({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div role="status" className="flex items-start gap-2 px-1 text-2xs text-muted-foreground">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning-foreground" />
      <p className="min-w-0 flex-1 leading-relaxed">{text}</p>
      <button
        type="button"
        onClick={() => navigate('usage', { section: 'budget' })}
        className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
      >
        Review budget
      </button>
      {onDismiss ? (
        <button type="button" aria-label="Dismiss budget warning" onClick={onDismiss} className={cn('-mr-0.5 shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground', pressMotion)}>
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** Shown instead of the text box until chat can authenticate: one button into the Connect chat dialog. */
function KeyNotice({ invalid }: { invalid: boolean }) {
  const openConnect = useUi((s) => s.openConnect);
  const auth = useAuth();
  return (
    <div className="flex items-center gap-3 px-3 pb-1 pt-3">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md border bg-background',
          invalid ? 'border-destructive/30 text-destructive' : 'border-border text-primary-ink',
        )}
      >
        <KeyRound aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{invalid ? 'GMI rejected your API key' : 'Connect chat to start'}</p>
        <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
          {invalid
            ? 'Create a new key in GMI Console and GMI Desk picks it up from your clipboard.'
            : `About 30 seconds: copy a key in GMI Console and GMI Desk picks it up; ${keyStorageClause(auth.data?.secureStorage ?? 'os')}.`}
        </p>
      </div>
      <Button size="sm" onClick={openConnect} className="shrink-0">
        {invalid ? 'Replace key' : 'Connect chat'}
      </Button>
    </div>
  );
}

/** Per-chat options that rarely change: system prompt, temperature, max tokens. */
function ThreadSettingsButton({
  settings,
  onChange,
  noTemperature,
}: {
  settings: ChatSettings;
  onChange: (patch: Partial<ChatSettings>) => void;
  /** The model's API ignores temperature (Responses-only reasoning models). */
  noTemperature?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(settings));
  // What commit() compares against. Kept current after every render, and moved forward by commit() itself so a
  // blur and a close in the same tick (before React re-renders) save once.
  const latest = useRef({ draft, settings });
  useLayoutEffect(() => {
    latest.current = { draft, settings };
  });

  const { systemPrompt, temperature, maxTokens } = settings;
  useEffect(() => {
    if (open) setDraft(draftFromSettings({ systemPrompt, temperature, maxTokens }));
  }, [open, systemPrompt, temperature, maxTokens]);

  const edit = (field: keyof SettingsDraft, value: string) => {
    const next = { ...latest.current.draft, [field]: value };
    latest.current = { ...latest.current, draft: next };
    setDraft(next);
  };

  /** Saves every edited field at once: on Esc and outside clicks (before the popup unmounts), blur and Enter. */
  const commit = () => {
    const { patch, draft: saved } = settingsPatchFromDraft(latest.current.draft, latest.current.settings);
    latest.current = { draft: saved, settings: patch ? { ...latest.current.settings, ...patch } : latest.current.settings };
    setDraft(saved);
    if (patch) onChange(patch);
  };
  const commitOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  const customised = Boolean(settings.systemPrompt) || settings.temperature !== null;
  const auto = settings.mode === 'auto';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) commit();
        setOpen(next);
      }}
      side="top"
      align="start"
      className="w-80 p-3"
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="Chat settings" className={cn('relative', customised && 'text-foreground')}>
          <SlidersHorizontal />
          {customised ? <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary-ink" /> : null}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] font-semibold">Chat settings</p>
        <Field label="System prompt" htmlFor="chat-system-prompt" help="Sent first with every message in this chat.">
          <Textarea
            id="chat-system-prompt"
            rows={4}
            value={draft.systemPrompt}
            maxLength={20_000}
            placeholder="You are a helpful assistant…"
            onChange={(e) => edit('systemPrompt', e.target.value)}
            onBlur={commit}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Temperature" htmlFor="chat-temperature">
            <Input
              id="chat-temperature"
              type="number"
              inputMode="decimal"
              min={0}
              max={2}
              step={0.1}
              placeholder="Default"
              value={draft.temperature}
              disabled={auto || noTemperature}
              onChange={(e) => edit('temperature', e.target.value)}
              onBlur={commit}
              onKeyDown={commitOnEnter}
            />
          </Field>
          <Field label="Max tokens" htmlFor="chat-max-tokens">
            <Input
              id="chat-max-tokens"
              type="number"
              inputMode="numeric"
              min={16}
              step={256}
              value={draft.maxTokens}
              disabled={auto}
              onChange={(e) => edit('maxTokens', e.target.value)}
              onBlur={commit}
              onKeyDown={commitOnEnter}
            />
          </Field>
        </div>
        {auto ? (
          <p className="text-2xs text-muted-foreground">GMI Router ignores temperature and max tokens; it only sees the conversation.</p>
        ) : noTemperature ? (
          <p className="text-2xs text-muted-foreground">This model runs on the Responses API, which does not take a temperature.</p>
        ) : null}
      </div>
    </Popover>
  );
}
