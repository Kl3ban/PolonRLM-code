import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createProvider, isRetryableProviderError, providerConfigForModel, PROVIDER_PRESETS, PROVIDER_RETRY_DELAY_MS } from '../src/providers/provider.js';
import type { ProviderConfig } from '../src/core/types.js';

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve, reject) => {
    http.close(error => error ? reject(error) : resolve()); http.closeAllConnections();
  }) };
}
const config = (baseURL: string): ProviderConfig => ({ id: 'local-test', kind: 'compatible', baseURL, model: 'test-model' });
function event(response: ServerResponse, value: unknown) { response.write(`data: ${JSON.stringify(value)}\n\n`); }
function chunk(delta: unknown, finish_reason: string | null = null) {
  return { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] };
}

test('model discovery reads capabilities/prices, caches results, preserves unknown metadata', async () => {
  let requests = 0;
  const local = await server((request, response) => {
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    requests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [
      { id: 'smart', name: 'Smart', context_length: 32768, supported_parameters: ['tools', 'reasoning'], reasoning_control: 'effort', reasoning_efforts: ['low', 'high'], architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'unknown' },
    ] }));
  });
  try {
    const provider = createProvider(config(local.baseURL), 'test-key', 100);
    const models = await provider.listModels();
    assert.equal(models[0]?.toolCalling, true);
    assert.equal(models[0]?.vision, true);
    assert.equal(models[0]?.reasoning, true);
    assert.equal(models[0]?.reasoningControl, 'effort');
    assert.deepEqual(models[0]?.reasoningEfforts, ['low', 'high']);
    assert.equal(models[0]?.inputPrice, 1);
    assert.equal(models[1]?.toolCalling, undefined);
    models[0]!.id = 'mutated';
    assert.equal((await provider.listModels())[0]?.id, 'smart');
    assert.equal(requests, 1);
  } finally { await local.close(); }
});

test('desktop tool screenshot reaches the OpenAI-compatible model as real image content', async () => {
  let requestBody: any;
  const local = await server(async (request, response) => {
    let text = ''; for await (const part of request) text += part; requestBody = JSON.parse(text);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); event(response, chunk({ content: 'Visible' }, 'stop')); response.end('data: [DONE]\n\n');
  });
  try {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    await createProvider(config(local.baseURL), undefined, 100).complete([
      { role: 'user', content: 'Inspect window' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'screen', name: 'computer_use', arguments: { action: 'observe' } }] },
      { role: 'tool', toolCallId: 'screen', name: 'computer_use', content: 'Screenshot', images: [{ data, mediaType: 'image/png' }] },
    ], [], () => {}, new AbortController().signal);
    assert.ok(JSON.stringify(requestBody.messages).includes('data:image/png;base64,' + data));
  } finally { await local.close(); }
});

test('compatible provider streams text and tool arguments with real HTTP SSE', async () => {
  let requestBody: Record<string, unknown> = {};
  const local = await server(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const data of request) body += data;
    requestBody = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ role: 'assistant', content: 'Tworzę ' }));
    event(response, chunk({ content: 'plik.' }));
    event(response, chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] }));
    event(response, chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello.txt"}' } }] }));
    event(response, chunk({}, 'tool_calls'));
    event(response, { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } } });
    response.end('data: [DONE]\n\n');
  });
  try {
    const provider = createProvider({ ...config(local.baseURL), inputPrice: 1, outputPrice: 2 }, undefined, 100);
    let streamed = '';
    const reply = await provider.complete([{ role: 'user', content: 'Utwórz plik' }], [{ name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }], text => { streamed += text; }, new AbortController().signal);
    assert.equal(streamed, 'Tworzę plik.');
    assert.equal(reply.text, streamed);
    assert.deepEqual(reply.toolCalls, [{ id: 'call-1', name: 'write_file', arguments: { path: 'hello.txt' } }]);
    assert.equal(reply.usage.input, 100);
    assert.equal(reply.usage.output, 20);
    assert.equal(reply.usage.costKnown, true);
    assert.equal(reply.usage.cost, 0.00014);
    assert.equal(requestBody.stream, true);
    assert.equal((requestBody.tools as unknown[]).length, 1);
  } finally { await local.close(); }
});

