import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

interface SlotState {
  node: HTMLElement | null;
  setNode: (node: HTMLElement | null) => void;
}

const useSlot = create<SlotState>((set) => ({ node: null, setNode: (node) => set({ node }) }));

/** Placed once inside the TopBar. */
export function TopBarSlotTarget({ className }: { className?: string }) {
  const setNode = useSlot((s) => s.setNode);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setNode(el);
    return () => setNode(null);
  }, [el, setNode]);
  return <div ref={setEl} className={className} />;
}

/** Pages render their top-bar actions through this (e.g. "Refresh", "New chat"). */
export function TopBarActions({ children }: { children: ReactNode }) {
  const node = useSlot((s) => s.node);
  return node ? createPortal(children, node) : null;
}
