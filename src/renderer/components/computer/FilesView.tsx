// The Files tab (compute.md §8.3): the tree on top, the selected file under it, transfers at the bottom.
import type { ComputerSessionInfo } from '@shared/contracts/compute';
import { FilePreview } from './FilePreview';
import { FileTree } from './FileTree';
import { normalizeRemotePath } from './paths';
import { useComputerUi, useStoreNow } from './store';
import { TransferList } from './TransferList';

export function FilesView({ session }: { session: ComputerSessionInfo }) {
  const sessionId = session.sessionId;
  const selected = useStoreNow(useComputerUi, (s) => s.selected[sessionId] ?? null);
  const select = useComputerUi((s) => s.select);
  const root = (session.home && normalizeRemotePath(session.home)) || '/';
  const file = selected?.type === 'file' ? selected.path : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={file ? 'flex min-h-0 basis-2/5 flex-col' : 'flex min-h-0 flex-1 flex-col'}>
        <FileTree sessionId={sessionId} root={root} home={session.home} />
      </div>
      {file ? <FilePreview key={file} sessionId={sessionId} path={file} onClose={() => select(sessionId, null)} /> : null}
      <TransferList sessionId={sessionId} />
    </div>
  );
}
