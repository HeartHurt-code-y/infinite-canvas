import React from "react";
import { AbsoluteFill, spring, useCurrentFrame } from "remotion";

type Element = {
  id: string;
  label: string;
  detail?: string;
  value?: number;
  group?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};
export type AnimationPlan = {
  schemaVersion: string;
  template: string;
  title: string;
  subtitle?: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  background: string;
  palette: string[];
  elements: Element[];
  connections: { from: string; to: string; label?: string }[];
  staggerFrames: number;
  holdFrames: number;
  springDamping: number;
};
type Box = { x: number; y: number; width: number; height: number };

const units = (text: string) =>
  [...text].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : 0.58), 0);
const fit = (text: string, width: number, height: number, maximum = 24) => {
  for (let size = maximum; size > 4; size -= 0.5) {
    const lines = text
      .split("\n")
      .reduce(
        (sum, line) => sum + Math.max(1, Math.ceil((units(line) * size) / Math.max(1, width))),
        0,
      );
    if (lines * size * 1.4 <= height) return size;
  }
  return 4;
};
const colorAt = (plan: AnimationPlan, index: number) => plan.palette[index % plan.palette.length];
const luminance = (color: string) => {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114;
};

function grid(plan: AnimationPlan, area: Box, columns?: number): Box[] {
  const count = plan.elements.length;
  const cols =
    columns ?? Math.max(1, Math.ceil(Math.sqrt(((count * area.width) / area.height) * 0.72)));
  const rows = Math.ceil(count / cols);
  const gap = Math.min(20, area.width * 0.035, area.height * 0.05);
  const width = (area.width - gap * (cols - 1)) / cols;
  const height = (area.height - gap * (rows - 1)) / rows;
  return plan.elements.map((_, index) => ({
    x: area.x + (index % cols) * (width + gap),
    y: area.y + Math.floor(index / cols) * (height + gap),
    width,
    height,
  }));
}

function layout(plan: AnimationPlan, area: Box): Box[] {
  const count = plan.elements.length;
  if (plan.template === "custom")
    return plan.elements.map((item) => ({
      x: item.x!,
      y: item.y!,
      width: item.width!,
      height: item.height!,
    }));
  if (plan.template === "cycle-flowchart" && count > 2) {
    const width = Math.min(area.width * 0.3, (area.width * 2.4) / count);
    const height = Math.min(area.height * 0.27, (area.height * 2) / count);
    return plan.elements.map((_, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
      return {
        x: area.x + area.width / 2 + Math.cos(angle) * (area.width - width) * 0.48 - width / 2,
        y: area.y + area.height / 2 + Math.sin(angle) * (area.height - height) * 0.48 - height / 2,
        width,
        height,
      };
    });
  }
  if (plan.template === "skills-flowchart" && count > 1) {
    const mainWidth = area.width * 0.3;
    const leaves = grid(
      { ...plan, elements: plan.elements.slice(1) },
      { x: area.x + area.width * 0.44, y: area.y, width: area.width * 0.56, height: area.height },
      count > 7 ? 2 : 1,
    );
    return [
      { x: area.x, y: area.y + area.height * 0.31, width: mainWidth, height: area.height * 0.38 },
      ...leaves,
    ];
  }
  if (plan.template === "timeline") {
    const horizontal = area.width > area.height * 1.6 && count <= 6;
    if (horizontal)
      return plan.elements.map((_, index) => ({
        x: area.x + (index * area.width) / count + 6,
        y: area.y + (index % 2 ? 0.54 : 0.04) * area.height,
        width: area.width / count - 12,
        height: area.height * 0.38,
      }));
    return plan.elements.map((_, index) => ({
      x: area.x + (index % 2 ? 0.54 : 0) * area.width,
      y: area.y + (index * area.height) / count + 3,
      width: area.width * 0.46,
      height: area.height / count - 6,
    }));
  }
  if (plan.template === "person-card" && count > 1) {
    const main = { x: area.x, y: area.y, width: area.width * 0.34, height: area.height };
    return [
      main,
      ...grid(
        { ...plan, elements: plan.elements.slice(1) },
        { x: area.x + area.width * 0.39, y: area.y, width: area.width * 0.61, height: area.height },
        count > 7 ? 2 : 1,
      ),
    ];
  }
  if (plan.template === "compare-flowchart") {
    const groups = [...new Set(plan.elements.map((item) => item.group ?? ""))];
    const leftGroup = groups[0];
    const left = plan.elements.filter((item, index) =>
      groups.length > 1
        ? item.group === leftGroup || (!item.group && leftGroup === "")
        : index % 2 === 0,
    );
    const right = plan.elements.filter((item) => !left.includes(item));
    return plan.elements.map((item) => {
      const isLeft = left.includes(item);
      const collection = isLeft ? left : right;
      const index = collection.indexOf(item);
      return {
        x: area.x + (isLeft ? 0 : 0.54) * area.width,
        y: area.y + (index * area.height) / collection.length + 5,
        width: area.width * 0.46,
        height: area.height / collection.length - 10,
      };
    });
  }
  if (["terminal-flowchart", "code-showcase"].includes(plan.template)) return grid(plan, area, 1);
  return grid(plan, area);
}

