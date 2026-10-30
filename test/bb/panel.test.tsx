// @vitest-environment jsdom
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, type RenderedSlot, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { rpcContract } from "../../extensions/bb/contract.js";
import { modelRow, sampleReport } from "../helpers.js";
import { answer, backend, CHILD, THREAD } from "./fixtures.js";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

const slots: RenderedSlot[] = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
});

const FAMILY = {
  total: 6.64,
  calls: 46,
  estimated: false,
  children: [
    { threadId: CHILD, title: "Investigate footer selector", cost: 1.1, calls: 14, running: true, model: "p/claude-sonnet", estimated: false },
    { threadId: "thr_dddddddd", title: "Write chip tests", cost: 0.72, calls: 9, running: false, model: null, estimated: false },
  ],
};

async function renderPanel(server: ReturnType<typeof backend>, params: JsonValue | null = null, settings: Record<string, number | boolean> = {}) {
  const app = await loadPluginApp(() => import("../../extensions/bb/app.js"));
  const action = app.threadPanelActions[0];
  if (!action) throw new Error("the Burn panel is not registered");
  const slot = renderSlot<{ threadId: string; params: JsonValue | null }, typeof rpcContract>(action, { threadId: THREAD, params }, { rpc: server.rpc, settings });
  slots.push(slot);
  await slot.findByTestId("burn-panel");
  return slot;
}

const turnRows = (slot: RenderedSlot) => [...within(slot.getByTestId("turns")).getAllByRole("button")].map((b) => b.dataset.turn);

