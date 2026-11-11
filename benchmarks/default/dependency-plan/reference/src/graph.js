import { validateTasks } from './validate.js';
export function buildWaves(tasks) {
  validateTasks(tasks);
  const remaining = new Set(tasks.map(task => task.id));
  const completed = new Set();
  const waves = [];
  while (remaining.size) {
    const wave = tasks.filter(task => remaining.has(task.id) && (task.dependsOn ?? []).every(id => completed.has(id))).map(task => task.id);
    if (!wave.length) throw new Error('dependency cycle');
    waves.push(wave);
    for (const id of wave) { remaining.delete(id); completed.add(id); }
  }
  return waves;
}
