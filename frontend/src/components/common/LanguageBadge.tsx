import React from 'react';

/**
 * Display name for a trace-reported runtime language (telemetry.sdk.language).
 * Raw values not in the map still render (capitalized), so an unknown runtime
 * degrades to readable text instead of being dropped.
 */
export const languageLabel = (language: string): string => {
  const raw = language.trim().toLowerCase();
  if (!raw) return '';
  const known: Record<string, string> = {
    go: 'Go',
    java: 'Java',
    nodejs: 'Node.js',
    javascript: 'JavaScript',
    python: 'Python',
    cpp: 'C++',
    csharp: 'C#',
    dotnet: '.NET',
    rust: 'Rust',
    ruby: 'Ruby',
    php: 'PHP',
    jvm: 'JVM',
  };
  return known[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
};

export const LanguageBadge: React.FC<{ language: string }> = ({ language }) => {
  const label = languageLabel(language);
  if (!label) return null;
  return (
    <span
      title={`Runtime language reported by the service's traces: ${language}`}
      className="inline-flex items-center px-1.5 py-px rounded bg-slate-800 border border-slate-700 text-[10px] leading-4 text-slate-300 whitespace-nowrap"
    >
      {label}
    </span>
  );
};
