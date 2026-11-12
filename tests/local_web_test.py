import asyncio
from contextlib import asynccontextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('local_web_tool', Path(__file__).resolve().parents[1] / 'scripts/local_web_tool.py')
web = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = web
spec.loader.exec_module(web)


class Response:
    def __init__(self, parts=(), status=200, headers=None):
        self.parts, self.status_code, self.headers, self.closed = parts, status, headers or {}, False
    async def aiter_content(self):
        for part in self.parts:
            yield part
    async def aclose(self):
        self.closed = True


class LocalWebTests(unittest.IsolatedAsyncioTestCase):
    def test_address_policy(self):
        for address in ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.1.2', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1']:
            self.assertFalse(web.public_ip(address), address)
        self.assertTrue(web.public_ip('8.8.8.8'))
        self.assertTrue(web.public_ip('2606:4700:4700::1111'))

    def test_unsafe_urls(self):
        for url in ['file:///etc/passwd', 'http://localhost/a', 'https://user:password@example.org', 'http://example.org/\nvalue', 'http://example.org\\@localhost']:
            with self.assertRaises(web.WebError):
                web.validate_url(url)

    async def test_mixed_dns_answers_are_rejected(self):
        answers = [(2, 1, 6, '', ('8.8.8.8', 443)), (2, 1, 6, '', ('127.0.0.1', 443))]
        with patch.object(web.socket, 'getaddrinfo', return_value=answers):
            with self.assertRaisesRegex(web.WebError, 'DNS'):
                await web.pinned_target('https://public.example/')

    async def test_redirect_checks_dns_again_and_pins_the_actual_connection(self):
        sessions, requests = [], []
        class Session:
            def __init__(self, **kwargs): sessions.append(kwargs)
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            async def get(self, url, **kwargs):
                requests.append((url, kwargs))
                return Response(status=302, headers={'location': 'http://127.0.0.1/private'})
        def lookup(host, *args): return [(2, 1, 6, '', ('127.0.0.1' if host == '127.0.0.1' else '8.8.8.8', 443))]
        with patch.object(web, 'AsyncSession', Session), patch.object(web.socket, 'getaddrinfo', side_effect=lookup):
            with self.assertRaises(web.WebError):
                async with web.open_public('https://public.example/'):
                    self.fail('must not follow to loopback')
        self.assertEqual(len(requests), 1)
        self.assertFalse(requests[0][1]['allow_redirects'])
        self.assertEqual(sessions[0]['curl_options'][web.CurlOpt.RESOLVE], ['public.example:443:8.8.8.8'])
        self.assertFalse(sessions[0]['trust_env'])

    async def test_stream_limit_counts_real_bytes(self):
        with self.assertRaisesRegex(web.WebError, 'limit'):
            async for _ in web.chunks(Response([b'a' * 64, b'b' * 40]), 100):
                pass

    def test_search_parsing_direct_urls_and_snippets(self):
        target = 'https://example.org/doc?utm_source=bing'
        tracker = 'a1' + web.base64.urlsafe_b64encode(target.encode()).decode().rstrip('=')
        page = f'<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u={tracker}&amp;ptn=3"><strong>Bing</strong> title</a></h2><div class="b_caption"><p>{"Useful description. " * 20}</p></div></li></ol>'
        result = web.parse_search(page, 'bing')
        self.assertEqual(result[0]['url'], 'https://example.org/doc')
        self.assertEqual(result[0]['title'], 'Bing title')
        self.assertLessEqual(len(result[0]['snippet']), 180)
        brave = '<div class="snippet"><a href="https://example.org/b"><h3>Brave result</h3></a><p class="snippet-description">Useful description</p></div>'
        self.assertEqual(web.parse_search(brave, 'brave')[0]['snippet'], 'Useful description')
        yahoo = '<div class="dd algo"><a href="https://rd.search.yahoo.com/x/RU=https%3A%2F%2Fdocs.example.org%2Fasyncio/RK=abc"><h3>Asyncio runners — Python documentation</h3></a><p>asyncio.run was added in Python 3.7.</p></div>'
        yahoo_result = web.parse_search(yahoo, 'yahoo')[0]
        self.assertEqual(yahoo_result['url'], 'https://docs.example.org/asyncio')
        self.assertEqual(yahoo_result['snippet'], 'asyncio.run was added in Python 3.7.')

    async def test_auto_search_uses_local_bing_brave_and_yahoo_pages_without_an_api(self):
        bing_target = 'https://docs.example.org/guide'
        tracking = 'a1' + web.base64.urlsafe_b64encode(bing_target.encode()).decode().rstrip('=')
        yahoo_target = 'https://docs.example.org/asyncio-runner'
        yahoo_redirect = 'https://rd.search.yahoo.com/x/RU=' + web.quote(yahoo_target, safe='') + '/RK=abc'
        pages = {
            'bing.com': f'<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u={tracking}">Netflix best shows</a></h2><div class="b_caption"><p>Unrelated entertainment results.</p></div></li>',
            'search.brave.com': '<div class="snippet"><a href="https://example.org/source"><h3>Brave source</h3></a><p class="snippet-description">Second independent result.</p></div>',
            'search.yahoo.com': f'<div class="dd algo"><a href="{yahoo_redirect}"><h3>Asyncio runners — Python documentation</h3></a><p>asyncio.run is documented here.</p></div>',
        }
        requests = []
        async def fetch(url):
            requests.append(url)
            engine = 'bing.com' if 'bing.com' in url else 'search.brave.com' if 'search.brave.com' in url else 'search.yahoo.com'
            return pages[engine], url, 'text/html'
        with patch.object(web, 'fetch_text', side_effect=fetch):
            results = await web.web_search(web.SearchArgs(query='asyncio Python documentation', source='auto'))
        self.assertEqual({urlsplit(url).hostname for url in requests}, {'www.bing.com', 'search.brave.com', 'search.yahoo.com'})
        self.assertEqual(results[0]['url'], yahoo_target)
        self.assertEqual({item['url'] for item in results}, {bing_target, 'https://example.org/source', yahoo_target})
        with self.assertRaises(web.ValidationError):
            web.SearchArgs(query='local search', source='duckduckgo')

    def test_documentation_intent_promotes_relevant_reference_pages(self):
        results = [
            {'title': 'Rust Standard Library: Vec - by Will - Rusting', 'url': 'https://rusting.substack.com/p/rust-standard-library-vec', 'snippet': 'Vec is a powerful tool in Rust for handling collections dynamically.'},
            {'title': 'std::vec - Rust', 'url': 'https://doc.rust-lang.org/std/vec/index.html', 'snippet': 'A contiguous growable array type with heap-allocated contents.'},
            {'title': 'rust - Vec push vs append and extend', 'url': 'https://stackoverflow.com/questions/75154715/vec-push', 'snippet': 'Which is the right way to use push, append and extend.'},
            {'title': 'Documentation index', 'url': 'https://docs.example.net/start', 'snippet': 'Library documentation for unrelated packages.'},
        ]
        ranked = web.rank_search_results('Rust Vec push standard library', results)
        self.assertEqual(ranked[0]['url'], 'https://doc.rust-lang.org/std/vec/index.html')
        self.assertNotEqual(ranked[0]['url'], 'https://docs.example.net/start')
        ordinary_query = web.rank_search_results('Rust Vec push', results)
        self.assertEqual(ordinary_query[0]['url'], results[2]['url'])

    def test_search_output_budget_is_configurable_and_keeps_complete_urls(self):
        results = [{'title': 'Source ' + str(i), 'url': 'https://example.org/source/' + str(i), 'snippet': 'Relevant source details. ' * 8} for i in range(20)]
        small = web.fit_search(results, 20, 600)
        larger = web.fit_search(results, 20, 6000)
        self.assertGreater(len(larger), len(small))
        self.assertLessEqual(len(web.compact(small).encode()), 600)
        self.assertLessEqual(len(web.compact(larger).encode()), 6000)
        self.assertTrue(all(row['url'] in {item['url'] for item in results} for row in small + larger))

    async def test_search_retries_transient_source_errors_but_not_forbidden_responses(self):
        page = '<div class="snippet"><a href="https://example.org/source"><h3>Retry source</h3></a><p class="snippet-description">Recovered result</p></div>'
        attempts = 0
        async def fetch(url):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise web.WebError('HTTP', 'HTTP 503.')
            return page, url, 'text/html'
        with patch.object(web, 'fetch_text', side_effect=fetch), patch.object(web.asyncio, 'sleep', return_value=None):
            result = await web.web_search(web.SearchArgs(query='retry source', source='brave', retry_attempts=1))
        self.assertEqual(attempts, 2)
        self.assertEqual(result[0]['url'], 'https://example.org/source')
        with patch.object(web, 'fetch_text', side_effect=web.WebError('HTTP', 'HTTP 403.')) as forbidden:
            with self.assertRaises(web.WebError):
                await web.web_search(web.SearchArgs(query='retry source', source='brave', retry_attempts=3))
        self.assertEqual(forbidden.call_count, 1)

    def test_compact_results_keep_valid_complete_urls(self):
        source = [{'title': 'Polski tytuł ' * 4, 'url': 'https://example.org/' + str(i), 'snippet': 'ą' * 180} for i in range(10)]
        result = web.fit_search(source, 6)
        self.assertGreater(len(result), 0)
        self.assertLessEqual(len(web.compact(result).encode()), web.SEARCH_BYTES)
        for item in result:
            self.assertIn(item['url'], [r['url'] for r in source])

    def test_bm25_selects_relevant_sections_and_lists_other_headings(self):
        text = '\n'.join(f'# Chapter {i}\n' + ('payment invoice refunds ' if i == 5 else f'general unrelated content {i} ') * 100 for i in range(10))
        result = web.focus_content(text, 'payment invoice refunds')
        self.assertIn('# Chapter 5', result['content'])
        self.assertTrue(result['truncated'])
        self.assertTrue(result['other_headings'])
        self.assertEqual(result['selection'], 'BM25; up to three relevant sections')
        long_section = '# Release history\n' + ('Unrelated release details. ' * 300) + '\nAdded in version 3.7.'
        original_limit = web.READ_BYTES
        web.READ_BYTES = 180
        try:
            focused = web.focus_content(long_section, 'Added in version 3.7')
        finally:
            web.READ_BYTES = original_limit
        self.assertIn('Added in version 3.7.', focused['content'])
        self.assertLessEqual(len(focused['content'].encode('utf-8')), 180)
        huge_headers = '\n'.join('# ' + str(i) + 'x' * 3000 + '\n' + 'description ' * 80 for i in range(10))
        bounded = web.focus_content(huge_headers, 'description')
        self.assertLessEqual(sum(len(title.encode()) for title in bounded['other_headings']), 600)

    def test_github_raw_and_control_sanitization(self):
        self.assertEqual(web.github_raw('https://github.com/python/cpython/blob/main/README.rst'), ('https://raw.githubusercontent.com/python/cpython/main/README.rst', True))
        self.assertEqual(web.clean('a\u200bb\u202ec\x1b\x00\nd'), 'abc\nd')

    async def test_reader_handles_literal_redirect_and_short_landing_page(self):
        async def fetch(url):
            if url.endswith('/start'):
                return '<html><script>window.location.href="/landing"</script></html>', url, 'text/html'
            return '<html><head><title>Useful title</title><meta name="description" content="Actual site description"></head><body><p>Short public page.</p></body></html>', url, 'text/html'
        with patch.object(web, 'fetch_text', side_effect=fetch):
            result = await web.read_webpage(web.ReadArgs(url='https://example.org/start'))
        self.assertEqual(result['url'], 'https://example.org/landing')
        self.assertTrue(result['readable'])
        self.assertIn('Useful title', result['content'])
        article = '<html><title>JS documentation</title><article><code>window.location.href="/example"</code><p>This is a documented code example, not a redirect.</p></article></html>'
        with patch.object(web, 'fetch_text', return_value=(article, 'https://example.org/docs', 'text/html')) as request:
            result = await web.read_webpage(web.ReadArgs(url='https://example.org/docs'))
            self.assertEqual(request.await_count, 1)
            self.assertEqual(result['url'], 'https://example.org/docs')

    async def test_empty_page_explicitly_cannot_verify_facts(self):
        with patch.object(web, 'fetch_text', return_value=('<html></html>', 'https://example.org/', 'text/html')):
            result = await web.read_webpage(web.ReadArgs(url='https://example.org/'))
        self.assertFalse(result['readable'])
        self.assertEqual(result['content'], '')
        self.assertIn('Do not treat', result['notice'])

    def test_bad_download_names(self):
        for filename in ['../../evil', '..\\evil', 'C:evil', 'CON.txt', 'NUL', 'CONIN$', 'file.', 'x\u200by']:
            with self.assertRaises(web.WebError, msg=filename): web.safe_filename(filename)

    async def test_download_hash_no_overwrite_and_partial_cleanup(self):
        content = bytes(range(256)) * 700
        @asynccontextmanager
        async def fake_open(*args, **kwargs):
            yield Response([content[:100000], content[100000:]], headers={'content-type': 'application/octet-stream'}), 'https://example.org/file'
        previous = Path.cwd()
        with tempfile.TemporaryDirectory(prefix='polon-web-test-') as temp:
            try:
                os.chdir(temp)
                with patch.object(web, 'open_public', fake_open), patch.object(web, 'pinned_target', return_value=('https://example.org/file', 'example.org:443:8.8.8.8')):
                    first = await web.download_to_disk(web.DownloadArgs(url='https://example.org/file', save_filename='file.zip'))
                    second = await web.download_to_disk(web.DownloadArgs(url='https://example.org/file', save_filename='file.zip'))
                    self.assertNotEqual(first['saved_path'], second['saved_path'])
                    self.assertEqual(first['sha256'], hashlib.sha256(content).hexdigest())
                    self.assertEqual(Path(first['saved_path']).read_bytes(), content)
                    self.assertTrue(Path(first['saved_path']).is_relative_to(Path(temp).resolve() / 'agent_workspace/downloads'))
                    with patch.object(web, 'FILE_LIMIT', 100):
                        with self.assertRaises(web.WebError): await web.download_to_disk(web.DownloadArgs(url='https://example.org/file'))
                    self.assertFalse(list((Path(temp) / 'agent_workspace/downloads').glob('.download-*')))
            finally: os.chdir(previous)

    def test_four_explicit_tool_schemas(self):
        self.assertEqual({item['function']['name'] for item in web.tools_schema}, {'web_search', 'read_webpage', 'download_to_disk', 'github_repo_inspector'})
        self.assertTrue(all(item['function']['parameters']['additionalProperties'] is False for item in web.tools_schema))


if __name__ == '__main__':
    unittest.main()
