import { validateTasks } from './validate.js';

export function buildWaves(tasks) {
  validateTasks(tasks);
  return tasks.map(task => [task.id]);
}