describe("the Burn panel", () => {
  it("shows the thread, its children's share, cost per call and the cache hit rate", async () => {
    const slot = await renderPanel(backend(() => answer({ budget: { amount: 10, source: "setting" }, family: FAMILY })));
    const kpis = slot.getByTestId("kpis").textContent ?? "";
    for (const part of ["This thread$4.82", "48% of $10 budget", "With 2 children$6.64", "+$1.82 in children (27%)", "Per call$0.21", "23 calls · 1h 12m", "Cache89%"]) {
      expect(kpis).toContain(part);
    }
    expect(slot.container.textContent).not.toMatch(/saved|\/h\b|per hour|Jump to message|~/);
    expect(slot.queryByTestId("estimated")).toBeNull();
  });

  it("shows output speed over the timed calls, for the thread, each model and each turn", async () => {
    const report = sampleReport({
      byModel: [
        modelRow("p/claude-opus", 4.31, 1_500_000, 18, { timed: 18, ms: 36_000, timedOutput: 2232 }),
        modelRow("p/claude-haiku", 0.51, 236_000, 5, { timed: 5, ms: 5000, timedOutput: 1000 }),
      ],
    });
    report.turns[1] = { ...report.turns[1]!, ms: 8000, timedOutput: 496 };
    const slot = await renderPanel(backend(() => answer({ report })));
    expect(slot.getByTestId("kpis").textContent).toContain("Speed79 tok/soutput, timed calls");
    const models = slot.getByTestId("models").textContent ?? "";
    expect(models).toContain("claude-opus18 calls · 62 tok/s");
    expect(models).toContain("claude-haiku5 calls · 200 tok/s");
    fireEvent.click(slot.getByRole("button", { name: /refactor the parser/ }));
    expect(slot.getByTestId("turn-2-detail").textContent).toContain("62 tok/s");
    fireEvent.click(slot.getByRole("button", { name: /review/ }));
    expect(slot.getByTestId("turn-3-detail").textContent).not.toContain("tok/s");
  });

  it("says when no call was timed, as in harnesses that record no call times", async () => {
    const slot = await renderPanel(backend());
    expect(slot.getByTestId("kpis").textContent).toContain("Speed—no timed calls");
    expect(slot.getByTestId("models").textContent).not.toContain("tok/s");
  });

  it("marks list-price estimates in the figures, the children and the total, and says why", async () => {
    const family = { ...FAMILY, estimated: true, children: FAMILY.children.map((c, i) => ({ ...c, estimated: i === 0 })) };
    const slot = await renderPanel(backend(() => answer({ report: sampleReport({ estimated: true }), family })));
    const kpis = slot.getByTestId("kpis").textContent ?? "";
    for (const part of ["This thread~$4.82", "With 2 children~$6.64", "Per call~$0.21"]) expect(kpis).toContain(part);
    expect(slot.getByTestId("estimated").textContent).toBe("~ Estimated from list prices: this harness records no cost.");
    const rows = slot.getByTestId("family").textContent ?? "";
    expect(rows).toContain("14 calls~$1.10");
    expect(rows).toContain("9 calls$0.72");
    expect(slot.getByTestId("family-total").textContent).toBe("Total46 calls~$6.64");
  });

  it("lists turns newest first or costliest first, with the outlier in the warning tone", async () => {
    const slot = await renderPanel(backend());
    expect(turnRows(slot)).toEqual(["4", "3", "2", "1"]);
    fireEvent.click(slot.getByRole("button", { name: "Costliest" }));
    expect(turnRows(slot)).toEqual(["2", "3", "1", "4"]);
    const hot = slot.container.querySelectorAll("[data-hot]");
    expect([...hot].map((b) => (b as HTMLElement).dataset.turn)).toEqual(["2"]);
  });

  it("expands a turn into its calls, tokens, per-call costs and tools", async () => {
    const slot = await renderPanel(backend());
    const row = slot.getByRole("button", { name: /refactor the parser/ });
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = slot.getByTestId("turn-2-detail").textContent ?? "";
    for (const part of ["3 calls", "2m 00s", "claude-opus", "7.3× the median turn", "input 1.0k", "cache read 20k", "cache write 2.0k", "output 500", "$0.62 · $1.40 · $0.90", "bash ×6", "edit ×5"]) {
      expect(detail).toContain(part);
    }
    fireEvent.click(slot.getByRole("button", { name: /review/ }));
    expect(slot.queryByTestId("turn-2-detail")).toBeNull();
    expect(slot.getByTestId("turn-3-detail").textContent).toContain("no tools");
  });

  it("rolls children into one total and opens a child's thread", async () => {
    const slot = await renderPanel(backend(() => answer({ family: FAMILY })));
    const family = within(slot.getByTestId("family"));
    expect(family.getByText("burn UX polish")).toBeTruthy();
    expect(family.getAllByLabelText("running")).toHaveLength(1);
    expect(slot.getByTestId("family-total").textContent).toBe("Total46 calls$6.64");
    fireEvent.click(family.getByRole("button", { name: /Open Investigate footer selector/ }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: CHILD });
  });

  it("refetches when the thread or one of its children reports", async () => {
    const server = backend(() => answer({ family: FAMILY }));
    const slot = await renderPanel(server);
    await slot.behavior.emitRealtime("usage", { threadId: "thr_zzzzzzzz" });
    expect(server.callsTo("usage")).toHaveLength(1);
    await slot.behavior.emitRealtime("usage", { threadId: CHILD });
    await vi.waitFor(() => expect(server.callsTo("usage")).toHaveLength(2));
  });

  it("focuses the budget editor when opened for it", async () => {
    const slot = await renderPanel(backend(), { focus: "budget" }, { threadBudget: 10 });
    expect(document.activeElement).toBe(slot.getByRole("textbox", { name: "Budget in dollars" }));
    const plain = await renderPanel(backend(), { focus: 3 });
    expect(document.activeElement).not.toBe(within(plain.container).getByRole("textbox", { name: "Budget in dollars" }));
  });

  it("explains the wait and still lets a budget be set before the first model call", async () => {
    const slot = await renderPanel(backend(() => answer({ report: null, reportedAt: null })));
    expect(slot.getByTestId("waiting").textContent).toContain("Waiting for the first model call");
    expect(slot.getByTestId("waiting").textContent).not.toContain("Only pi threads");
    expect(slot.getByRole("textbox", { name: "Budget in dollars" })).toBeTruthy();
    expect(slot.queryByTestId("turns")).toBeNull();
  });

  it("shows no price switch without a discount", async () => {
    const slot = await renderPanel(backend());
    expect(slot.queryByRole("group", { name: "Prices" })).toBeNull();
    expect(slot.queryByTestId("price-note")).toBeNull();
  });

  it("switches between discounted figures and list price, with no budget share at list price", async () => {
    const budget = { amount: 10, source: "setting" as const };
    const atList = sampleReport({ cost: { ...sampleReport().cost, total: 5.74 } });
    const server = backend(undefined, { usage: ({ listPrice }) => answer({ budget, report: listPrice ? atList : sampleReport() }) });
    const slot = await renderPanel(server, null, { discount: 16 });
    const prices = () => within(slot.getByRole("group", { name: "Prices" }));
    const note = () => slot.getByTestId("price-note").textContent;
    expect(note()).toBe("After the discounts in Burn's settings.");
    expect(slot.getByTestId("kpis").textContent).toContain("This thread$4.82");
    expect(slot.getByTestId("kpis").textContent).toContain("48% of $10 budget");
    expect(server.callsTo("usage").map((c) => c.input)).toEqual([{ threadId: THREAD }]);

    const pressed = prices().getByRole("button", { name: "List price" });
    fireEvent.click(pressed);
    await vi.waitFor(() => expect(server.callsTo("usage").at(-1)?.input).toEqual({ threadId: THREAD, listPrice: true }));
    expect(note()).toBe("List price, without your discounts. Budgets use the discounted figures.");
    await vi.waitFor(() => expect(slot.getByTestId("kpis").textContent).toContain("This thread$5.74At list price"));
    // The switch stays mounted while the list-price answer loads.
    expect(pressed.isConnected).toBe(true);
    expect(slot.container.textContent).not.toMatch(/% of/);

    fireEvent.click(prices().getByRole("button", { name: "With discounts" }));
    await vi.waitFor(() => expect(server.callsTo("usage").at(-1)?.input).toEqual({ threadId: THREAD }));
    expect(note()).toBe("After the discounts in Burn's settings.");
    await vi.waitFor(() => expect(slot.getByTestId("kpis").textContent).toContain("This thread$4.82"));
    expect(slot.getByTestId("kpis").textContent).toContain("48% of $10 budget");
  });

  it("notes a run Burn stopped", async () => {
    const slot = await renderPanel(backend(() => answer({ report: sampleReport({ stoppedAt: 1 }), budget: { amount: 5, source: "thread" } })));
    expect(slot.getByRole("note").textContent).toContain("Burn stopped a run at the $5 budget");
  });
});

