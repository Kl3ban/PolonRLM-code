# p-limit repository case

This pack contains the documentation fix for the recursive limiter deadlock reported in `sindresorhus/p-limit` issue 91. The workspace files are copied from the parent commit `9bce97a` of upstream fix `24503f921c97ecaf84382d51e291e823e4024ebf`. The benchmark grader checks the README API section and the callable `LimitFunction` JSDoc, and rejects runtime or extra-file changes.

The upstream fix documents that calling the same limiter inside work already limited by it can block inner tasks, and recommends a separate limiter. The pack includes the upstream MIT license. It has no dependency setup.

Sources:

- https://github.com/sindresorhus/p-limit/issues/91
- https://github.com/sindresorhus/p-limit/commit/24503f921c97ecaf84382d51e291e823e4024ebf
- https://github.com/sindresorhus/p-limit/tree/9bce97a