function entry(plan: AnimationPlan, frame: number, index: number) {
  const elapsed = frame - index * plan.staggerFrames;
  if (elapsed < 0) return 0;
  if (elapsed >= 30 || frame >= plan.durationInFrames - plan.holdFrames) return 1;
  return spring({
    frame: elapsed,
    fps: plan.fps,
    durationInFrames: 30,
    config: { damping: plan.springDamping, stiffness: 120, mass: 0.7 },
  });
}

function Connections({
  plan,
  boxes,
  frame,
  ink,
}: {
  plan: AnimationPlan;
  boxes: Box[];
  frame: number;
  ink: string;
}) {
  const edges = plan.connections;
  return (
    <svg
      style={{ position: "absolute", inset: 0 }}
      width={plan.width}
      height={plan.height}
      viewBox={`0 0 ${plan.width} ${plan.height}`}
    >
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8" fill="none" stroke={ink} strokeWidth="1.5" />
        </marker>
      </defs>
      {edges.map((edge, index) => {
        const from = plan.elements.findIndex((item) => item.id === edge.from);
        const to = plan.elements.findIndex((item) => item.id === edge.to);
        const a = boxes[from],
          b = boxes[to];
        const ax = a.x + a.width / 2,
          ay = a.y + a.height / 2,
          bx = b.x + b.width / 2,
          by = b.y + b.height / 2;
        const dx = bx - ax,
          dy = by - ay;
        const sourceRatio = Math.min(
          Math.abs(a.width / 2 / (dx || 0.001)),
          Math.abs(a.height / 2 / (dy || 0.001)),
        );
        const targetRatio = Math.min(
          Math.abs((b.width / 2 + 6) / (dx || 0.001)),
          Math.abs((b.height / 2 + 6) / (dy || 0.001)),
        );
        const x1 = ax + dx * sourceRatio,
          y1 = ay + dy * sourceRatio,
          x2 = bx - dx * targetRatio,
          y2 = by - dy * targetRatio;
        const opacity = Math.min(1, Math.max(0, entry(plan, frame, Math.max(from, to))));
        return (
          <g key={index} opacity={opacity}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={ink}
              strokeOpacity=".48"
              strokeWidth={Math.max(1.4, plan.width / 450)}
              markerEnd="url(#arrow)"
            />
            {edge.label && (
              <text
                x={(x1 + x2) / 2}
                y={(y1 + y2) / 2 - 7}
                textAnchor="middle"
                fill={ink}
                stroke={plan.background}
                strokeWidth="4"
                paintOrder="stroke"
                fontSize={fit(edge.label, Math.max(60, Math.abs(x2 - x1)), 22, 13)}
              >
                {edge.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Card({
  plan,
  item,
  index,
  box,
  frame,
  ink,
  dark,
}: {
  plan: AnimationPlan;
  item: Element;
  index: number;
  box: Box;
  frame: number;
  ink: string;
  dark: boolean;
}) {
  const p = entry(plan, frame, index);
  const terminal = plan.template === "terminal-flowchart";
  const code = plan.template === "code-showcase";
  const cute = plan.template === "cute-flowchart";
  const morandi = plan.template === "morandi-grid";
  const person = plan.template === "person-card" && index === 0;
  const accent = colorAt(plan, index);
  const padding = Math.min(22, box.width * 0.09, box.height * 0.13);
  const numberSize = Math.min(13, box.height * 0.16);
  const hasGroup = !!item.group && !code;
  const labelHeight = box.height * (item.detail ? 0.3 : 0.58);
  const detailHeight =
    box.height -
    padding * 2 -
    labelHeight -
    (hasGroup ? numberSize * 1.6 : 0) -
    (person ? box.height * 0.3 : 0) -
    (code ? 6 : 10);
  const labelSize = fit(
    item.label,
    box.width - padding * 2 - (terminal ? 20 : 0),
    labelHeight,
    Math.min(person ? 36 : 25, box.width * 0.15),
  );
  const background =
    terminal || code
      ? "#14232b"
      : morandi
        ? `${accent}24`
        : cute
          ? `${accent}18`
          : dark
            ? "#ffffff12"
            : "#ffffff";
  const foreground = terminal || code ? "#eef5f4" : ink;
  return (
    <div
      style={{
        position: "absolute",
        ...{ left: box.x, top: box.y, width: box.width, height: box.height },
        boxSizing: "border-box",
        opacity: Math.min(1, Math.max(0, p)),
        transform: `translateY(${(1 - p) * 18}px) scale(${0.94 + 0.06 * p}) rotate(${cute ? (1 - p) * (index % 2 ? -5 : 5) : 0}deg)`,
        background,
        color: foreground,
        border: `${cute ? 2 : 1}px solid ${cute ? accent : `${accent}50`}`,
        borderRadius: cute ? 26 : terminal || code ? 7 : 14,
        boxShadow: cute ? `0 5px 0 ${accent}35` : "none",
        padding,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: Math.min(8, box.height * 0.04),
        fontFamily: terminal || code ? 'Consolas, "Microsoft YaHei", monospace' : "inherit",
      }}
    >
      {person && (
        <div
          style={{
            height: box.height * 0.3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: Math.min(box.width * 0.6, box.height * 0.27),
              aspectRatio: "1",
              borderRadius: "50%",
              background: accent,
              color: luminance(accent) > 150 ? "#18282b" : "#ffffff",
              display: "grid",
              placeItems: "center",
              fontSize: Math.min(box.width * 0.22, box.height * 0.1),
              fontWeight: 800,
            }}
          >
            {[...item.label].slice(0, 2).join("")}
          </div>
        </div>
      )}
      {hasGroup && (
        <div
          style={{
            fontSize: numberSize,
            fontWeight: 700,
            color: terminal ? "#8adbba" : accent,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {item.group}
        </div>
      )}
      <div
        style={{
          fontSize: labelSize,
          lineHeight: 1.35,
          fontWeight: 760,
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
          flexShrink: 0,
        }}
      >
        {terminal ? (
          <span style={{ color: "#8adbba" }}>{"> "}</span>
        ) : code ? (
          <span style={{ color: "#739bb1", fontWeight: 400 }}>
            {String(index + 1).padStart(2, "0")}　
          </span>
        ) : null}
        {item.label}
      </div>
      {item.detail && (
        <div
          style={{
            fontSize: fit(
              item.detail,
              box.width - padding * 2,
              Math.max(8, detailHeight),
              code ? 21 : 17,
            ),
            lineHeight: 1.4,
            color: foreground,
            opacity: 0.78,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {item.detail}
        </div>
      )}
      {item.value !== undefined && plan.template !== "pie-chart" && (
        <span style={{ fontSize: Math.min(20, box.height * 0.18), fontWeight: 700, color: accent }}>
          {item.value}
        </span>
      )}
    </div>
  );
}

function Pie({
  plan,
  area,
  frame,
  ink,
}: {
  plan: AnimationPlan;
  area: Box;
  frame: number;
  ink: string;
}) {
  const vertical = area.width < area.height * 1.15;
  const diameter = Math.min(
    area.width * (vertical ? 0.65 : 0.46),
    area.height * (vertical ? 0.48 : 0.86),
  );
  const cx = area.x + (vertical ? area.width / 2 : area.width * 0.25),
    cy = area.y + (vertical ? diameter / 2 : area.height / 2);
  const radius = diameter / 2,
    inner = radius * 0.58;
  const total = plan.elements.reduce((sum, item) => sum + item.value!, 0);
  let start = -Math.PI / 2;
  const legend = grid(
    plan,
    vertical
      ? {
          x: area.x,
          y: area.y + diameter + 14,
          width: area.width,
          height: area.height - diameter - 14,
        }
      : { x: area.x + area.width * 0.56, y: area.y, width: area.width * 0.44, height: area.height },
    vertical && plan.elements.length > 4 ? 2 : 1,
  );
  return (
    <>
      <svg style={{ position: "absolute", inset: 0 }} width={plan.width} height={plan.height}>
        {plan.elements.map((item, index) => {
          const fraction = item.value! / total;
          const sweep = fraction * Math.PI * 2;
          const end =
            start +
            Math.min(sweep, Math.PI * 2 - 0.0001) *
              Math.min(1, Math.max(0, entry(plan, frame, index)));
          const a = start;
          start += sweep;
          const path = `M ${cx + radius * Math.cos(a)} ${cy + radius * Math.sin(a)} A ${radius} ${radius} 0 ${end - a > Math.PI ? 1 : 0} 1 ${cx + radius * Math.cos(end)} ${cy + radius * Math.sin(end)} L ${cx + inner * Math.cos(end)} ${cy + inner * Math.sin(end)} A ${inner} ${inner} 0 ${end - a > Math.PI ? 1 : 0} 0 ${cx + inner * Math.cos(a)} ${cy + inner * Math.sin(a)} Z`;
          return (
            <path
              key={item.id}
              d={path}
              fill={colorAt(plan, index)}
              stroke={plan.background}
              strokeWidth="3"
              opacity={fraction === 0 ? 0 : 1}
            />
          );
        })}
        <text
          x={cx}
          y={cy + 6}
          textAnchor="middle"
          fill={ink}
          fontWeight="700"
          fontSize={Math.min(26, diameter * 0.11)}
        >
          100%
        </text>
      </svg>
      {plan.elements.map((item, index) => {
        const box = legend[index];
        const percent = `${((item.value! / total) * 100).toFixed(1).replace(/\.0$/, "")}%`;
        const label = `${item.label}  ${percent}`;
        return (
          <div
            key={item.id}
            style={{
              position: "absolute",
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              display: "flex",
              alignItems: "center",
              gap: 10,
              opacity: Math.min(1, Math.max(0, entry(plan, frame, index))),
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 4,
                flexShrink: 0,
                background: colorAt(plan, index),
              }}
            />
            <div
              style={{
                color: ink,
                fontSize: fit(label, box.width - 22, box.height * (item.detail ? 0.5 : 0.85), 22),
                fontWeight: 700,
                overflowWrap: "anywhere",
              }}
            >
              {label}
              {item.detail && (
                <div
                  style={{
                    fontWeight: 400,
                    opacity: 0.72,
                    fontSize: fit(item.detail, box.width - 22, box.height * 0.42, 15),
                    lineHeight: 1.35,
                  }}
                >
                  {item.detail}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

export const Animation = ({ plan }: { plan: AnimationPlan }) => {
  const frame = useCurrentFrame();
  const dark = luminance(plan.background) < 110;
  const ink = dark ? "#f3f5f4" : "#223633";
  const margin = Math.min(plan.width, plan.height) * 0.055;
  const headerHeight = plan.height * (plan.subtitle ? 0.24 : 0.19);
  const area = {
    x: margin,
    y: headerHeight,
    width: plan.width - margin * 2,
    height: plan.height - headerHeight - margin,
  };
  const boxes = layout(plan, area);
  const screen = ["terminal-flowchart", "code-showcase"].includes(plan.template);
  const titleWidth = plan.width - margin * 2;
  return (
    <AbsoluteFill
      style={{
        background: plan.background,
        fontFamily: '"Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif',
        color: ink,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: margin,
          right: margin,
          top: margin * 0.75,
          opacity: Math.min(1, frame / 12),
        }}
      >
        {screen && (
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {["#d88983", "#d5b571", "#87b099"].map((color) => (
              <span
                key={color}
                style={{ width: 8, height: 8, borderRadius: "50%", background: color }}
              />
            ))}
          </div>
        )}
        <div
          style={{
            fontWeight: 800,
            letterSpacing: "-.035em",
            fontSize: fit(
              plan.title,
              titleWidth,
              headerHeight * 0.46,
              Math.min(46, plan.width * 0.058),
            ),
            lineHeight: 1.16,
            overflowWrap: "anywhere",
          }}
        >
          {plan.title}
        </div>
        {plan.subtitle && (
          <div
            style={{
              marginTop: 8,
              opacity: 0.65,
              fontSize: fit(
                plan.subtitle,
                titleWidth,
                headerHeight * 0.28,
                Math.min(18, plan.width * 0.023),
              ),
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}
          >
            {plan.subtitle}
          </div>
        )}
      </div>
      {plan.template === "compare-flowchart" && (
        <div
          style={{
            position: "absolute",
            top: area.y,
            bottom: margin,
            left: "50%",
            width: 1,
            background: `${ink}30`,
          }}
        />
      )}
      {plan.template === "timeline" && (
        <svg style={{ position: "absolute", inset: 0 }} width={plan.width} height={plan.height}>
          <line
            x1={
              area.width > area.height * 1.6 && plan.elements.length <= 6 ? area.x : plan.width / 2
            }
            y1={
              area.width > area.height * 1.6 && plan.elements.length <= 6
                ? area.y + area.height / 2
                : area.y
            }
            x2={
              area.width > area.height * 1.6 && plan.elements.length <= 6
                ? area.x + area.width
                : plan.width / 2
            }
            y2={
              area.width > area.height * 1.6 && plan.elements.length <= 6
                ? area.y + area.height / 2
                : area.y + area.height
            }
            stroke={colorAt(plan, 0)}
            strokeWidth="3"
          />
          {boxes.map((box, index) => (
            <circle
              key={index}
              cx={
                area.width > area.height * 1.6 && plan.elements.length <= 6
                  ? box.x + box.width / 2
                  : plan.width / 2
              }
              cy={
                area.width > area.height * 1.6 && plan.elements.length <= 6
                  ? area.y + area.height / 2
                  : box.y + box.height / 2
              }
              r="5"
              fill={colorAt(plan, index)}
              opacity={Math.min(1, Math.max(0, entry(plan, frame, index)))}
            />
          ))}
        </svg>
      )}
      {plan.template === "pie-chart" ? (
        <Pie plan={plan} area={area} frame={frame} ink={ink} />
      ) : (
        <>
          <Connections plan={plan} boxes={boxes} frame={frame} ink={ink} />
          {plan.elements.map((item, index) => (
            <Card
              key={item.id}
              plan={plan}
              item={item}
              index={index}
              box={boxes[index]}
              frame={frame}
              ink={ink}
              dark={dark}
            />
          ))}
        </>
      )}
    </AbsoluteFill>
  );
};
