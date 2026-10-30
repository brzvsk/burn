// @vitest-environment jsdom
import {render, fireEvent, cleanup} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {agentLabel, AgentRows, CostBreakdown} from '../../extensions/bb/agents.js';
import {applyDiscounts} from '../../src/discounts.js';
import {buildReport} from '../../src/report.js';
import {assistant} from '../helpers.js';
import {answer} from './fixtures.js';
afterEach(cleanup);
it('keeps agent spend inside report totals and discounts its token kinds exactly', () => {
 const r = buildReport([assistant(3), {...assistant(2), agentId:'native'}], null);
 expect(r.cost.total).toBe(5);
 expect(r.agents!.rows[0]!.cost.total).toBe(2);
 const priced = applyDiscounts(r, {input:50,output:0,cacheRead:0,cacheWrite:0});
 expect(priced.agents!.rows[0]!.cost.total).toBe(1.5);
 expect(r.agents!.rows[0]!.cost.total).toBe(2);
 expect(agentLabel(undefined)).toBe('Unavailable');
 expect(agentLabel({coverage:'partial',rows:[]})).toBe('Unavailable');
});
it('opens the calculation on hover or focus, closes on Escape, and includes child-native spend once in the child total', () => {
 const r=buildReport([assistant(3), {...assistant(2),agentId:'root-agent'}],null);
 r.agents!.coverage='available';
 const a=answer({report:r,family:{total:10,calls:4,estimated:false,children:[{threadId:'thr_child000',title:'Worker',cost:5,calls:2,running:false,model:null,estimated:false}],agents:{coverage:'available',rows:[...r.agents!.rows,{...r.agents!.rows[0]!,id:'child-agent',cost:{input:1,output:0,cacheRead:0,cacheWrite:0,total:1}}]}}});
 const ui=render(<CostBreakdown answer={a} scope="family">$10.00</CostBreakdown>);
 expect(ui.queryByRole('tooltip')).toBeNull();
 fireEvent.mouseEnter(ui.getByRole('button').parentElement!);
 expect(ui.getByRole('tooltip').textContent).toContain('Child threads · 1$5.00');
 expect(ui.getByRole('tooltip').textContent).not.toMatch(/Main agent|Its subagents|known portion/);
 expect(ui.getByRole('tooltip').textContent).toContain('This thread$5.00');
 expect(ui.getByRole('tooltip').textContent).not.toContain('All subagents');
 fireEvent.keyDown(ui.getByRole('button'),{key:'Escape'});
 expect(ui.queryByRole('tooltip')).toBeNull();
 fireEvent.focus(ui.getByRole('button'));
 expect(ui.getByRole('tooltip').textContent).toContain('Total with children$10.00');
});
it('expands native rows as parts of their thread total', () => {
 const r=buildReport([{...assistant(2),agentId:'native'}],null);
 const ui=render(<AgentRows agents={r.agents}/>);
 expect(ui.getByText(/of the thread total/)).toBeTruthy();
 expect(ui.getByText('Subagent 1')).toBeTruthy();
});

for (const coverage of ["available", "partial"] as const) {
 it(`omits the entire child section without BB children (${coverage} native coverage)`, () => {
  const report=buildReport([assistant(3), {...assistant(2),agentId:'native'}],null);
  report.agents!.coverage=coverage;
  const a=answer({report,family:{total:5,calls:2,estimated:false,children:[],agents:report.agents}});
  const ui=render(<CostBreakdown answer={a}>$5.00</CostBreakdown>);
  const button=ui.getByRole('button', {name:'Cost calculation'});
  expect(button.className).toContain('decoration-dotted');
  expect(ui.queryByRole('tooltip')).toBeNull();
  fireEvent.mouseEnter(button.parentElement!);
  const tip=ui.getByRole('tooltip');
  expect(tip.textContent).toContain('Cost calculation');
  expect(tip.textContent).toContain('This thread$5.00');
  expect(tip.textContent).not.toMatch(/With children|Total with children|Child threads|All subagents/);
 });
}
it('keeps the child section when a reported child has zero cost', () => {
 const a=answer();
 a.family.children=[{threadId:'thr_child000',title:'Worker',cost:0,calls:0,running:false,model:null,estimated:false}];
 const ui=render(<CostBreakdown answer={a} scope="family">$4.82</CostBreakdown>);
 fireEvent.focus(ui.getByRole('button'));
 expect(ui.getByRole('tooltip').textContent).toContain('Child threads · 1$0.00');
 expect(ui.getByRole('tooltip').textContent).toContain('Total with children$4.82');
});