test('routed model override reaches the provider request and drops stale model metadata', async () => {
  let requestBody: any;
  const local = await server(async (request, response) => {
    let body = ''; for await (const part of request) body += part; requestBody = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ content: 'Routed model response.' }, 'stop')); response.end('data: [DONE]\n\n');
  });
  try {
    const selected = providerConfigForModel({ ...config(local.baseURL), model: 'saved-model', contextWindow: 64000, maxOutputTokens: 4096, toolCalling: false, vision: false, inputPrice: 1, outputPrice: 2 }, 'routed-model');
    assert.equal(selected.model, 'routed-model');
    assert.equal(selected.contextWindow, undefined);
    assert.equal(selected.toolCalling, undefined);
    assert.equal(selected.inputPrice, undefined);
    await createProvider(selected, undefined, 0).complete([{ role: 'user', content: 'Use the routed model.' }], [], () => {}, new AbortController().signal);
    assert.equal(requestBody.model, 'routed-model');
  } finally { await local.close(); }
});

test('compatible provider repairs a common read_webpage tool-name typo against the active schema', async () => {
  const local = await server(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ tool_calls: [{ index: 0, id: 'read-page', type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://docs.python.org/3/library/asyncio-runner.html"}' } }] }));
    event(response, chunk({}, 'tool_calls')); response.end('data: [DONE]\n\n');
  });
  try {
    const tools = [{ name: 'read_webpage', description: 'Read one page', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } }];
    const reply = await createProvider(config(local.baseURL), undefined, 100).complete([{ role: 'user', content: 'Read the page.' }], tools, () => {}, new AbortController().signal);
    assert.equal(reply.toolCalls[0]?.name, 'read_webpage');
    assert.equal(reply.toolCalls[0]?.validationError, undefined);
    assert.deepEqual(reply.toolCalls[0]?.arguments, { url: 'https://docs.python.org/3/library/asyncio-runner.html' });
  } finally { await local.close(); }
});

test('OpenAI native adapter sends bearer auth and streams a completed answer', async () => {
  let requestBody: any;
  const local = await server(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer openai-test');
    let body = ''; for await (const data of request) body += data;
    requestBody = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ content: 'OpenAI adapter OK.' }, 'stop'));
    event(response, { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
    response.end('data: [DONE]\n\n');
  });
  try {
    const streamed: string[] = [];
    const imageData = 'AAECAwQ=';
    const result = await createProvider({ ...config(local.baseURL), id: 'openai', kind: 'openai', model: 'gpt-6-astra', reasoning: 'high' }, 'openai-test', 100).complete(
      [{ role: 'user', content: 'Say the test marker and inspect this image.', images: [{ data: imageData, mediaType: 'image/png' }] }], [], text => streamed.push(text), new AbortController().signal);
    assert.equal(result.text, 'OpenAI adapter OK.');
    assert.deepEqual(streamed, ['OpenAI adapter OK.']);
    assert.equal(result.usage.input, 12);
    assert.equal(result.usage.output, 4);
    assert.equal(requestBody.model, 'gpt-6-astra');
    assert.equal(requestBody.reasoning_effort, 'high');
    assert.equal(requestBody.stream, true);
    assert.ok(JSON.stringify(requestBody.messages).includes(`data:image/png;base64,${imageData}`));
  } finally { await local.close(); }
});

test('invalid desktop tool JSON returns a non-executable call instead of aborting the model turn', async () => {
  const local = await server((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ tool_calls: [{ index: 0, id: 'invalid-screen', type: 'function', function: { name: 'computer_use', arguments: '{"action":' } }] }));
    event(response, chunk({}, 'tool_calls')); response.end('data: [DONE]\n\n');
  });
  try {
    const reply = await createProvider(config(local.baseURL), undefined, 100).complete([{ role: 'user', content: 'Inspect desktop' }], [{ name: 'computer_use', description: 'Desktop', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'observe'] } }, required: ['action'] } }], () => {}, new AbortController().signal);
    assert.equal(reply.toolCalls.length, 1);
    assert.match(reply.toolCalls[0]!.validationError!, /The call was not executed.*action: list\|observe/);
    assert.deepEqual(reply.toolCalls[0]!.arguments, {});
  } finally { await local.close(); }
});