it('shows native agents under their owning child without adding their spend twice', async () => {
 const native={coverage:'available' as const,rows:[{id:'child-agent',calls:2,cost:{input:.4,output:0,cacheRead:0,cacheWrite:0,total:.4},estimated:false}]};
 const family={...FAMILY,agents:native,children:FAMILY.children.map((child,i)=>({...child,...(i===0?{agents:native}:{})}))};
 const slot=await renderPanel(backend(()=>answer({family})));
 expect(slot.getByTestId('kpis').textContent).toContain('With agents$0.40');
 expect(slot.getByTestId('agent-rows').textContent).toContain('$0.40 · of the thread total');
 expect(slot.getByTestId('family-total').textContent).toBe('Total46 calls$6.64');
});

it("limits calculation triggers to the corresponding KPI amounts", async () => {
 const current = answer({family:FAMILY});
 current.report!.agents={coverage:'available',rows:[{id:'native',calls:1,cost:{input:1,output:0,cacheRead:0,cacheWrite:0,total:1},estimated:false}]};
 const slot = await renderPanel(backend(() => current));
 const own = slot.getByRole('button', {name:'Cost calculation'});
 expect(own.textContent).toBe('$4.82');
 expect(own.querySelector('div')).toBeNull();
 fireEvent.focus(own);
 const ownCalculation = slot.getByRole('tooltip').textContent;
 expect(ownCalculation).toContain('This thread$4.82');
 expect(ownCalculation).not.toMatch(/Child threads|Total with children|6.64/);
 fireEvent.blur(own);
 const family = slot.getByRole('button', {name:'Family cost calculation'});
 expect(family.textContent).toBe('$6.64');
 fireEvent.focus(family);
 const familyCalculation = slot.getByRole('tooltip').textContent;
 expect(familyCalculation).toContain('This thread$4.82');
 expect(familyCalculation).toContain('Child threads · 2$1.82');
 expect(familyCalculation).toContain('Total with children$6.64');
 expect(familyCalculation).not.toMatch(/Main agent|Its subagents|known portion/);
});
