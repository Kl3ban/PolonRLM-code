"""Run with the prepared Python runtime, or: uv run --script local_web_tool.py."""
import json
from pathlib import Path
import subprocess
import sys

request = {'tool': 'web_search', 'arguments': {'query': 'Python asyncio documentation', 'max_results': 6}}
result = subprocess.run([sys.executable, str(Path(__file__).with_name('local_web_tool.py'))], input=json.dumps(request), capture_output=True, text=True, encoding='utf-8', timeout=45)
data = json.loads(result.stdout)
if result.returncode:
    raise RuntimeError(data['error']['message'])
print(json.dumps(data, ensure_ascii=False, indent=2))
