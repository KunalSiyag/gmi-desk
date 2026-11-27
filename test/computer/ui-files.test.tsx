// C2-D: the Files and Ports tabs (compute.md §8.3, §8.4): client-side path rules (T8/T9 first line of defence), tree
// ordering, what the preview may do with a file, transfers, port merging and the service form.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_WRITE_MAX_BYTES, type TransferInfo } from '@shared/contracts/compute';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import { FilePreview, fileMode, saveProblem } from '@renderer/components/computer/FilePreview';
import { sortEntries } from '@renderer/components/computer/FileTree';
import { baseName, displayPath, entryNameError, isWithin, joinRemote, normalizeRemotePath, parentOf } from '@renderer/components/computer/paths';
import { mergePorts, serviceProblem } from '@renderer/components/computer/PortsView';
import { computerKeys } from '@renderer/components/computer/session';
import { TRANSFERS_KEPT, useComputerUi } from '@renderer/components/computer/store';
import { TransferList, transferProgress, transferStatus } from '@renderer/components/computer/TransferList';
import { expectDesignRules, installBridge, PORTS, removeBridge, render, ROOT_LISTING, text } from './ui-fixtures';

beforeEach(() => void installBridge());
afterEach(() => {
  removeBridge();
  useComputerUi.setState({ transfers: [], selected: {}, expanded: {} });
});

describe('remote paths', () => {
  it('normalises absolute paths and refuses relative, NUL, ".." and over-long ones', () => {
    expect(normalizeRemotePath('/root//app/./src/')).toBe('/root/app/src');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('///')).toBe('/');
    expect(normalizeRemotePath('root/app')).toBeNull();
    expect(normalizeRemotePath('')).toBeNull();
    expect(normalizeRemotePath('/root/../etc/passwd')).toBeNull();
    expect(normalizeRemotePath('/root/..')).toBeNull();
    expect(normalizeRemotePath('/root/a\0b')).toBeNull();
    expect(normalizeRemotePath(`/${'a'.repeat(4095)}`)).toHaveLength(4096);
    expect(normalizeRemotePath(`/${'a'.repeat(4096)}`)).toBeNull();
    expect(normalizeRemotePath(`/${'é'.repeat(2048)}`)).toBeNull(); // 4,097 bytes
  });

  it('names: no separators, dot names, controls, edge spaces or > 255 bytes', () => {
    expect(entryNameError('main.py')).toBeNull();
    expect(entryNameError('.env.local')).toBeNull();
    expect(entryNameError('')).toMatch(/Enter a name/);
    expect(entryNameError('a/b')).toMatch(/“\/”/);
    expect(entryNameError('..')).toMatch(/reserved/);
    expect(entryNameError('.')).toMatch(/reserved/);
    expect(entryNameError('evil\nname')).toMatch(/control/);
    expect(entryNameError('a\u0000')).toMatch(/control/);
    expect(entryNameError(' x')).toMatch(/space/);
    expect(entryNameError('x'.repeat(256))).toMatch(/255/);
  });

  it('join, parent, base name, ~ display, containment', () => {
    expect(joinRemote('/root/app', 'main.py')).toBe('/root/app/main.py');
    expect(joinRemote('/', 'tmp')).toBe('/tmp');
    expect(joinRemote('/root', '../etc')).toBeNull();
    expect(joinRemote('relative', 'x')).toBeNull();
    expect(parentOf('/root/app/main.py')).toBe('/root/app');
    expect(parentOf('/root')).toBe('/');
    expect(parentOf('/')).toBe('/');
    expect(baseName('/root/app/main.py')).toBe('main.py');
    expect(baseName('/')).toBe('/');
    expect(displayPath('/root/app', '/root')).toBe('~/app');
    expect(displayPath('/root', '/root')).toBe('~');
    expect(displayPath('/rootkit', '/root')).toBe('/rootkit');
    expect(displayPath('/etc', null)).toBe('/etc');
    expect(isWithin('/root/app/x', '/root/app')).toBe(true);
    expect(isWithin('/root/apple', '/root/app')).toBe(false);
    expect(isWithin('/anything', '/')).toBe(true);
  });
});

