"use client";

import { useMemo, useState } from "react";
import { theme } from "@/lib/theme";

export interface SensitivityChartPoint {
  exitProceeds: string;
  classResults: { id: string; totalProceeds: string }[];
}

export interface SensitivityChartClass {
  id: string;
  name: string;
}

/**
 * v0.32.0 — a dependency-free, hand-rolled inline SVG line chart: "a line graph of
 * payouts by share classes... across a range of exit values," Carta's own description
 * of their sensitivity view. No charting library exists anywhere in this app yet (see
 * the research behind this feature) and this app has zero other UI dependencies beyond
 * React itself, so a small hand-built chart stays consistent with that rather than
 * introducing the first one for a single feature.
 *
 * Colors are the first N slots of the dataviz skill's validated default categorical
 * palette (fixed hue order — blue, orange, aqua, yellow, magenta, green, violet, red —
 * chosen so adjacent lines clear the colorblind-safe separation gate; NOT reordered or
 * cycled per class). This app has no dark-mode support anywhere else, so only the
 * light-surface steps are used, matching every other page's plain white background.
 * Past 8 classes (unusual — most cap tables collapse to a handful of preferred series
 * plus one common pool) extra series fall back to a shared muted gray rather than
 * inventing a 9th hue with no CVD guarantee.
 */
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const OVERFLOW_COLOR = "#8a8a86";

function colorFor(index: number): string {
  return index < PALETTE.length ? PALETTE[index] : OVERFLOW_COLOR;
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(abs % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

const WIDTH = 760;
const HEIGHT = 380;
const MARGIN = { top: 16, right: 16, bottom: 40, left: 64 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

export default function WaterfallSensitivityChart({ points, classes }: { points: SensitivityChartPoint[]; classes: SensitivityChartClass[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { xs, series, maxY } = useMemo(() => {
    const xs = points.map((p) => Number(p.exitProceeds));
    const series = classes.map((c, i) => ({
      id: c.id,
      name: c.name,
      color: colorFor(i),
      values: points.map((p) => Number(p.classResults.find((cr) => cr.id === c.id)?.totalProceeds ?? 0)),
    }));
    const maxY = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
    return { xs, series, maxY };
  }, [points, classes]);

  if (points.length < 2) {
    return <p style={{ color: theme.warning.fg }}>Need at least two points to draw a sensitivity curve.</p>;
  }

  const minX = xs[0];
  const maxX = xs[xs.length - 1];
  const xScale = (x: number) => MARGIN.left + ((x - minX) / (maxX - minX || 1)) * PLOT_W;
  const yScale = (y: number) => MARGIN.top + PLOT_H - (y / maxY) * PLOT_H;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  const xTickCount = Math.min(6, xs.length);
  const xTickIndices = Array.from({ length: xTickCount }, (_, i) => Math.round((i * (xs.length - 1)) / (xTickCount - 1)));

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    // Map the mouse's on-screen position within this <rect> (0..rect.width, in actual
    // rendered CSS pixels) to a fraction across the plot area — independent of how
    // much the viewBox has been scaled up or down by the container's actual width.
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(frac * (xs.length - 1));
    setHoverIndex(Math.max(0, Math.min(xs.length - 1, idx)));
  }

  const hoverX = hoverIndex !== null ? xScale(xs[hoverIndex]) : null;

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: "100%", height: "auto", maxWidth: 760, fontFamily: theme.font.body }} role="img" aria-label="Total proceeds by class across a range of exit values">
        {/* Gridlines + y-axis labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={yScale(t)} y2={yScale(t)} stroke={theme.border} strokeWidth={1} />
            <text x={MARGIN.left - 8} y={yScale(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={theme.inkMuted}>
              {formatCompact(t)}
            </text>
          </g>
        ))}
        {/* X-axis labels */}
        {xTickIndices.map((idx) => (
          <text key={idx} x={xScale(xs[idx])} y={HEIGHT - MARGIN.bottom + 16} textAnchor="middle" fontSize={10} fill={theme.inkMuted}>
            {formatCompact(xs[idx])}
          </text>
        ))}
        <text x={MARGIN.left + PLOT_W / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={10} fill={theme.inkMuted}>
          Exit proceeds
        </text>

        {/* One line per class, 2px stroke, rounded joins/caps */}
        {series.map((s) => (
          <path
            key={s.id}
            d={s.values.map((v, i) => `${i === 0 ? "M" : "L"}${xScale(xs[i])},${yScale(v)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Hover crosshair + markers */}
        {hoverX !== null && (
          <>
            <line x1={hoverX} x2={hoverX} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke={theme.border} strokeWidth={1} strokeDasharray="3,3" />
            {series.map((s) => (
              <circle key={s.id} cx={hoverX} cy={yScale(s.values[hoverIndex!])} r={4} fill={s.color} stroke="#fff" strokeWidth={1} />
            ))}
          </>
        )}

        {/* Transparent overlay to capture hover position across the whole plot area */}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        />
      </svg>

      {/* Legend — always present for 2+ series, per the dataviz skill's accessibility rule */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginTop: "0.25rem", fontSize: "0.85rem" }}>
        {series.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: "inline-block" }} />
            {s.name}
          </div>
        ))}
      </div>

      {/* Accessible table view of the exact hovered (or last) point — identity is never color-alone */}
      {hoverIndex !== null && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: theme.ink }}>
          At exit proceeds of <strong>{formatCompact(xs[hoverIndex])}</strong>:{" "}
          {series.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <span style={{ color: s.color, fontWeight: 600 }}>{s.name}</span>: {formatCompact(s.values[hoverIndex])}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
