/**
 * Icon set.
 *
 * BeOS icons were 32x32, saturated, and lit from the top-left with a hard 1px
 * outline. These are original SVGs drawn in that spirit -- deliberately not
 * traced from Be Inc. artwork. They scale cleanly because everything is on a
 * 32-unit grid.
 */

export interface IconProps {
  size?: number
  className?: string
}

const box = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 32 32',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true as const,
})

export function FolderIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path d="M2 8h10l3 3h15v17H2z" fill="#8fa4c8" stroke="#2f3d57" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2 12h28v16H2z" fill="#b3c3de" stroke="#2f3d57" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4 14h24" stroke="#dce4f1" strokeWidth="1.5" />
    </svg>
  )
}

export function TextFileIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path d="M6 3h14l6 6v20H6z" fill="#fdfdfd" stroke="#3b3b3b" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 3v6h6" fill="#d8d8d8" stroke="#3b3b3b" strokeWidth="1.5" strokeLinejoin="round" />
      <g stroke="#7b8ea8" strokeWidth="1.5">
        <path d="M10 14h12M10 18h12M10 22h8" />
      </g>
    </svg>
  )
}

export function AppIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="4" y="4" width="24" height="24" rx="3" fill="#63b06b" stroke="#204a26" strokeWidth="1.5" />
      <path d="M4 12h24" stroke="#204a26" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.6" fill="#e9f7ea" />
      <path d="M11 18l5 5 8-10" fill="none" stroke="#e9f7ea" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function TerminalIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="5" width="26" height="22" rx="2" fill="#1b1b1b" stroke="#000" strokeWidth="1.5" />
      <rect x="3" y="5" width="26" height="4" fill="#ffc900" stroke="#000" strokeWidth="1.5" />
      <path d="M7 15l4 3-4 3" fill="none" stroke="#5ee06a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 21h8" stroke="#5ee06a" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function TrackerIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path d="M2 8h10l3 3h15v17H2z" fill="#8fa4c8" stroke="#2f3d57" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2 12h28v16H2z" fill="#b3c3de" stroke="#2f3d57" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="19" cy="19" r="5" fill="#fff8d6" stroke="#2f3d57" strokeWidth="1.5" />
      <path d="M23 23l5 5" stroke="#2f3d57" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export function StyledEditIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path d="M6 3h14l6 6v20H6z" fill="#fdfdfd" stroke="#3b3b3b" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 3v6h6" fill="#d8d8d8" stroke="#3b3b3b" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 15h9M10 19h6" stroke="#7b8ea8" strokeWidth="1.5" />
      <path d="M25 15l4 4-8 8-4 1 1-4z" fill="#ffc900" stroke="#3b3b3b" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

export function DiskIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="9" width="26" height="15" rx="2.5" fill="#c9ced6" stroke="#3a4049" strokeWidth="1.5" />
      <rect x="3" y="9" width="26" height="7" rx="2.5" fill="#e6eaf0" stroke="#3a4049" strokeWidth="1.5" />
      <circle cx="24" cy="20" r="2" fill="#63b06b" stroke="#3a4049" strokeWidth="1.2" />
      <path d="M7 20h11" stroke="#8d96a3" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function TrashIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path d="M8 10h16l-2 18H10z" fill="#b8bec7" stroke="#3a4049" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="6" y="6" width="20" height="4" rx="1.5" fill="#d6dae1" stroke="#3a4049" strokeWidth="1.5" />
      <path d="M13 3h6v3h-6z" fill="#d6dae1" stroke="#3a4049" strokeWidth="1.5" strokeLinejoin="round" />
      <g stroke="#7d848e" strokeWidth="1.5">
        <path d="M13 14v10M16 14v10M19 14v10" />
      </g>
    </svg>
  )
}

/** Stylised leaf for the Deskbar. An homage mark, not the Be Inc. logo. */
export function LeafIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path
        d="M27 4C13 4 5 11 5 21c0 3 1 5 2 7 2-9 8-14 16-16-6 4-10 8-12 16 10 1 18-6 18-17 0-3-1-5-2-7z"
        fill="#2f3d57"
      />
    </svg>
  )
}

export function AboutIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <circle cx="16" cy="16" r="13" fill="#ffc900" stroke="#8a6c00" strokeWidth="1.5" />
      <path d="M16 14v9" stroke="#3b2f00" strokeWidth="3" strokeLinecap="round" />
      <circle cx="16" cy="9.5" r="1.9" fill="#3b2f00" />
    </svg>
  )
}

export function AlertIcon({ kind, size = 32 }: { kind: 'info' | 'warn' | 'stop'; size?: number }) {
  const fill = kind === 'stop' ? '#cc3333' : kind === 'warn' ? '#e8a020' : '#3366cc'
  return (
    <svg {...box(size)}>
      <circle cx="16" cy="16" r="13" fill={fill} stroke="rgba(0,0,0,.45)" strokeWidth="1.5" />
      {kind === 'info' ? (
        <>
          <circle cx="16" cy="9.5" r="2" fill="#fff" />
          <path d="M16 14v9" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M16 8v10" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
          <circle cx="16" cy="23" r="2.1" fill="#fff" />
        </>
      )}
    </svg>
  )
}

