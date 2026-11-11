import { safeText } from './secrets.js';

const names: Record<string, string> = {
  discover_tools: 'Tool discovery', web_search: 'Web search', read_webpage: 'Read webpage', fetch_webpage: 'Read webpage', fetch_documentation: 'Read documentation', download_to_disk: 'Download file', github_repo_inspector: 'GitHub repository',
  browser: 'Browser', browser_sessions: 'Browser sessions', browser_automation: 'Browser', computer_use: 'Desktop control',
  read_file: 'Read file', read_files: 'Read files', write_file: 'Write file', edit_file: 'Edit file', apply_patch: 'Edit code',
  search_files: 'Find files', search_content: 'Search code', search_batch: 'Search project', list_directory: 'List files', inspect_project: 'Inspect project', project_map: 'Map project',
  execute_command: 'Terminal command', execute_powershell: 'PowerShell', execute_python: 'Python', run_tests: 'Run tests', request_tool: 'Tool approval request',
};
export const toolDisplayName = (name: string): string => names[name] ?? safeText(name.replace(/_/g, ' '));
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const action = typeof args.action === 'string' ? args.action : '';
  const detail = name === 'request_tool' ? args.tool : ['browser', 'computer_use', 'browser_automation'].includes(name)
    ? [action, args.url ?? args.selector ?? args.windowId ?? args.sessionId].filter(value => value !== undefined).join(' · ')
    : args.query ?? args.url ?? args.repo_url ?? args.path ?? args.command ?? '';
  return safeText(`${toolDisplayName(name)}${detail ? `: ${String(detail).replace(/\s+/g, ' ')}` : ''}`).slice(0, 150);
}
