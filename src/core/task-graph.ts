export interface TaskGraphNode<T extends { id?: string; dependsOn?: string[] }> {
  id: string;
  dependsOn: string[];
  task: T;
}

/** Normalize task IDs and return stable topological waves; reject ambiguous or cyclic graphs. */
export function taskGraphWaves<T extends { id?: string; dependsOn?: string[] }>(tasks: readonly T[]): TaskGraphNode<T>[][] {
  const reserved = new Set(tasks.flatMap(task => task.id ? [task.id] : []));
  const generated = new Set<string>();
  const nodes = tasks.map((task, index) => ({
    id: task.id ?? nextGeneratedId(index + 1, reserved, generated),
    dependsOn: task.dependsOn ?? [],
    task,
  }));
  const byId = new Map<string, TaskGraphNode<T>>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate task ID: ${node.id}.`);
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error(`Task ${node.id} lists a dependency more than once.`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) throw new Error(`Task ${node.id} cannot depend on itself.`);
      if (!byId.has(dependency)) throw new Error(`Task ${node.id} depends on unknown task ${dependency}.`);
    }
  }

  const completed = new Set<string>();
  const remaining = new Set(nodes.map(node => node.id));
  const waves: TaskGraphNode<T>[][] = [];
  while (remaining.size) {
    const ready = nodes.filter(node => remaining.has(node.id) && node.dependsOn.every(id => completed.has(id)));
    if (!ready.length) throw new Error(`Task graph contains a dependency cycle: ${[...remaining].join(', ')}.`);
    waves.push(ready);
    for (const node of ready) { remaining.delete(node.id); completed.add(node.id); }
  }
  return waves;
}

function nextGeneratedId(index: number, reserved: ReadonlySet<string>, generated: Set<string>): string {
  let suffix = 0;
  while (true) {
    const id = `task-${index}${suffix ? `-${suffix}` : ''}`;
    if (!reserved.has(id) && !generated.has(id)) { generated.add(id); return id; }
    suffix++;
  }
}