describe('tree order', () => {
  it('folders first, then names case-insensitively with numbers in order', () => {
    const names = sortEntries([
      ...ROOT_LISTING.entries,
      { name: 'file10', path: '/root/file10', type: 'file', size: 1, mtime: null, mode: null },
      { name: 'File2', path: '/root/File2', type: 'file', size: 1, mtime: null, mode: null },
      { name: 'link', path: '/root/link', type: 'symlink', size: null, mtime: null, mode: null },
    ]).map((e) => e.name);
    expect(names).toEqual(['app', 'data', '.bashrc', 'File2', 'file10', 'link', 'notes.txt']);
  });
});

describe('file preview', () => {
  it('what the preview may do: edit small text, read large or truncated text, download binaries', () => {
    expect(fileMode({ text: 'x', binary: false, truncated: false, size: 1 })).toBe('edit');
    expect(fileMode({ text: 'x', binary: false, truncated: false, size: FILE_WRITE_MAX_BYTES + 1 })).toBe('read');
    expect(fileMode({ text: 'x', binary: false, truncated: true, size: 5_000_000 })).toBe('read');
    expect(fileMode({ text: null, binary: true, truncated: false, size: 10 })).toBe('binary');
    expect(fileMode({ text: null, binary: false, truncated: true, size: 10_000_000 })).toBe('binary');
  });

  it('a draft over 1 MiB cannot be saved from the editor', () => {
    expect(saveProblem('hello')).toBeNull();
    expect(saveProblem('x'.repeat(FILE_WRITE_MAX_BYTES + 1))).toMatch(/terminal/);
  });

  const seedFile = (file: { text: string | null; binary: boolean; truncated: boolean; size: number }) => ({
    extra: (c: import('@tanstack/react-query').QueryClient) => c.setQueryData(computerKeys.file('cs_1', '/root/notes.txt'), { path: '/root/notes.txt', ...file }),
  });

  it('an editable text file: mono textarea, Save (disabled until edited), Download, Close', () => {
    const html = render(<FilePreview sessionId="cs_1" path="/root/notes.txt" onClose={() => {}} />, seedFile({ text: 'hello\nworld', binary: false, truncated: false, size: 11 }));
    expect(html).toMatch(/<textarea[^>]*aria-label="Contents of notes.txt"/);
    expect(html).not.toMatch(/<textarea[^>]*readOnly/i);
    expect(html).toContain('hello\nworld');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Save/);
    expect(html).toContain('aria-label="Download file"');
    expectDesignRules(html, { dino: false });
  });

  it('a truncated file is read-only and says so', () => {
    const html = render(<FilePreview sessionId="cs_1" path="/root/notes.txt" onClose={() => {}} />, seedFile({ text: 'big', binary: false, truncated: true, size: 9_000_000 }));
    expect(html).toMatch(/<textarea[^>]*readOnly/i);
    expect(text(html)).toContain('Showing the first 2.1 MB, read-only.');
    expect(text(html)).not.toContain('Save');
  });

  it('a binary file offers the download only', () => {
    const html = render(<FilePreview sessionId="cs_1" path="/root/notes.txt" onClose={() => {}} />, seedFile({ text: null, binary: true, truncated: false, size: 300 }));
    expect(html).not.toContain('<textarea');
    expect(text(html)).toContain('Binary file');
  });
});

