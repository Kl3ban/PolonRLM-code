import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCycleGuard } from '../src/core/tool-cycle.js';

test('tool cycle guard warns after a repeated 2-step cycle and stops when the warned cycle returns', () => {
  const guard = new ToolCycleGuard();
  const call = (tool: string, output: string) => guard.observe(tool, {}, output, false);

  assert.equal(call('read_a', 'A').notice, undefined);
  assert.equal(call('read_b', 'B').notice, undefined);
  assert.equal(call('read_a', 'A').notice, undefined);
  const warning = call('read_b', 'B');
  assert.equal(warning.stop, false);
  assert.match(warning.notice ?? '', /same 2-step tool sequence repeated twice/);

  const stopped = call('read_a', 'A');
  assert.equal(stopped.stop, true);
  assert.match(stopped.notice ?? '', /repeated again after a warning/);
});

test('different arguments or results are not treated as the same cycle; reset clears prior warnings', () => {
  const guard = new ToolCycleGuard();
  const call = (tool: string, args: Record<string, unknown>, output: string) => guard.observe(tool, args, output, false);
  call('read_a', { path: 'a' }, 'A');
  call('read_b', { path: 'b' }, 'B');
  call('read_a', { path: 'a' }, 'A');
  assert.equal(call('read_b', { path: 'b' }, 'changed').notice, undefined);

  guard.reset();
  const sequence = () => {
    call('read_a', { path: 'a' }, 'A'); call('read_b', { path: 'b' }, 'B');
    call('read_a', { path: 'a' }, 'A'); return call('read_b', { path: 'b' }, 'B');
  };
  assert.equal(sequence().stop, false);
  guard.reset();
  assert.equal(sequence().stop, false, 'verified progress should reset both history and warned-cycle state');
});

test('tool cycle guard detects a maximum-length 8-step cycle and stops at the start of its third repetition', () => {
  const guard = new ToolCycleGuard();
  const cycle = Array.from({ length: 8 }, (_, index) => [`step_${index}`, `result_${index}`] as const);
  const observed = (step: readonly [string, string]) => guard.observe(step[0], {}, step[1], false);

  for (let repetition = 0; repetition < 2; repetition++) {
    for (const step of cycle) {
      const result = observed(step);
      if (repetition === 1 && step === cycle.at(-1)) {
        assert.equal(result.stop, false);
        assert.match(result.notice ?? '', /same 8-step tool sequence repeated twice/);
      } else assert.equal(result.notice, undefined);
    }
  }
  const stopped = observed(cycle[0]!);
  assert.equal(stopped.stop, true);
  assert.match(stopped.notice ?? '', /same 8-step tool sequence repeated again after a warning/);
});

test('tool cycle guard detects a 16-step cycle within its bounded history', () => {
  const guard = new ToolCycleGuard();
  const cycle = Array.from({ length: 16 }, (_, index) => [`long_step_${index}`, `result_${index}`] as const);
  const observe = (step: readonly [string, string]) => guard.observe(step[0], {}, step[1], false);

  for (let repetition = 0; repetition < 2; repetition++) {
    for (const step of cycle) {
      const result = observe(step);
      if (repetition === 1 && step === cycle.at(-1)) {
        assert.equal(result.stop, false);
        assert.match(result.notice ?? '', /same 16-step tool sequence repeated twice/);
      } else assert.equal(result.notice, undefined);
    }
  }
  const stopped = observe(cycle[0]!);
  assert.equal(stopped.stop, true);
  assert.match(stopped.notice ?? '', /same 16-step tool sequence repeated again after a warning/);
});

test('tool cycle guard detects a 64-step cycle without retaining unbounded history', () => {
  const guard = new ToolCycleGuard();
  const cycle = Array.from({ length: 64 }, (_, index) => [`long_step_${index}`, `result_${index}`] as const);
  const observe = (step: readonly [string, string]) => guard.observe(step[0], {}, step[1], false);

  for (let repetition = 0; repetition < 2; repetition++) {
    for (const [index, step] of cycle.entries()) {
      const result = observe(step);
      if (repetition === 1 && index === cycle.length - 1) {
        assert.equal(result.stop, false);
        assert.match(result.notice ?? '', /same 64-step tool sequence repeated twice/);
      } else assert.equal(result.notice, undefined);
    }
  }
  const stopped = observe(cycle[0]!);
  assert.equal(stopped.stop, true);
  assert.match(stopped.notice ?? '', /same 64-step tool sequence repeated again after a warning/);
});