test('tool history converts into assistant tool calls and tool result messages', async () => {
  const local = await server(async (request, response) => {
    let body = ''; for await (const data of request) body += data;
    const messages = JSON.parse(body).messages;
    assert.equal(messages[1].tool_calls[0].function.name, 'read_file');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'read-1');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ content: 'OK' }, 'stop')); response.end('data: [DONE]\n\n');
  });
  try {
    const reply = await createProvider(config(local.baseURL), undefined, 100).complete([
      { role: 'user', content: 'Read' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'x' } }] },
      { role: 'tool', toolCallId: 'read-1', name: 'read_file', content: 'contents' },
    ], [], () => {}, new AbortController().signal);
    assert.equal(reply.text, 'OK'); assert.equal(reply.usage.costKnown, false);
  } finally { await local.close(); }
});

test('authentication errors do not retry or leak API key', async () => {
  let count = 0;
  const local = await server((_request, response) => {
    count++; response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Bad token private-key', type: 'auth' } }));
  });
  try {
    await assert.rejects(createProvider(config(local.baseURL), 'private-key', 100).complete([{ role: 'user', content: 'hello' }], [], () => {}, new AbortController().signal), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes('private-key')); return true;
    });
    assert.equal(count, 1);
    await assert.rejects(createProvider(config(local.baseURL), 'private-key', 100).listModels(), /HTTP 401/);
  } finally { await local.close(); }
});

test('HTTP 403 explains model access restrictions without exposing credentials', async () => {
  const local = await server((_request, response) => {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Authorization failed. private-key' } }));
  });
  try {
    await assert.rejects(createProvider(config(local.baseURL), 'private-key', 100).complete([{ role: 'user', content: 'hello' }], [], () => {}, new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The provider denied access to this model or endpoint (HTTP 403). Check the API key permissions and whether the provider allows this model.');
      assert.ok(!error.message.includes('private-key'));
      assert.equal((error as Error & { statusCode?: number }).statusCode, 403);
      assert.equal(isRetryableProviderError(error), false);
      return true;
    });
  } finally { await local.close(); }
});

test('overloaded model errors recommend retrying the selected model without suggesting a switch', async () => {
  const models: string[] = [];
  const local = await server(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    models.push(JSON.parse(body).model);
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'deepseek-v4-flash-free is experiencing high demand right now. Please try again later, or switch the model identifier to deepseek-v4-flash to continue.' } }));
  });
  try {
    await assert.rejects(createProvider(config(local.baseURL), undefined, 100).complete([{ role: 'user', content: 'hello' }], [], () => {}, new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The selected provider is temporarily busy (HTTP 429). Wait briefly, then retry the selected model.');
      assert.ok(!error.message.includes('deepseek-v4-flash'));
      assert.equal((error as Error & { statusCode?: number }).statusCode, 429);
      return true;
    });
    assert.ok(models.length >= 1 && models.every(model => model === 'test-model'));
  } finally { await local.close(); }
});

test('HTTP 402 reports a billing requirement and is not treated as transient provider overload', async () => {
  const local = await server(async (_request, response) => {
    response.writeHead(402, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'wallet balance is insufficient. Secret token must not appear.' } }));
  });
  try {
    await assert.rejects(createProvider(config(local.baseURL), 'secret-token', 100).complete([{ role: 'user', content: 'hello' }], [], () => {}, new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The provider rejected this request because its account balance or billing allowance is insufficient (HTTP 402). Check the provider dashboard; this error will not be retried automatically.');
      assert.ok(!error.message.includes('secret-token'));
      assert.equal((error as Error & { statusCode?: number }).statusCode, 402);
      assert.equal(isRetryableProviderError(error), false);
      return true;
    });
  } finally { await local.close(); }
});

test('OpenAI-compatible billing errors reported as HTTP 400 are not mislabeled as model overload', async () => {
  const local = await server(async (_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'wallet balance is insufficient; try the model again during high demand.' } }));
  });
  try {
    await assert.rejects(createProvider(config(local.baseURL), undefined, 100).complete([{ role: 'user', content: 'hello' }], [], () => {}, new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The provider rejected this request because its account balance or billing allowance is insufficient (HTTP 400). Check the provider dashboard; this error will not be retried automatically.');
      assert.equal((error as Error & { statusCode?: number }).statusCode, 400);
      assert.equal(isRetryableProviderError(error), false);
      return true;
    });
  } finally { await local.close(); }
});

