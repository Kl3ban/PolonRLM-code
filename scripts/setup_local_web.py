"""Install the on-demand web worker into the user's private runtime directory."""
import os
from pathlib import Path
import subprocess
import sys
import venv

if sys.version_info < (3, 11):
    raise SystemExit('Python 3.11+ is required.')
base = Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'PolonRLM' / 'web-runtime'
venv.EnvBuilder(with_pip=True).create(base)
python = base / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
requirements = Path(__file__).with_name('local-web-requirements.lock.txt')
if not requirements.exists():
    requirements = Path(__file__).with_name('local-web-requirements.txt')
subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(requirements)], check=True)
print(str(python))
