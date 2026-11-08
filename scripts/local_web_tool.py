# /// script
# requires-python = ">=3.11"
# dependencies = ["curl_cffi==0.17.0", "trafilatura==2.3.1", "rank-bm25==0.2.2", "pydantic==2.14.3"]
# ///
"""One stdin JSON request -> one compact JSON result -> process exit. No server."""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
import html
import ipaddress
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import sys
import tempfile
import uuid
import unicodedata
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

from curl_cffi import CurlOpt
from curl_cffi.requests import AsyncSession
from lxml import html as html_parser
from pydantic import BaseModel, ConfigDict, Field, ValidationError

HTML_LIMIT = 5_000_000
FILE_LIMIT = 100_000_000
SEARCH_BYTES = 1200
READ_BYTES = 3600
REQUEST_ID = uuid.uuid4().hex


class WebError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def clean(text: str) -> str:
    return ''.join(c for c in text if c in '\n\t' or (unicodedata.category(c) not in ('Cc', 'Cf', 'Cs') and c not in '\u2028\u2029'))


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def byte_clip(text: str, maximum: int) -> str:
    return text.encode('utf-8')[:max(0, maximum)].decode('utf-8', errors='ignore')


def public_ip(value: str) -> bool:
    address = ipaddress.ip_address(value.split('%')[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return public_ip(str(address.ipv4_mapped))
    if not address.is_global or address.is_multicast or address.is_reserved or address.is_unspecified:
        return False
    if isinstance(address, ipaddress.IPv6Address) and any(address in ipaddress.ip_network(prefix) for prefix in ('2001::/23', '2001:db8::/32', '2002::/16', '64:ff9b::/96')):
        return False
    return True


def validate_url(value: str) -> tuple[str, str, int]:
    if re.search(r'[\x00-\x20\x7f\\]', value):
        raise WebError('URL', 'The address contains invalid characters.')
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise WebError('URL', 'A public HTTP(S) URL is required, without embedded credentials.')
    try:
        host = parsed.hostname.encode('idna').decode('ascii').rstrip('.')
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except (ValueError, UnicodeError) as error:
        raise WebError('URL', 'Invalid domain or port.') from error
    if host.lower() in ('localhost', 'localhost.localdomain') or host.endswith('.localhost'):
        raise WebError('SSRF', 'Local addresses are blocked.')
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, '')), host, port


async def pinned_target(value: str) -> tuple[str, str]:
    url, host, port = validate_url(value)
    try:
        answers = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM), 5)
    except (OSError, TimeoutError) as error:
        raise WebError('DNS', 'Could not resolve a public domain address.') from error
    addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
    if not addresses or any(not public_ip(address) for address in addresses):
        raise WebError('SSRF', 'The DNS target is local, private, or reserved.')
    # Prefer IPv4 where available; preserve the original host for TLS and HTTP Host.
    selected = next((a for a in addresses if ':' not in a), addresses[0])
    resolved = f'[{selected}]' if ':' in selected else selected
    return url, f'{host}:{port}:{resolved}'


@asynccontextmanager
async def open_public(url: str, *, binary: bool = False):
    for _ in range(6):
        target, resolve = await pinned_target(url)
        async with AsyncSession(impersonate='chrome124', timeout=(5, 15), trust_env=False,
                                curl_options={CurlOpt.RESOLVE: [resolve], CurlOpt.PROXY: ''}) as session:
            response = await session.get(target, allow_redirects=False, stream=True,
                                         headers={'Accept-Encoding': 'identity'} if binary else None)
            try:
                if 300 <= response.status_code < 400 and response.headers.get('location'):
                    url = urljoin(target, response.headers['location'])
                    continue
                if response.status_code >= 400:
                    raise WebError('HTTP', f'HTTP {response.status_code}.')
                if response.status_code not in (200, 201, 202, 203, 204, 206):
                    raise WebError('HTTP', f'Unsupported HTTP status {response.status_code}.')
                yield response, target
                return
            finally:
                await response.aclose()
    raise WebError('REDIRECT', 'The redirect limit of five was exceeded.')


async def chunks(response, maximum: int):
    advertised = response.headers.get('content-length', '')
    if advertised.isdigit() and int(advertised) > maximum:
        raise WebError('SIZE', f'The file exceeds the {maximum}-byte limit.')
    total = 0
    iterator = response.aiter_content().__aiter__()
    while True:
        try:
            data = await asyncio.wait_for(iterator.__anext__(), 15)
        except StopAsyncIteration:
            return
        total += len(data)
        if total > maximum:
            raise WebError('SIZE', f'The {maximum}-byte limit was exceeded; download stopped.')
        yield data