export function TetrisIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="4" width="26" height="24" rx="2" fill="#1d1d1d" stroke="#000" strokeWidth="1.5" />
      {/* An S-piece and an O-piece, in the same palette the board uses. */}
      <g stroke="rgba(0,0,0,.45)" strokeWidth="1">
        <rect x="13" y="8" width="7" height="7" fill="#5fa951" />
        <rect x="20" y="8" width="7" height="7" fill="#5fa951" />
        <rect x="6" y="15" width="7" height="7" fill="#9b5fb8" />
        <rect x="13" y="15" width="7" height="7" fill="#5fa951" />
        <rect x="6" y="22" width="7" height="4" fill="#4b74c4" />
        <rect x="13" y="22" width="7" height="4" fill="#e5b53a" />
        <rect x="20" y="22" width="7" height="4" fill="#cf5046" />
      </g>
    </svg>
  )
}

/** A tiled floor with a bean on it and a key beside it -- the game in one square. */
export function BeanChallengeIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="4" width="26" height="24" rx="2" fill="#5d6d80" stroke="#232a34" strokeWidth="1.5" />
      <g fill="#546375">
        <rect x="3.8" y="4.8" width="8" height="7.5" />
        <rect x="20" y="4.8" width="8" height="7.5" />
        <rect x="11.8" y="12.3" width="8.2" height="7.5" />
        <rect x="3.8" y="19.8" width="8" height="7.4" />
        <rect x="20" y="19.8" width="8" height="7.4" />
      </g>
      {/* The same kidney bean the board draws, at icon scale. */}
      <path
        d="M11 9.5 20 8.5l3.5 4.5-2 7-6 2-5-3.5z"
        fill="#8fbf4a"
        stroke="#3f6b12"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M13.5 11.5 18 11l1.5 2.2-3 .6z" fill="#d4f090" />
      <g stroke="#8a2b24" strokeWidth="1.2">
        <circle cx="9" cy="22" r="3" fill="#d8453c" />
        <path d="M11.5 23.5h7v2h-7z" fill="#d8453c" />
      </g>
      <circle cx="9" cy="22" r="1" fill="#3a2020" />
    </svg>
  )
}

/** Anthropic-flavoured burst mark, drawn fresh on the 32-unit grid. */
export function ClaudeIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="4" width="26" height="24" rx="2" fill="#d97757" stroke="#7a3a24" strokeWidth="1.5" />
      <g stroke="#fdf6f2" strokeWidth="2.4" strokeLinecap="round">
        <path d="M16 9v14M10 12l12 8M22 12l-12 8" />
      </g>
    </svg>
  )
}

/** A listing on a screen: line numbers down the left, code to the right. */
export function BasicIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="5" width="26" height="22" rx="2" fill="#f4f2e8" stroke="#3b3b3b" strokeWidth="1.5" />
      <rect x="3" y="5" width="7" height="22" fill="#dcd8c4" stroke="#3b3b3b" strokeWidth="1.5" />
      <g stroke="#6a6a6a" strokeWidth="1.4" strokeLinecap="round">
        <path d="M5.5 10h3M5.5 15h3M5.5 20h3" />
      </g>
      <g stroke="#2f6ea8" strokeWidth="1.8" strokeLinecap="round">
        <path d="M13 10h12M13 15h8M13 20h10" />
      </g>
    </svg>
  )
}

/** A CRT showing a picture: the BASIC program's own screen, not its listing. */
export function ScreenIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="2" y="4" width="28" height="20" rx="2" fill="#3b3b3b" />
      <rect x="4.5" y="6.5" width="23" height="15" fill="#101a3c" />
      <path d="M4.5 21.5 11 13l4.5 5 4-4.5 8 8Z" fill="#2f6ea8" />
      <circle cx="22" cy="10.5" r="2.5" fill="#ffc900" />
      <path d="M12 24h8l1 3.5H11Z" fill="#8f8f8f" />
      <rect x="8" y="27" width="16" height="2" rx="1" fill="#6a6a6a" />
    </svg>
  )
}

/** A control plate with two sliders -- R5 kept its settings on panels like this. */
export function PrefsIcon({ size = 32, className }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="3" y="4" width="26" height="24" rx="2" fill="#c9ced6" stroke="#3a4049" strokeWidth="1.5" />
      <path d="M3 10h26" stroke="#3a4049" strokeWidth="1.5" />
      <path d="M4.5 5.5h9v3h-9z" fill="#ffc900" stroke="#8a6c00" strokeWidth="1.2" />
      <g stroke="#8d96a3" strokeWidth="1.5" strokeLinecap="round">
        <path d="M7 16h18M7 23h18" />
      </g>
      <rect x="10" y="13" width="4.5" height="6" rx="1" fill="#e6eaf0" stroke="#3a4049" strokeWidth="1.3" />
      <rect x="18" y="20" width="4.5" height="6" rx="1" fill="#e6eaf0" stroke="#3a4049" strokeWidth="1.3" />
    </svg>
  )
}
