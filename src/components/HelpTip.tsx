import React, { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  label: string;
  text: string;
}

export function HelpTip({ label, text }: HelpTipProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tipId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);

  const open = pinned || hoverOpen || focusOpen;

  useEffect(() => {
    if (!pinned) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinned(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setHoverOpen(false);
        setFocusOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pinned]);

  return (
    <span
      ref={rootRef}
      className="relative inline-flex items-center align-middle"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
    >
      <button
        type="button"
        aria-label={`Ayuda sobre ${label}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setHoverOpen(false);
            setFocusOpen(false);
          } else {
            setPinned(true);
          }
        }}
        onFocus={() => setFocusOpen(true)}
        onBlur={() => setFocusOpen(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-slate-400 hover:text-blue-500 dark:text-slate-400 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 transition-colors"
      >
        <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={tipId}
          role="tooltip"
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-40 w-64 p-2.5 text-[11px] font-normal leading-relaxed text-slate-100 bg-slate-900 dark:bg-slate-800 border border-slate-700 rounded-md shadow-lg pointer-events-none"
        >
          {text}
        </span>
      )}
    </span>
  );
}
