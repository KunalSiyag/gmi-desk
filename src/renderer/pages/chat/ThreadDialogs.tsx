import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Spinner } from '@renderer/components/ui/misc';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';

export interface ThreadRef {
  id: string;
  title: string;
  messageCount: number;
}

export function RenameThreadDialog({ thread, onClose }: { thread: ThreadRef | null; onClose: () => void }) {
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (thread) setValue(thread.title);
  }, [thread]);

  const save = async () => {
    if (!thread) return;
    const title = value.trim();
    if (!title || title === thread.title) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const next = await gmi.chat.updateThread(thread.id, { title });
      client.setQueryData(qk.thread(thread.id), next);
      onClose();
    } catch (error) {
      toast.error('Could not rename the chat', { description: describeError(error).message || undefined });
    } finally {
      setBusy(false);
    }
  };

  const changed = value.trim() !== '' && value.trim() !== thread?.title;

  return (
    <Dialog
      open={thread !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Rename chat"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {/* Lime only when Save would change something; otherwise it just closes. */}
          <Button variant={changed ? 'default' : 'outline'} onClick={() => void save()} disabled={busy || !value.trim()}>
            {busy ? <Spinner className={changed ? 'text-primary-foreground' : undefined} /> : null}
            Save
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        aria-label="Chat title"
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
      />
    </Dialog>
  );
}

export function DeleteThreadDialog({ thread, onClose }: { thread: ThreadRef | null; onClose: () => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!thread) return;
    setBusy(true);
    try {
      await gmi.chat.deleteThread(thread.id);
      client.removeQueries({ queryKey: qk.thread(thread.id) });
      onClose();
    } catch (error) {
      toast.error('Could not delete the chat', { description: describeError(error).message || undefined });
    } finally {
      setBusy(false);
    }
  };

  const count = thread?.messageCount ?? 0;
  return (
    <Dialog
      open={thread !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Delete this chat?"
      description={
        thread
          ? `“${thread.title}”${count ? ` and its ${count} message${count === 1 ? '' : 's'}` : ''} will be removed from this device. This cannot be undone.`
          : undefined
      }
      footer={
        <>
          {/* Focus starts on Cancel: the Enter that opened this dialog (palette, menu) or a held key must not delete. */}
          <Button variant="ghost" autoFocus onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Spinner className="text-white" /> : null}
            Delete
          </Button>
        </>
      }
    />
  );
}
