import React, { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  actionText?: string;
  onAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  actionText,
  onAction,
}) => {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center max-w-md mx-auto">
      <div className="w-14 h-14 rounded-md bg-slate-800/80 border border-slate-700/80 flex items-center justify-center text-slate-400 mb-4 shadow-inner">
        {icon || <Inbox className="w-6 h-6 text-slate-400" />}
      </div>
      <h3 className="text-base font-semibold text-slate-200 mb-1">{title}</h3>
      <p className="text-xs text-slate-400 mb-6 leading-relaxed">{description}</p>
      {actionText && onAction && (
        <button
          onClick={onAction}
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition shadow-cyan-500/20 active:scale-95"
        >
          {actionText}
        </button>
      )}
    </div>
  );
};
