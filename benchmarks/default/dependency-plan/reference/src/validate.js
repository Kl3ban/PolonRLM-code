export function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id.trim()) throw new TypeError('task id must be a non-empty string');
    if (ids.has(task.id)) throw new Error('duplicate task id');
    ids.add(task.id);
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new TypeError('dependsOn must be an array');
  }
  for (const task of tasks) {
    const dependencies = task.dependsOn ?? [];
    const seen = new Set();
    for (const id of dependencies) {
      if (typeof id !== 'string' || !id.trim()) throw new TypeError('dependency id must be a non-empty string');
      if (seen.has(id)) throw new Error('duplicate dependency');
      if (id === task.id) throw new Error('self dependency');
      if (!ids.has(id)) throw new Error('unknown dependency');
      seen.add(id);
    }
  }
  return tasks;
}
