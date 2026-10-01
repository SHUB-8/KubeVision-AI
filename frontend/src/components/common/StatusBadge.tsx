import React from 'react';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'md' }) => {
  const normalized = (status || '').toLowerCase();

  let style = 'bg-slate-800 text-slate-400 border-slate-700';
  let dotStyle = 'bg-slate-500';

  if (normalized === 'running' || normalized === 'ready' || normalized === 'ok' || normalized === 'status_code_ok') {
    style = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
    dotStyle = 'bg-emerald-400';
  } else if (normalized.includes('warn') || normalized === 'pending') {
    style = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
    dotStyle = 'bg-amber-400';
  } else if (normalized.includes('err') || normalized === 'failed' || normalized === 'crashloopbackoff') {
    style = 'bg-rose-500/10 text-rose-400 border-rose-500/30';
    dotStyle = 'bg-rose-400';
  }

  const px = size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium border font-mono tracking-tight ${px} ${style}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotStyle}`} />
      <span>{status || 'Unknown'}</span>
    </span>
  );
};