it('shows the same subtotal and family total from the own-thread amount', () => {
 const a=answer();
 a.family.children=[{threadId:'thr_child000',title:'Worker',cost:9,calls:1,running:false,model:null,estimated:false}];
 a.family.total=13.82;
 const ui=render(<CostBreakdown answer={a}>$4.82</CostBreakdown>);
 fireEvent.focus(ui.getByRole('button'));
 expect(ui.getByRole('tooltip').textContent).toContain('This thread$4.82');
 expect(ui.getByRole('tooltip').textContent).toContain('Child threads · 1$9.00');
 expect(ui.getByRole('tooltip').textContent).toContain('Total with children$13.82');
});

it('does not invent main-agent spend when native coverage is partial', () => {
 const r=buildReport([assistant(3), {...assistant(2),agentId:'native'}],null);
 r.agents!.coverage='partial';
 const ui=render(<CostBreakdown answer={answer({report:r})}>$5.00</CostBreakdown>);
 fireEvent.focus(ui.getByRole('button'));
 const text=ui.getByRole('tooltip').textContent;
 expect(text).not.toContain('Main agent');
 expect(text).toContain('Subagents (known portion)≥ $2.00');
 expect(text).toContain('This thread$5.00');
});

it('keeps the thread detail calculation free of child totals', () => {
 const report=buildReport([assistant(3), {...assistant(2),agentId:'native'}],null);
 report.agents!.coverage='available';
 const a=answer({report});
 a.family.children=[{threadId:'thr_child000',title:'Worker',cost:9,calls:1,running:false,model:null,estimated:false}];
 a.family.total=14;
 const ui=render(<CostBreakdown answer={a} scope="thread">$5.00</CostBreakdown>);
 fireEvent.focus(ui.getByRole('button'));
 const text=ui.getByRole('tooltip').textContent;
 expect(text).toContain('Main agent$3.00');
 expect(text).toContain('Its subagents$2.00');
 expect(text).toContain('This thread$5.00');
 expect(text).not.toMatch(/Child threads|Total with children|14.00/);
});

const nativeRow = {id:'native',calls:1,cost:{input:2,output:0,cacheRead:0,cacheWrite:0,total:2},estimated:false};
for (const state of ['missing','empty','partial-empty','known','partial'] as const) {
 for (const childState of ['none','plain','native'] as const) {
  for (const scope of ['thread','family','combined'] as const) {
   it(`${scope}: own agents ${state}, children ${childState}`, () => {
    const report=buildReport([assistant(5)],null);
    report.agents=state==='missing' ? undefined : {coverage:state.startsWith('partial') ? 'partial' : 'available',rows:state==='known'||state==='partial' ? [nativeRow] : []};
    const children=childState==='none' ? [] : [{threadId:'thr_child000',title:'Worker',cost:5,calls:2,running:false,model:null,estimated:false,agents:{coverage:'available' as const,rows:childState==='native' ? [{...nativeRow,id:'child-native'}] : []}}];
    const a=answer({report,family:{total:children.length ? 10 : 5,calls:3,estimated:false,children,agents:{coverage:'available',rows:children.flatMap(c=>c.agents.rows)}}});
    const own=state==='known'||state==='partial';
    const kids=childState!=='none';
    const expandable=scope==='thread' ? own : scope==='family' ? kids : own||kids;
    const ui=render(<CostBreakdown answer={a} scope={scope}>$5.00</CostBreakdown>);
    const trigger=ui.queryByRole('button');
    if (!expandable) {
     expect(trigger).toBeNull();
     expect(ui.container.innerHTML).toBe('$5.00');
     return;
    }
    expect(trigger).not.toBeNull();
    fireEvent.focus(trigger!);
    const text=ui.getByRole('tooltip').textContent!;
    expect(text).toContain('This thread$5.00');
    expect(text).not.toContain('Unavailable');
    if (scope!=='family' && own) {
     expect(text).toContain(state==='known' ? 'Its subagents$2.00' : 'Subagents (known portion)≥ $2.00');
     if(state==='known') expect(text).toContain('Main agent$3.00');
     else expect(text).not.toContain('Main agent');
    } else expect(text).not.toMatch(/Main agent|Its subagents|known portion/);
    if(scope!=='thread' && kids) {
     expect(text).toContain('Child threads · 1$5.00');
     expect(text).toContain('Total with children$10.00');
    } else expect(text).not.toMatch(/Child threads|Total with children/);
    // A child's native spend stays inside its $5 total and never enters own-agent rows.
    expect(text).not.toContain('$12.00');
   });
  }
 }
}