async def fetch_text(url: str) -> tuple[str, str, str]:
    async with open_public(url) as (response, final_url):
        data = bytearray()
        async for part in chunks(response, HTML_LIMIT):
            data.extend(part)
        content_type = response.headers.get('content-type', '')
        charset = re.search(r'charset=([\w-]+)', content_type, re.I)
        try:
            text = data.decode(charset[1] if charset else 'utf-8', errors='replace')
        except LookupError:
            text = data.decode('utf-8', errors='replace')
        return text, final_url, content_type


def canonical_url(value: str, origin: str) -> str | None:
    try:
        url = urljoin(origin, value.replace('&amp;', '&'))
        parsed = urlsplit(url)
        if parsed.hostname and parsed.hostname.lower().endswith('bing.com') and parsed.path == '/ck/a':
            encoded = parse_qs(parsed.query).get('u', [''])[0]
            if encoded.startswith('a1'):
                payload = encoded[2:]
                try:
                    decoded = base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)).decode('utf-8', errors='strict')
                except (ValueError, UnicodeError):
                    return None
                if decoded.startswith(('http://', 'https://')):
                    url = decoded
            parsed = urlsplit(url)
        if parsed.hostname and parsed.hostname.lower().endswith('.search.yahoo.com'):
            redirect = re.search(r'(?:^|/)RU=(.+?)(?:/RK=|$)', parsed.path)
            if redirect:
                candidate = unquote(redirect.group(1))
                if candidate.startswith(('http://', 'https://')):
                    url = candidate
                    parsed = urlsplit(url)
        url, host, _ = validate_url(url)
        if host.lower().removeprefix('www.') in ('bing.com', 'google.com', 'yahoo.com') or host.lower().endswith('.search.yahoo.com') or host.lower() == 'search.brave.com':
            return None
        params = [(key, value) for key, values in parse_qs(parsed.query, keep_blank_values=True).items() for value in values if not re.match(r'^(utm_|fbclid$|gclid$)', key, re.I)]
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', urlencode(params), ''))
    except (ValueError, WebError):
        return None


def parse_search(page: str, engine: str) -> list[dict[str, str]]:
    if re.search(r'anomaly\.js|challenge-form|cf-chl-|verify you are human|unusual traffic from your network|captcha-container', page, re.I):
        raise WebError('CHALLENGE', f'{engine}: the page requires verification; CAPTCHA is not bypassed.')
    tree = html_parser.fromstring(page)
    origin = {'bing': 'https://www.bing.com', 'brave': 'https://search.brave.com', 'yahoo': 'https://search.yahoo.com'}[engine]
    if engine == 'bing':
        anchors = tree.xpath('//li[contains(concat(" ",normalize-space(@class)," ")," b_algo ")]//h2/a[@href]')
    elif engine == 'brave':
        anchors = tree.xpath('//a[@href][.//h3 or .//*[contains(concat(" ",normalize-space(@class)," ")," title ")] or contains(concat(" ",normalize-space(@class)," ")," heading-serpresult ")]')
    else:
        anchors = tree.xpath('//div[contains(concat(" ",normalize-space(@class)," ")," algo ")]//h3/ancestor::a[1][@href]')
    results = []
    for anchor in anchors:
        url = canonical_url(anchor.get('href', ''), origin)
        if not url:
            continue
        if anchor.xpath('ancestor::*[contains(concat(" ",normalize-space(@class)," ")," ad ") or contains(@class,"b_ad") or @data-type="ad" or @data-type="sponsored"]'):
            continue
        title_nodes = anchor.xpath('.//h3 | .//*[contains(concat(" ",normalize-space(@class)," ")," title ")]')
        title = ' '.join((title_nodes[0] if title_nodes else anchor).itertext())
        snippet = ''
        if engine == 'bing':
            blocks = anchor.xpath('ancestor::li[contains(concat(" ",normalize-space(@class)," ")," b_algo ")][1]')
            descriptions = blocks[0].xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," b_caption ")]//p | .//p') if blocks else []
            if descriptions:
                snippet = ' '.join(descriptions[0].itertext())
        elif engine == 'brave':
            parents = anchor.xpath('ancestor::*[contains(concat(" ",normalize-space(@class)," ")," snippet ") or @data-type="web"][1]')
            if parents:
                descriptions = parents[0].xpath('.//*[contains(@class,"description") or contains(concat(" ",normalize-space(@class)," ")," snippet-description ")] | .//p')
                snippet = ' '.join((descriptions[0] if descriptions else parents[0]).itertext()).replace(title, '')
        else:
            parents = anchor.xpath('ancestor::div[contains(concat(" ",normalize-space(@class)," ")," algo ")][1]')
            descriptions = parents[0].xpath('.//p') if parents else []
            if descriptions:
                snippet = ' '.join(descriptions[0].itertext()).replace(title, '')
        title = re.sub(r'\s+', ' ', clean(title)).strip()[:100]
        snippet = re.sub(r'\s+', ' ', clean(snippet)).strip()[:180]
        if title:
            results.append({'title': title, 'url': url, 'snippet': snippet})
    return results