test('provider retry policy waits ten seconds and retries only transient failures', () => {
  assert.equal(PROVIDER_RETRY_DELAY_MS, 10_000);
  assert.equal(isRetryableProviderError(Object.assign(new Error('Service unavailable'), { statusCode: 503 })), true);
  assert.equal(isRetryableProviderError(new Error('The selected provider is temporarily busy.')), true);
  assert.equal(isRetryableProviderError(Object.assign(new Error('The selected provider is temporarily busy (HTTP 402).'), { statusCode: 402 })), false);
  assert.equal(isRetryableProviderError(Object.assign(new Error('Wallet balance is insufficient, even with high demand.'), { statusCode: 400 })), false);
  assert.equal(isRetryableProviderError(Object.assign(new Error('Bad request'), { statusCode: 400 })), false);
  assert.equal(isRetryableProviderError(Object.assign(new Error('Unauthorized'), { statusCode: 401 })), false);
  assert.equal(isRetryableProviderError(new DOMException('Request cancelled.', 'AbortError')), false);
});

test('abort interrupts an active stream without retrying', async () => {
  let count = 0;
  const local = await server((_request, response) => {
    count++; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ content: 'start' }));
  });
  try {
    const abort = new AbortController();
    await assert.rejects(createProvider(config(local.baseURL), undefined, 100).complete([{ role: 'user', content: 'hello' }], [], () => abort.abort(), abort.signal), error => error instanceof Error && error.name === 'AbortError');
    assert.equal(count, 1);
  } finally { await local.close(); }
});

test('Google discovery paginates and authenticates without putting key in URL', async () => {
  const paths: string[] = [];
  const local = await server((request, response) => {
    paths.push(request.url!); assert.equal(request.headers['x-goog-api-key'], 'google-test');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(paths.length === 1 ? { models: [{ name: 'models/first', displayName: 'First', inputTokenLimit: 4096, outputTokenLimit: 2048, thinking: true }], nextPageToken: 'next' } : { models: [{ name: 'models/second' }] }));
  });
  try {
    const models = await createProvider({ ...config(local.baseURL), kind: 'google' }, 'google-test', 100).listModels();
    assert.deepEqual(models.map(item => item.id), ['first', 'second']);
    assert.equal(models[0]?.contextWindow, 4096); assert.equal(models[0]?.maxOutputTokens, 2048); assert.equal(models[0]?.reasoning, true); assert.equal(models[0]?.toolCalling, undefined);
    assert.deepEqual(paths, ['/v1/models', '/v1/models?pageToken=next']);
  } finally { await local.close(); }
});

test('OpenAI-compatible model discovery follows after cursors through all pages', async () => {
  const paths: string[] = [];
  const local = await server((request, response) => {
    paths.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    const cursor = new URL(request.url!, 'http://localhost').searchParams.get('after');
    response.end(JSON.stringify(cursor ? { data: [{ id: 'third' }], has_more: false } : { data: [{ id: 'first' }, { id: 'second' }], has_more: true, last_id: 'second' }));
  });
  try {
    const models = await createProvider(config(local.baseURL), undefined, 100).listModels();
    assert.deepEqual(models.map(model => model.id), ['first', 'second', 'third']);
    assert.deepEqual(paths, ['/v1/models', '/v1/models?after=second']);
  } finally { await local.close(); }
});

test('reject invalid endpoints and keep preset provider URLs valid', async () => {
  assert.throws(() => createProvider(config('file:///etc/passwd'), undefined, 100), /HTTP/);
  assert.throws(() => createProvider(config('https://user:password@example.com'), undefined, 100), /HTTP/);
  assert.equal(PROVIDER_PRESETS.nvidia?.baseURL, 'https://integrate.api.nvidia.com/v1');
});

test('catalog-known text-only models answer without tool schemas or incompatible tool history', async () => {
  let requestBody: any;
  const local = await server(async (request, response) => {
    let body = ''; for await (const data of request) body += data;
    requestBody = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ content: 'Text answer.' }, 'stop')); response.end('data: [DONE]\n\n');
  });
  try {
    const reply = await createProvider({ ...config(local.baseURL), toolCalling: false }, undefined, 100).complete([
      { role: 'system', content: 'Answer only with text.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'prior', name: 'read_file', arguments: { path: 'hello.txt' } }] },
      { role: 'tool', toolCallId: 'prior', name: 'read_file', content: 'Earlier file contents.' },
      { role: 'user', content: 'Explain the result.' },
    ], [{ name: 'write_file', description: 'Write', parameters: { type: 'object' } }], () => {}, new AbortController().signal);
    assert.equal(reply.text, 'Text answer.');
    assert.equal('tools' in requestBody, false);
    const sent = requestBody.messages as Array<Record<string, unknown>>;
    assert.ok(sent.every(message => message.role !== 'tool' && !('tool_calls' in message)));
    assert.ok(sent.some(message => JSON.stringify(message.content).includes('Earlier file contents.')));
  } finally { await local.close(); }
});

