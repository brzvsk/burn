// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CallChart, callPoints, callTip, MiniBars, StackedBar, tipLeft } from "../../extensions/bb/charts.js";
import { sampleReport } from "../helpers.js";

afterEach(cleanup);

describe("callPoints", () => {
  it("places each call in its turn and carries the running total", () => {
    expect(callPoints(sampleReport()).map(callTip)).toEqual([
      "Turn 1 · call 2/2 · $0.10 · total $3.89",
      "Turn 2 · call 3/3 · $0.62 · total $4.51",
      "Turn 3 · call 2/2 · $0.31 · total $4.82",
    ]);
  });

  it("counts calls from the turn's own count when the series starts mid-turn", () => {
    const report = sampleReport({
      series: [
        { at: 1, cost: 0.2, tokens: 1, turn: 6 },
        { at: 2, cost: 0.3, tokens: 1, turn: 6 },
        { at: 3, cost: 0.1, tokens: 1, turn: 7 },
      ],
      turns: [{ ...sampleReport().turns[0]!, n: 6, calls: 6 }],
    });
    expect(callPoints(report).map((p) => `${p.turn}:${p.call}/${p.calls}`)).toEqual(["6:5/6", "6:6/6", "7:1/1"]);
  });
});

describe("tipLeft", () => {
  it("centres the label on its bar and keeps it inside the chart", () => {
    expect(tipLeft(4, 10, 300, 100)).toBe(85);
    expect(tipLeft(0, 10, 300, 100)).toBe(0);
    expect(tipLeft(9, 10, 300, 100)).toBe(200);
    expect(tipLeft(5, 10, 80, 100)).toBe(0);
  });
});

describe("CallChart", () => {
  it("draws a bar per call, the priciest in the warning colour and the latest in the accent, with alternating turn bands", () => {
    const { container } = render(<CallChart points={callPoints(sampleReport())} />);
    const bars = [...container.querySelectorAll("rect[data-bar]")];
    expect(bars.map((b) => b.getAttribute("class"))).toEqual(["fill-success", "fill-warning", "fill-timeline-accent"]);
    expect(container.querySelectorAll("rect.fill-foreground")).toHaveLength(1);
    expect(container.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(3);
    expect(container.textContent).toContain("turns 1 to 3");
  });

  it("shows the hovered call and dims the others", () => {
    const { container, getByRole, queryByRole } = render(<CallChart points={callPoints(sampleReport())} />);
    fireEvent.mouseEnter(container.querySelector('[data-call="2"]') as Element);
    expect(getByRole("status").textContent).toBe("Turn 3 · call 2/2 · $0.31 · total $4.82");
    expect([...container.querySelectorAll("rect[data-bar]")].map((b) => b.getAttribute("opacity"))).toEqual(["0.45", "0.45", "1"]);
    fireEvent.mouseLeave(container.querySelector("svg") as Element);
    expect(queryByRole("status")).toBeNull();
  });

  it("draws nothing for no calls", () => {
    expect(render(<CallChart points={[]} />).container.querySelector("svg")).toBeNull();
  });
});

describe("StackedBar and MiniBars", () => {
  it("gives each non-zero part its share", () => {
    const { container } = render(
      <StackedBar
        parts={[
          { key: "a", value: 3, className: "bg-success" },
          { key: "b", value: 0, className: "bg-warning" },
          { key: "c", value: 1, className: "bg-attention" },
        ]}
      />,
    );
    const parts = [...container.querySelectorAll("[data-part]")] as HTMLElement[];
    expect(parts.map((p) => [p.dataset.part, Number(p.style.flexGrow)])).toEqual([
      ["a", 0.75],
      ["c", 0.25],
    ]);
  });

  it("fills the bar even when the parts are small dollar amounts", () => {
    const { container } = render(
      <StackedBar
        parts={[
          { key: "a", value: 0.03, className: "bg-success" },
          { key: "b", value: 0.01, className: "bg-attention" },
        ]}
      />,
    );
    const parts = [...container.querySelectorAll("[data-part]")] as HTMLElement[];
    const shares = parts.map((p) => Number(p.style.flexGrow));
    expect(shares.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1);
    expect(shares).toEqual([0.75, 0.25]);
  });

  it("scales per-call bars to the largest and marks the hot one", () => {
    const { container } = render(<MiniBars values={[0.1, 0.4, 0.2]} hot={1} />);
    const bars = [...container.querySelectorAll("i")] as HTMLElement[];
    expect(bars.map((b) => b.style.height)).toEqual(["7px", "28px", "14px"]);
    expect(bars[1]?.className).toContain("bg-warning");
    expect(bars.map((b) => b.title)).toEqual(["$0.10", "$0.40", "$0.20"]);
  });
});
