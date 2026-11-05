import React from 'react';

/**
 * Shown on the right while there is no review yet: three fanned pages (the review has three pages), a magnifier
 * on a highlighted clause, and a "+" badge that says "add something". Pure SVG, no dependencies, decorative
 * (the caption carries the meaning). While a file is being reviewed the lines gently pulse.
 */
export const EmptyReviewState: React.FC<{ busy?: boolean }> = ({ busy = false }) => {
  const pulse = busy ? 'animate-pulse' : '';
  return (
    <div className="flex w-full max-w-md flex-col items-center px-6 text-center" data-testid="empty-review-state">
      <svg viewBox="0 0 480 340" className="h-auto w-full max-w-[26rem]" aria-hidden="true" focusable="false">
        {/* soft backdrop */}
        <ellipse cx="240" cy="176" rx="205" ry="140" fill="#EFF6FF" />
        <ellipse cx="240" cy="318" rx="120" ry="9" fill="#E5E7EB" opacity="0.7" />

        {/* left page */}
        <g transform="rotate(-9 150 190)">
          <rect x="82" y="60" width="150" height="205" rx="12" fill="#FFFFFF" stroke="#E5E7EB" strokeWidth="2" />
          <g className={pulse}>
            <rect x="100" y="84" width="70" height="8" rx="4" fill="#D1D5DB" />
            <rect x="100" y="106" width="114" height="6" rx="3" fill="#E5E7EB" />
            <rect x="100" y="122" width="104" height="6" rx="3" fill="#E5E7EB" />
            <rect x="100" y="138" width="110" height="6" rx="3" fill="#E5E7EB" />
            <rect x="100" y="164" width="114" height="6" rx="3" fill="#E5E7EB" />
          </g>
        </g>

        {/* right page */}
        <g transform="rotate(9 330 190)">
          <rect x="248" y="60" width="150" height="205" rx="12" fill="#FFFFFF" stroke="#E5E7EB" strokeWidth="2" />
          <g className={pulse}>
            <rect x="266" y="84" width="60" height="8" rx="4" fill="#D1D5DB" />
            <rect x="266" y="112" width="12" height="12" rx="3" fill="none" stroke="#CBD5E1" strokeWidth="2" />
            <rect x="286" y="115" width="94" height="6" rx="3" fill="#E5E7EB" />
            <rect x="266" y="138" width="12" height="12" rx="3" fill="none" stroke="#CBD5E1" strokeWidth="2" />
            <rect x="286" y="141" width="84" height="6" rx="3" fill="#E5E7EB" />
            <rect x="266" y="164" width="12" height="12" rx="3" fill="none" stroke="#CBD5E1" strokeWidth="2" />
            <rect x="286" y="167" width="90" height="6" rx="3" fill="#E5E7EB" />
          </g>
        </g>

        {/* front page */}
        <g className="float-soft">
          <rect x="165" y="42" width="150" height="214" rx="12" fill="#FFFFFF" stroke="#CBD5E1" strokeWidth="2" />
          <rect x="165" y="42" width="150" height="30" rx="12" fill="#F8FAFC" />
          <rect x="183" y="55" width="76" height="8" rx="4" fill="#94A3B8" />
          <g className={pulse}>
            <rect x="183" y="90" width="114" height="6" rx="3" fill="#E5E7EB" />
            <rect x="183" y="106" width="100" height="6" rx="3" fill="#E5E7EB" />
            {/* the clause worth a closer look */}
            <rect x="178" y="126" width="124" height="22" rx="5" fill="#FEF3C7" />
            <rect x="183" y="134" width="112" height="6" rx="3" fill="#FCD34D" />
            <rect x="183" y="162" width="108" height="6" rx="3" fill="#E5E7EB" />
            <rect x="183" y="178" width="114" height="6" rx="3" fill="#E5E7EB" />
            <rect x="183" y="194" width="84" height="6" rx="3" fill="#E5E7EB" />
          </g>
        </g>

        {/* magnifier on the highlighted clause */}
        <g className="float-soft-late">
          <circle cx="286" cy="150" r="26" fill="#FFFFFF" fillOpacity="0.55" stroke="#2563EB" strokeWidth="5" />
          <line x1="305" y1="170" x2="326" y2="192" stroke="#2563EB" strokeWidth="7" strokeLinecap="round" />
          <path d="M274 150 l8 8 14-16" fill="none" stroke="#2563EB" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>

        {/* "add something" badge */}
        <g>
          <circle cx="352" cy="262" r="24" fill="#2563EB" />
          <path d="M352 251 v22 M341 262 h22" stroke="#FFFFFF" strokeWidth="4.5" strokeLinecap="round" />
        </g>

        {/* sparkles */}
        <path d="M96 78 v14 M89 85 h14" stroke="#93C5FD" strokeWidth="3" strokeLinecap="round" />
        <path d="M402 104 v10 M397 109 h10" stroke="#93C5FD" strokeWidth="3" strokeLinecap="round" />
        <circle cx="118" cy="272" r="4" fill="#BFDBFE" />
        <circle cx="392" cy="48" r="3.5" fill="#BFDBFE" />
      </svg>

      <p className="mt-7 text-lg font-semibold tracking-tight text-gray-900" role="status">
        {busy ? 'Reading your agreement…' : 'Your review will appear here'}
      </p>
      <p className="mt-1.5 max-w-[19rem] text-sm leading-relaxed text-gray-500">
        {busy ? 'This usually takes a few moments.' : 'Add your contract on the left to see what to know before you sign.'}
      </p>
    </div>
  );
};