test('models explicitly marked without vision reject images before sending a request', async () => {
  const local = await server((_request, response) => { response.writeHead(500); response.end(); });
  try {
    const provider = createProvider({ ...config(local.baseURL), vision: false }, undefined, 100);
    await assert.rejects(provider.complete([{ role: 'user', content: 'Describe this.', images: [{ data: 'AA==', mediaType: 'image/png' }] }], [], () => {}, new AbortController().signal), /does not support images/);
  } finally { await local.close(); }
});

test('Anthropic adapter uses native messages streaming and model pagination', async () => {
  const requestBodies: any[] = [];
  const local = await server(async (request, response) => {
    assert.equal(request.headers['x-api-key'], 'anthropic-test');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url?.includes('after_id') ? { data: [{ id: 'second' }], has_more: false } : { data: [{ id: 'first', display_name: 'First' }], has_more: true, last_id: 'first' }));
      return;
    }
    assert.equal(request.url, '/v1/messages');
    let body = ''; for await (const data of request) body += data;
    const requestBody = JSON.parse(body); requestBodies.push(requestBody);
    assert.equal(requestBody.stream, true);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic OK' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
    send('message_stop', { type: 'message_stop' }); response.end();
  });
  try {
    const provider = createProvider({ ...config(local.baseURL), kind: 'anthropic' }, 'anthropic-test', 100);
    assert.deepEqual((await provider.listModels()).map(model => model.id), ['first', 'second']);
    const reply = await provider.complete([{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'Hello' }], [], () => {}, new AbortController().signal);
    assert.equal(reply.text, 'Anthropic OK'); assert.equal(reply.usage.input, 10); assert.equal(reply.usage.output, 3);
    const imageData = 'AAECAwQ=';
    await provider.complete([{ role: 'user', content: 'Describe this image.', images: [{ data: imageData, mediaType: 'image/png' }] }], [], () => {}, new AbortController().signal);
    const imageContent = requestBodies.at(-1).messages[0].content.find((part: any) => part.type === 'image');
    assert.deepEqual(imageContent.source, { type: 'base64', media_type: 'image/png', data: imageData });
  } finally { await local.close(); }
});

