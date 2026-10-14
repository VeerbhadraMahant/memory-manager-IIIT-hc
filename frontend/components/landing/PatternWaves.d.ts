// The component is vendored JS; without this, TS infers every destructured prop as required.
import type { CSSProperties } from "react";

export interface PatternWavesProps {
  preset?: string;
  pattern?: string;
  wave?: string;
  spacing?: number;
  markSize?: number;
  depth?: number;
  light?: number;
  shine?: number;
  contrast?: number;
  speed?: number;
  scale?: number;
  direction?: number;
  color?: string;
  backgroundColor?: string;
  opacity?: number;
  fade?: string;
  fadeSize?: number;
  characters?: string;
  interactive?: boolean;
  cursorSize?: number;
  cursorStrength?: number;
  intro?: boolean;
  paused?: boolean;
  className?: string;
  style?: CSSProperties;
}

declare const PatternWaves: (props: PatternWavesProps) => JSX.Element;
export default PatternWaves;