def fit_search(results: list[dict[str, str]], maximum: int) -> list[dict[str, str]]:
    selected = []
    for candidate in results:
        if len(selected) >= maximum:
            break
        row = dict(candidate)
        # URLs are never cut. Shrink prose or return fewer results to honor the output budget.
        while len(compact(selected + [row]).encode('utf-8')) > SEARCH_BYTES and row['snippet']:
            row['snippet'] = row['snippet'][:-8]
        if len(compact(selected + [row]).encode('utf-8')) <= SEARCH_BYTES:
            selected.append(row)
    return selected


class Args(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class SearchArgs(Args):
    query: str = Field(min_length=1, max_length=500)
    max_results: int = Field(default=6, ge=1, le=10)
    source: str = Field(default='auto', pattern='^(auto|bing|brave|yahoo)$')


async def web_search(args: SearchArgs):
    async def engine(name):
        if name == 'bing':
            url = 'https://www.bing.com/search?' + urlencode({'q': args.query})
        elif name == 'brave':
            url = 'https://search.brave.com/search?' + urlencode({'q': args.query})
        else:
            url = 'https://search.yahoo.com/search?' + urlencode({'p': args.query})
        page, _, _ = await fetch_text(url)
        return parse_search(page, name)
    engines = ['bing', 'brave', 'yahoo'] if args.source == 'auto' else [args.source]
    tasks = [asyncio.create_task(engine(name)) for name in engines]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    responses = [task.exception() if task.exception() else task.result() for task in done]
    if pending:
        # Both searches start in parallel. A slow secondary source must not hold up useful results.
        if any(isinstance(response, list) and response for response in responses):
            more, pending = await asyncio.wait(pending, timeout=0.8)
            responses.extend(task.exception() if task.exception() else task.result() for task in more)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        else:
            responses.extend(await asyncio.gather(*pending, return_exceptions=True))
    lists = [response for response in responses if isinstance(response, list)]
    merged, seen = [], set()
    for rank in range(max((len(items) for items in lists), default=0)):
        for items in lists:
            if rank < len(items) and items[rank]['url'] not in seen:
                seen.add(items[rank]['url']); merged.append(items[rank])
    if not merged:
        reasons = '; '.join(str(response)[:160] for response in responses if isinstance(response, Exception))
        raise WebError('SEARCH', 'No search results are available. ' + reasons)
    from rank_bm25 import BM25Okapi
    tokenize = lambda value: re.findall(r'[\w]+', value.casefold())
    query_terms = tokenize(args.query)
    if query_terms and merged:
        corpus = [tokenize(item['title'] + ' ' + item['snippet'] + ' ' + item['url']) or ['_'] for item in merged]
        scores = BM25Okapi(corpus).get_scores(query_terms)
        merged = [item for _, item in sorted(zip(scores, merged), key=lambda pair: float(pair[0]), reverse=True)]
    fitted = fit_search(merged, args.max_results)
    if not fitted:
        raise WebError('SEARCH_SIZE', 'Result URLs exceed the compact output budget. Narrow the query.')
    return fitted


class ReadArgs(Args):
    url: str = Field(min_length=8, max_length=8000)
    focus_query: str | None = Field(default=None, max_length=500)


def github_raw(url: str) -> tuple[str, bool]:
    parsed = urlsplit(url)
    parts = parsed.path.strip('/').split('/')
    if parsed.hostname in ('github.com', 'www.github.com') and len(parts) >= 5 and parts[2] == 'blob':
        return 'https://raw.githubusercontent.com/' + '/'.join(parts[:2] + parts[3:]), True
    return url, parsed.hostname == 'raw.githubusercontent.com'


def compact_headings(headings) -> list[str]:
    result, size = [], 0
    for heading in headings:
        title = byte_clip(heading, 140)
        length = len(title.encode('utf-8'))
        if len(result) >= 24 or size + length > 600:
            break
        result.append(title); size += length
    return result


def focus_content(text: str, query: str | None) -> dict:
    if len(text.encode('utf-8')) <= READ_BYTES:
        return {'content': text, 'truncated': False, 'other_headings': []}
    sections: list[tuple[str, str]] = []
    heading, body = 'Start', []
    for line in text.splitlines():
        if re.match(r'^#{1,6}\s+', line):
            if body:
                sections.append((heading, '\n'.join(body)))
            heading, body = line, []
        else:
            body.append(line)
    if body:
        sections.append((heading, '\n'.join(body)))
    # Long documents without headings (including source files) are bounded line chunks.
    if len(sections) < 2:
        lines = text.splitlines(); sections = [(f'Wiersze {i + 1}–{min(i + 80, len(lines))}', '\n'.join(lines[i:i + 80])) for i in range(0, len(lines), 80)]
    if query and sections:
        from rank_bm25 import BM25Okapi
        tokenize = lambda value: re.findall(r'\w+', value.casefold())
        corpus = [tokenize(title + '\n' + content) or ['_'] for title, content in sections]
        scores = BM25Okapi(corpus).get_scores(tokenize(query))
        chosen = sorted(sorted(range(len(sections)), key=lambda i: (float(scores[i]), -i), reverse=True)[:3])
        allowance = max(200, (READ_BYTES - 400) // max(1, len(chosen)))
        content = '\n\n'.join(title + '\n' + byte_clip(body, allowance) for i, (title, body) in enumerate(sections) if i in chosen)
        toc = compact_headings(title for i, (title, _) in enumerate(sections) if i not in chosen)
        return {'content': byte_clip(content, READ_BYTES), 'truncated': True, 'other_headings': toc, 'selection': 'BM25; maksymalnie trzy sekcje'}
    return {'content': byte_clip(text, READ_BYTES), 'truncated': True, 'other_headings': compact_headings(title for title, _ in sections), 'hint': 'Provide focus_query to select relevant sections.'}


async def read_webpage(args: ReadArgs):
    validate_url(args.url)
    url, raw = github_raw(args.url)
    for _ in range(4):
        text, final_url, mime = await fetch_text(url)
        redirect = None
        if not raw and ('html' in mime or re.match(r'\s*<!doctype\s+html', text, re.I)):
            # A quoted example in documentation is not a browser redirect.
            visible_probe = re.sub(r'<(script|style)\b[^>]*>[\s\S]*?</\1>', '', text, flags=re.I)
            visible_probe = re.sub(r'<[^>]+>', '', visible_probe).strip()
            if len(text) < 16000 and len(visible_probe) < 120 and not re.search(r'<(?:article|main|pre|code)\b', text, re.I):
                scripts = '\n'.join(re.findall(r'<script\b[^>]*>([\s\S]*?)</script>', text, re.I))
                redirect = re.search(r'(?:window\.)?location(?:\.href)?\s*=\s*["\']([^"\'<>]{1,4000})["\']', scripts)
            if not redirect:
                redirect = re.search(r'<meta[^>]*http-equiv\s*=\s*["\']?refresh["\']?[^>]*content\s*=\s*["\'][^"\']*?url\s*=\s*([^"\'<>]{1,4000})', text, re.I)
        if not redirect:
            break
        url = urljoin(final_url, html.unescape(redirect[1].strip()))
        validate_url(url)
    extraction = 'raw' if raw else 'text'
    if not raw and (re.search(r'application/(?:pdf|zip|octet-stream)|^image/|^audio/|^video/', mime) or text.startswith('%PDF-')):
        raise WebError('BINARY', 'This is a binary file. Use download_to_disk, then the local read_document tool instead of reading it as a webpage.')
    if not raw and ('html' in mime or text.lstrip().startswith(('<!DOCTYPE', '<html', '<HTML'))):
        import trafilatura
        if re.search(r'cf-chl-|challenge-form|<title[^>]*>\s*(?:Just a moment|Access denied|CAPTCHA)', text, re.I):
            raise WebError('CHALLENGE', 'The page requires human verification or blocks automated reading.')
        extracted = trafilatura.extract(text, url=final_url, output_format='markdown', include_comments=False, include_links=True, include_images=False, favor_precision=True)
        extraction = 'article'
        title_match = re.search(r'<title[^>]*>([^<]{1,500})</title>', text, re.I)
        if extracted and title_match and html.unescape(title_match[1]).strip() not in extracted[:600]:
            extracted = '# ' + html.unescape(title_match[1]).strip() + '\n\n' + extracted
        if not extracted:
            # Short landing pages are often useful but do not satisfy article heuristics.
            tree = html_parser.fromstring(text)
            titles = tree.xpath('//title/text()')
            descriptions = tree.xpath('//meta[translate(@name,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="description" or @property="og:description"]/@content')
            for element in tree.xpath('//script|//style|//nav|//footer|//header|//aside|//svg|//img|//noscript|//*[@hidden or @aria-hidden="true" or contains(translate(@style," ",""),"display:none")]'):
                if element.getparent() is not None:
                    element.getparent().remove(element)
            bodies = tree.xpath('//main|//article') or tree.xpath('//body')
            visible = '\n'.join(line.strip() for body in bodies[:3] for line in body.text_content().splitlines() if line.strip())
            extracted = '\n\n'.join([*('# ' + title.strip() for title in titles[:1]), *descriptions[:1], visible]).strip()
            extraction = 'visible text; no typical article structure, so available content may be limited'
        text = extracted
    if not text.strip():
        return {'url': final_url, 'untrusted': True, 'readable': False, 'content': '', 'notice': 'No readable content is available for verification. The page may require JavaScript or a login. Do not treat it as evidence; use another source or explain that evidence is unavailable.'}
    text = clean(text)
    return {'url': final_url, 'untrusted': True, 'readable': True, 'extraction': extraction, **focus_content(text, args.focus_query)}


class DownloadArgs(Args):
    url: str = Field(min_length=8, max_length=8000)
    save_filename: str | None = Field(default=None, min_length=1, max_length=150)


def download_directory() -> Path:
    root = Path.cwd().resolve()
    current = root
    for part in ('agent_workspace', 'downloads'):
        current = current / part
        if current.is_symlink() or (current.exists() and (not current.is_dir() or getattr(current.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)):
            raise WebError('PATH', 'The downloads directory cannot be a symlink or a file.')
        current.mkdir(exist_ok=True)
        if not current.resolve().is_relative_to(root):
            raise WebError('PATH', 'The downloads directory resolves outside the workspace.')
    return current.resolve()


def safe_filename(value: str) -> str:
    if value != Path(value).name or re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', value) or any(unicodedata.category(c) in ('Cc', 'Cf', 'Cs') for c in value) or value in ('.', '..') or value.endswith(('.', ' ')) or re.match(r'^(con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)', value, re.I):
        raise WebError('PATH', 'Provide a safe filename only, without directories or Windows device names.')
    return value


async def download_to_disk(args: DownloadArgs):
    await pinned_target(args.url)
    filename = safe_filename(args.save_filename or unquote(urlsplit(args.url).path.rsplit('/', 1)[-1])[:120] or 'download.bin')
    directory = download_directory()
    fd, temporary = tempfile.mkstemp(prefix=f'.download-{REQUEST_ID}-', dir=directory)
    total, digest = 0, hashlib.sha256()
    try:
        with os.fdopen(fd, 'wb') as output:
            async with open_public(args.url, binary=True) as (response, _):
                mime = response.headers.get('content-type', 'application/octet-stream').split(';')[0]
                buffer = bytearray()
                async for data in chunks(response, FILE_LIMIT):
                    buffer.extend(data)
                    while len(buffer) >= 65536:
                        block = bytes(buffer[:65536]); del buffer[:65536]
                        output.write(block); digest.update(block); total += len(block)
                if buffer:
                    output.write(buffer); digest.update(buffer); total += len(buffer)
            output.flush(); os.fsync(output.fileno())
        if download_directory() != directory:
            raise WebError('PATH', 'The downloads directory changed during the operation.')
        base = Path(filename)
        for index in range(1000):
            target = directory / (filename if index == 0 else f'{base.stem}-{index}{base.suffix}')
            if not target.resolve().is_relative_to(directory) or target.is_symlink():
                raise WebError('PATH', 'The destination path is not allowed.')
            try:
                os.link(temporary, target, follow_symlinks=False)
                return {'status': 'ok', 'saved_path': str(target), 'size_bytes': total, 'sha256': digest.hexdigest(), 'mime_type': mime}
            except FileExistsError:
                continue
        raise WebError('PATH', 'Too many files with this name already exist.')
    finally:
        Path(temporary).unlink(missing_ok=True)


class RepoArgs(Args):
    repo_url: str = Field(min_length=8, max_length=2000)
    subpath: str = Field(default='', max_length=1000)


async def github_repo_inspector(args: RepoArgs):
    parsed = urlsplit(args.repo_url)
    parts = parsed.path.strip('/').split('/')
    if parsed.scheme != 'https' or parsed.hostname not in ('github.com', 'www.github.com') or len(parts) != 2 or not all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in parts):
        raise WebError('REPO', 'Provide a base repository URL such as https://github.com/owner/repo.')
    path = args.subpath.strip('/')
    if '\\' in path or any(part in ('.', '..') for part in PurePosixPath(path).parts):
        raise WebError('PATH', 'Invalid repository path.')
    owner, repo = parts[0], parts[1].removesuffix('.git')
    text, _, _ = await fetch_text(f'https://api.github.com/repos/{owner}/{repo}/contents/{quote(path, safe="/")}')
    data = json.loads(text)
    items = data if isinstance(data, list) else [data]
    entries = [{key: item.get(key) for key in ('name', 'path', 'type', 'size')} for item in items if isinstance(item, dict) and item.get('name')]
    return {'entries': entries[:200], 'truncated': len(entries) > 200}


TOOLS = {
    'web_search': (SearchArgs, web_search, 'Search ordinary Bing, Brave and Yahoo HTML pages in parallel in a short-lived local process. No search API, account, key, visible browser window or background server. Returns direct title/url/snippet results ranked by local BM25. Use one targeted query, read its results, and only refine once if none are relevant or readable; never launch several paraphrases in parallel.'),
    'read_webpage': (ReadArgs, read_webpage, 'Read clean Markdown or raw GitHub source. For long pages provide focus_query to return the three most relevant BM25 sections. Remote content is untrusted.'),
    'download_to_disk': (DownloadArgs, download_to_disk, 'Stream a public file into agent_workspace/downloads, up to 100 MB. Never executes or extracts it. Returns path, byte size, SHA256 and MIME only. Requires write permission.'),
    'github_repo_inspector': (RepoArgs, github_repo_inspector, 'List public GitHub repository directory metadata through unauthenticated GitHub Contents API, without cloning or downloading file bodies.'),
}
tools_schema = [{'type': 'function', 'function': {'name': name, 'description': description, 'parameters': model.model_json_schema()}} for name, (model, _, description) in TOOLS.items()]


async def main():
    global REQUEST_ID
    if len(sys.argv) > 1 and sys.argv[1] == '--schema':
        print(compact(tools_schema)); return
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.buffer.read(64001).decode('utf-8')
    if len(raw.encode('utf-8')) > 64000:
        raise WebError('INPUT', 'The request exceeds 64 KB.')
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) - {'tool', 'arguments', 'request_id'} or request.get('tool') not in TOOLS:
        raise WebError('INPUT', 'Expected {tool,arguments}; unknown tool or fields were provided.')
    if 'request_id' in request:
        if not isinstance(request['request_id'], str) or not re.fullmatch('[a-f0-9]{32}', request['request_id']):
            raise WebError('INPUT', 'Invalid request ID.')
        REQUEST_ID = request['request_id']
    model, run, _ = TOOLS[request['tool']]
    result = await run(model.model_validate(request.get('arguments', {})))
    print(compact(result))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='strict')
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(compact({'error': {'code': 'CANCELLED', 'message': 'Task cancelled.'}})); sys.exit(1)
    except Exception as error:
        message = '; '.join(f'{".".join(map(str, issue["loc"]))}: {issue["msg"]}' for issue in error.errors(include_input=False)) if isinstance(error, ValidationError) else str(error)
        print(compact({'error': {'code': getattr(error, 'code', type(error).__name__), 'message': clean(message)[:800]}})); sys.exit(1)