describe('transfers', () => {
  const t = (patch: Partial<TransferInfo> = {}): TransferInfo => ({
    transferId: 't1',
    sessionId: 'cs_1',
    direction: 'upload',
    name: 'data.csv',
    remotePath: '/root/data.csv',
    bytes: 1_500_000,
    totalBytes: 4_000_000,
    state: 'running',
    error: null,
    ...patch,
  });

  it('progress and status text', () => {
    expect(transferProgress(t())).toBeCloseTo(0.375);
    expect(transferProgress(t({ totalBytes: null }))).toBeNull();
    expect(transferProgress(t({ state: 'done' }))).toBe(1);
    expect(transferStatus(t())).toBe('1.5 MB of 4.0 MB');
    expect(transferStatus(t({ state: 'done', bytes: 4_000_000 }))).toBe('Done · 4.0 MB');
    expect(transferStatus(t({ state: 'queued' }))).toBe('Waiting');
    expect(transferStatus(t({ state: 'failed', error: { code: 'invalid_input', message: 'File is larger than 500 MB.' } }))).toBe('Failed: File is larger than 500 MB.');
  });

  it('events upsert by id; only the most recent finished ones are kept, active ones always', () => {
    const ui = useComputerUi.getState();
    ui.upsertTransfer(t({ transferId: 'active', state: 'running' }));
    for (let i = 0; i < TRANSFERS_KEPT + 5; i++) ui.upsertTransfer(t({ transferId: `d${i}`, state: 'done' }));
    ui.upsertTransfer(t({ transferId: 'active', bytes: 2_000_000 }));
    const list = useComputerUi.getState().transfers;
    expect(list.filter((x) => x.state === 'done')).toHaveLength(TRANSFERS_KEPT);
    expect(list.find((x) => x.transferId === 'active')?.bytes).toBe(2_000_000);
    expect(list.some((x) => x.transferId === 'd0')).toBe(false);
    useComputerUi.getState().clearFinishedTransfers('cs_1');
    expect(useComputerUi.getState().transfers.map((x) => x.transferId)).toEqual(['active']);
  });

  it('the list shows names (never local paths), progress, cancel for active rows', () => {
    useComputerUi.setState({ transfers: [t(), t({ transferId: 't2', direction: 'download', name: 'model.bin', state: 'done' }), t({ transferId: 'x', sessionId: 'other' })] });
    const html = render(<TransferList sessionId="cs_1" />);
    expect(text(html)).toContain('data.csv');
    expect(text(html)).toContain('model.bin');
    expect(html.match(/data-transfer=/g)).toHaveLength(2);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="38"/);
    expect(html).toContain('aria-label="Cancel data.csv"');
    expect(html).not.toContain('aria-label="Cancel model.bin"');
    expect(text(html)).toContain('Clear finished');
    expect(render(<TransferList sessionId="nobody" />)).toBe('');
  });
});

describe('ports and services', () => {
  it('merges IPv4/IPv6 listeners of one port (previewable wins), lowest port first', () => {
    expect(mergePorts(PORTS)).toEqual([
      { port: 5432, address: '127.0.0.1', process: 'postgres', previewable: false },
      { port: 8000, address: '0.0.0.0', process: 'python3', previewable: true },
    ]);
    expect(mergePorts([{ port: 3000, address: '127.0.0.1', process: 'node', previewable: false }, { port: 3000, address: '::', process: null, previewable: true }])).toEqual([
      { port: 3000, address: '::', process: 'node', previewable: true },
    ]);
  });

  it('service form rules', () => {
    expect(serviceProblem({ name: 'web', command: 'npm run dev', port: '5173' })).toBeNull();
    expect(serviceProblem({ name: 'web', command: 'npm run dev', port: '' })).toBeNull();
    expect(serviceProblem({ name: 'my app', command: 'x', port: '' })).toMatch(/Name/);
    expect(serviceProblem({ name: '../x', command: 'x', port: '' })).toMatch(/Name/);
    expect(serviceProblem({ name: 'web', command: '  ', port: '' })).toMatch(/command/);
    expect(serviceProblem({ name: 'web', command: 'x', port: '70000' })).toMatch(/Port/);
    expect(serviceProblem({ name: 'web', command: 'x', port: '80.5' })).toMatch(/Port/);
  });
});