test('Google adapter uses native generateContent streaming', async () => {
  const local = await server(async (request, response) => {
    assert.ok(request.url?.startsWith('/v1/models/test-model:streamGenerateContent'));
    assert.equal(request.headers['x-goog-api-key'], 'google-test');
    let body = ''; for await (const data of request) body += data;
    const requestBody = JSON.parse(body);
    assert.equal(requestBody.contents[0].parts[0].text, 'Hello');
    assert.equal(requestBody.generationConfig.maxOutputTokens, 32);
    assert.equal(requestBody.generationConfig.thinkingConfig, undefined);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, { candidates: [{ content: { role: 'model', parts: [{ text: 'Google OK' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } });
    response.end();
  });
  try {
    const reply = await createProvider({ ...config(local.baseURL), kind: 'google', maxOutputTokens: 32, reasoning: 'off', reasoningSupported: false }, 'google-test', 100).complete([{ role: 'user', content: 'Hello' }], [], () => {}, new AbortController().signal);
    assert.equal(reply.text, 'Google OK'); assert.equal(reply.usage.input, 10); assert.equal(reply.usage.output, 3);
  } finally { await local.close(); }
});

test('Google reasoning effort is serialized into the native thinking config', async () => {
  const local = await server(async (request, response) => {
    assert.ok(request.url?.startsWith('/v1/models/gemini-3.5-flash-lite:streamGenerateContent'));
    let body = ''; for await (const data of request) body += data;
    const requestBody = JSON.parse(body);
    assert.deepEqual(requestBody.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, { candidates: [{ content: { role: 'model', parts: [{ text: 'Google effort OK' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } });
    response.end();
  });
  try {
    const reply = await createProvider({ ...config(local.baseURL), id: 'google', kind: 'google', model: 'gemini-3.5-flash-lite', reasoning: 'low' }, 'google-test', 100).complete([{ role: 'user', content: 'Hello' }], [], () => {}, new AbortController().signal);
    assert.equal(reply.text, 'Google effort OK');
  } finally { await local.close(); }
});

test('catalog-known unsupported reasoning is rejected before sending a request', async () => {
  let requests = 0;
  const local = await server((_request, response) => { requests++; response.writeHead(200); response.end('{}'); });
  try {
    const provider = createProvider({ ...config(local.baseURL), kind: 'google', model: 'no-thinking', reasoning: 'low', reasoningSupported: false }, 'google-test', 100);
    await assert.rejects(provider.complete([{ role: 'user', content: 'Hello' }], [], () => {}, new AbortController().signal), /does not support reasoning settings/);
    assert.equal(requests, 0);
  } finally { await local.close(); }
});

test('pre-stream rate limits return to the runtime retry loop; interrupted streams never retry', async () => {
  let count = 0;
  const local = await server((_request, response) => {
    count++;
    if (count === 1) {
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      response.end(JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit' } }));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      event(response, chunk({ content: 'OK' }, 'stop')); response.end('data: [DONE]\n\n');
    }
  });
  try {
    await assert.rejects(createProvider(config(local.baseURL), undefined, 100).complete([{ role: 'user', content: 'Hello' }], [], () => {}, new AbortController().signal), /temporarily busy/);
    assert.equal(count, 1);
  } finally { await local.close(); }

  let streamCount = 0, streamed = '';
  const interrupted = await server((_request, response) => {
    streamCount++; response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    event(response, chunk({ content: 'partial' }));
    setTimeout(() => response.destroy(), 30);
  });
  try {
    await assert.rejects(createProvider(config(interrupted.baseURL), undefined, 100).complete([{ role: 'user', content: 'Hello' }], [], text => { streamed += text; }, new AbortController().signal));
    assert.equal(streamed, 'partial'); assert.equal(streamCount, 1);
  } finally { await interrupted.close(); }
});

test('Google tool signatures survive JSON persistence and are replayed on native function calls', async () => {
  let count = 0;
  let replayedSignature: unknown;
  const signature = 'signed-tool-call-base64-value';
  const local = await server(async (request, response) => {
    let body = ''; for await (const data of request) body += data;
    const data = JSON.parse(body);
    count++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (count === 1) {
      event(response, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'hello.txt' } }, thoughtSignature: signature }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 } });
    } else {
      replayedSignature = data.contents.find((message: { role: string }) => message.role === 'model')?.parts.find((part: { functionCall?: unknown }) => part.functionCall)?.thoughtSignature;
      event(response, { candidates: [{ content: { role: 'model', parts: [{ text: 'Verified file.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 } });
    }
    response.end();
  });
  try {
    const provider = createProvider({ ...config(local.baseURL), kind: 'google', model: 'gemini-3-flash-test' }, 'google-test', 100);
    const tools = [{ name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }];
    const first = await provider.complete([{ role: 'user', content: 'Read file' }], tools, () => {}, new AbortController().signal);
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0]?.providerOptions?.google?.thoughtSignature, signature);
    const persistedCalls = JSON.parse(JSON.stringify(first.toolCalls));
    const second = await provider.complete([
      { role: 'user', content: 'Read file' }, { role: 'assistant', content: first.text, toolCalls: persistedCalls },
      { role: 'tool', name: 'read_file', toolCallId: first.toolCalls[0]!.id, content: 'hello' },
    ], tools, () => {}, new AbortController().signal);
    assert.equal(second.text, 'Verified file.');
    assert.equal(replayedSignature, signature);
    assert.equal(count, 2);
  } finally { await local.close(); }
});

test('Google catalog excludes known embeddings, live, TTS and audio-only entries', async () => {
  const local = await server((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ models: [
      { name: 'models/text-chat', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/special-live-preview', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/special-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/special-native-audio-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/audio-only', supportedGenerationMethods: ['generateContent'], supportedOutputModalities: ['AUDIO'] },
      { name: 'models/unknown-metadata' },
    ] }));
  });
  try {
    const models = await createProvider({ ...config(local.baseURL), kind: 'google' }, undefined, 100).listModels();
    assert.deepEqual(models.map(model => model.id), ['text-chat', 'unknown-metadata']);
  } finally { await local.close(); }
});
