export function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  return tasks;
}
