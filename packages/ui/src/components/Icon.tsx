/**
 * JIVA icon set: one 24px grid, one stroke weight, round joins. Drawn for this product so every
 * icon shares the same visual language (no third-party icon font).
 */
type Shape =
  | readonly ['path', string]
  | readonly ['fill', string]
  | readonly ['circle', number, number, number]
  | readonly ['dot', number, number, number]
  | readonly ['rect', number, number, number, number, number];

const ICONS = {
  hospital: [
    ['path', 'M4 21V8a2 2 0 0 1 2-2h3V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2h3a2 2 0 0 1 2 2v13'],
    ['path', 'M2.5 21h19'],
    ['path', 'M12 9.5v5M9.5 12h5'],
    ['path', 'M10 21v-3h4v3'],
  ],
  cross: [['path', 'M12 6.5v11M6.5 12h11']],
  ambulance: [
    ['path', 'M3 17V7.5A1.5 1.5 0 0 1 4.5 6H14v11'],
    ['path', 'M14 9.5h3.6l3.4 3.6V17'],
    ['path', 'M3 17h2M9 17h6M19 17h2'],
    ['circle', 7, 17, 2],
    ['circle', 17, 17, 2],
    ['path', 'M8.5 8.8v4.4M6.3 11h4.4'],
  ],
  siren: [
    ['path', 'M6.5 18v-5.5a5.5 5.5 0 0 1 11 0V18'],
    ['path', 'M4.5 18h15v2.5h-15z'],
    ['path', 'M12 3v2M4.6 6.1l1.4 1.4M19.4 6.1l-1.4 1.4'],
  ],
  check: [['path', 'M5 12.5l4.5 4.5L19 7.5']],
  checkCircle: [['circle', 12, 12, 9], ['path', 'M8.2 12.3l2.6 2.6 5-5.2']],
  x: [['path', 'M6.5 6.5l11 11M17.5 6.5l-11 11']],
  xCircle: [['circle', 12, 12, 9], ['path', 'M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6']],
  alertTriangle: [
    ['path', 'M10.3 4.3a2 2 0 0 1 3.4 0l7.6 13.2a2 2 0 0 1-1.7 3H4.4a2 2 0 0 1-1.7-3z'],
    ['path', 'M12 9.5v4'],
    ['path', 'M12 17h.01'],
  ],
  alertCircle: [['circle', 12, 12, 9], ['path', 'M12 7.5v5'], ['path', 'M12 16.2h.01']],
  help: [
    ['circle', 12, 12, 9],
    ['path', 'M9.4 9.2a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.3-2.6 3.9'],
    ['path', 'M12 17h.01'],
  ],
  clock: [['circle', 12, 12, 9], ['path', 'M12 7.5V12l3 1.8']],
  hourglass: [
    ['path', 'M7 3.5h10M7 20.5h10'],
    ['path', 'M8 3.5v2.8a4 4 0 0 0 1.4 3L12 12l-2.6 2.7A4 4 0 0 0 8 17.7v2.8'],
    ['path', 'M16 3.5v2.8a4 4 0 0 1-1.4 3L12 12l2.6 2.7a4 4 0 0 1 1.4 3v2.8'],
  ],
  ban: [['circle', 12, 12, 9], ['path', 'M5.7 5.7l12.6 12.6']],
  half: [['circle', 12, 12, 9], ['fill', 'M12 3a9 9 0 0 1 0 18z']],
  search: [['circle', 11, 11, 6.5], ['path', 'M20 20l-4.2-4.2']],
  filter: [['path', 'M4 6.5h16M7 12h10M10 17.5h4']],
  chevronRight: [['path', 'M9.5 6l6 6-6 6']],
  chevronLeft: [['path', 'M14.5 6l-6 6 6 6']],
  chevronDown: [['path', 'M6 9.5l6 6 6-6']],
  chevronUp: [['path', 'M6 14.5l6-6 6 6']],
  arrowRight: [['path', 'M4.5 12h15M13.5 6l6 6-6 6']],
  arrowDown: [['path', 'M12 4.5v15M6 13.5l6 6 6-6']],
  pin: [['path', 'M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z'], ['circle', 12, 10, 2.3]],
  route: [
    ['circle', 6, 18.5, 2],
    ['circle', 18, 5.5, 2],
    ['path', 'M8 18.5h7.5a3.25 3.25 0 0 0 0-6.5h-7a3.25 3.25 0 0 1 0-6.5H16'],
  ],
  crosshair: [['circle', 12, 12, 7], ['path', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3'], ['dot', 12, 12, 1.4]],
  maximize: [
    ['path', 'M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15'],
  ],
  layers: [['path', 'M12 3.5l9 5-9 5-9-5z'], ['path', 'M3 13l9 5 9-5']],
  activity: [['path', 'M3 12h4l2.5-6.5 5 13 2.5-6.5H21']],
  refresh: [
    ['path', 'M4.5 12a7.5 7.5 0 0 1 13.2-4.9L20 9.5'],
    ['path', 'M20 4.5v5h-5'],
    ['path', 'M19.5 12a7.5 7.5 0 0 1-13.2 4.9L4 14.5'],
    ['path', 'M4 19.5v-5h5'],
  ],
  info: [['circle', 12, 12, 9], ['path', 'M12 11v5.5'], ['path', 'M12 7.8h.01']],
  phone: [
    ['path', 'M6.6 3.5h2.6l1.4 4-2 1.4a11.5 11.5 0 0 0 6.5 6.5l1.4-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z'],
  ],
  user: [['circle', 12, 8, 3.75], ['path', 'M4.5 20.5a7.5 7.5 0 0 1 15 0']],
  users: [
    ['circle', 9, 8, 3.25],
    ['path', 'M2.75 20a6.25 6.25 0 0 1 12.5 0'],
    ['path', 'M15.5 4.9a3.25 3.25 0 0 1 0 6.2'],
    ['path', 'M17.8 14.1A6.25 6.25 0 0 1 21.25 20'],
  ],
  pill: [['path', 'M10.6 20.1a4.9 4.9 0 0 1-6.9-6.9l9.5-9.4a4.9 4.9 0 0 1 6.9 6.9z'], ['path', 'M8.4 8.6l6.9 6.9']],
  file: [
    ['path', 'M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10z'],
    ['path', 'M14 3.5v5h5'],
    ['path', 'M9 13h6M9 16.5h4'],
  ],
  calendar: [['rect', 3.5, 5, 17, 15.5, 2.5], ['path', 'M3.5 10h17M8 3v4M16 3v4']],
  heart: [['path', 'M12 20s-7.5-4.6-7.5-10.4A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z']],
  stethoscope: [['path', 'M6 3.5v5a4 4 0 0 0 8 0v-5'], ['path', 'M10 12.5v2a5 5 0 0 0 10 0V13'], ['circle', 20, 11, 2]],
  send: [['path', 'M20.5 3.5l-10 10'], ['path', 'M20.5 3.5l-6.5 17-3.5-7-7-3.5z']],
  code: [['path', 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5']],
  brief: [
    ['path', 'M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z'],
    ['path', 'M8 9.5h8M8 12.5h5'],
  ],
  eye: [['path', 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z'], ['circle', 12, 12, 2.75]],
  list: [['path', 'M9 6.5h11M9 12h11M9 17.5h11'], ['dot', 4.75, 6.5, 1.1], ['dot', 4.75, 12, 1.1], ['dot', 4.75, 17.5, 1.1]],
  navigation: [['path', 'M4 11.5l16.5-7.5-7.5 16.5-1.9-7.1z']],
  shield: [['path', 'M12 3l7.5 3v5.5c0 4.4-3.1 8.3-7.5 9.5-4.4-1.2-7.5-5.1-7.5-9.5V6z'], ['path', 'M9 12l2.1 2.1 4.1-4.2']],
  database: [
    ['path', 'M4.5 6c0-1.4 3.4-2.5 7.5-2.5s7.5 1.1 7.5 2.5-3.4 2.5-7.5 2.5S4.5 7.4 4.5 6z'],
    ['path', 'M4.5 6v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6'],
    ['path', 'M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5'],
  ],
  panel: [['rect', 3.5, 4.5, 17, 15, 2], ['path', 'M14.5 4.5v15']],
  building: [
    ['path', 'M3.5 20.5h17'],
    ['path', 'M5.5 20.5V6.5l6-3 6 3v14'],
    ['path', 'M9.5 9h1M13.5 9h1M9.5 12.5h1M13.5 12.5h1M10.5 20.5V17h3v3.5'],
  ],
  plus: [['path', 'M12 5v14M5 12h14']],
  minus: [['path', 'M5 12h14']],
  wifiOff: [['path', 'M3 3l18 18'], ['path', 'M8.5 15.9a5 5 0 0 1 7 0'], ['path', 'M5 12.5a10 10 0 0 1 4-2.4M14.8 10.3a10 10 0 0 1 4.2 2.2'], ['dot', 12, 19, 1.1]],
  map: [['path', 'M9 4.5l-5.5 2v13l5.5-2 6 2 5.5-2v-13l-5.5 2z'], ['path', 'M9 4.5v13M15 6.5v13']],
  gauge: [['path', 'M4.5 17a8 8 0 1 1 15 0'], ['path', 'M12 13l3.5-3.5'], ['dot', 12, 13, 1.3]],
  home: [['path', 'M4 10.5 12 4l8 6.5'], ['path', 'M6 9v10.5h12V9'], ['path', 'M10 19.5v-5.5h4v5.5']],
} satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** When set, the icon is announced to assistive technology; otherwise it is decorative. */
  title?: string;
}

function renderShape(shape: Shape, key: number) {
  switch (shape[0]) {
    case 'path':
      return <path key={key} d={shape[1]} />;
    case 'fill':
      return <path key={key} d={shape[1]} fill="currentColor" stroke="none" />;
    case 'circle':
      return <circle key={key} cx={shape[1]} cy={shape[2]} r={shape[3]} />;
    case 'dot':
      return <circle key={key} cx={shape[1]} cy={shape[2]} r={shape[3]} fill="currentColor" stroke="none" />;
    case 'rect':
      return <rect key={key} x={shape[1]} y={shape[2]} width={shape[3]} height={shape[4]} rx={shape[5]} />;
  }
}

export function Icon({ name, size = 16, strokeWidth = 1.75, className, title }: IconProps) {
  const shapes: readonly Shape[] = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {shapes.map(renderShape)}
    </svg>
  );
}

/** The same icon as an SVG string, for imperatively created DOM (map markers). */
export function iconSvg(name: IconName, size = 16, strokeWidth = 2): string {
  const shapes: readonly Shape[] = ICONS[name];
  const inner = shapes
    .map((s) => {
      switch (s[0]) {
        case 'path':
          return `<path d="${s[1]}"/>`;
        case 'fill':
          return `<path d="${s[1]}" fill="currentColor" stroke="none"/>`;
        case 'circle':
          return `<circle cx="${s[1]}" cy="${s[2]}" r="${s[3]}"/>`;
        case 'dot':
          return `<circle cx="${s[1]}" cy="${s[2]}" r="${s[3]}" fill="currentColor" stroke="none"/>`;
        case 'rect':
          return `<rect x="${s[1]}" y="${s[2]}" width="${s[3]}" height="${s[4]}" rx="${s[5]}"/>`;
      }
    })
    .join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}
