import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RpcBroadcastError,
  createGuardedRpcFallback,
  parseRpcUrls,
} from '../lib/rpc-fallback.mjs';

function fakeFactory(handlers, calls) {
  return (url) => () => ({
    config: {
      key: `fake-${url}`,
      name: `fake-${url}`,
      type: 'fake',
      request: handlers[url],
      retryCount: 0,
      timeout: 100,
    },
    request: async (request) => {
      calls.push({ url, ...request });
      return handlers[url](request);
    },
    value: { url },
  });
}

test('RPC URL parsing is ordered, validated and de-duplicated', () => {
  assert.deepEqual(
    parseRpcUrls(
      'https://primary.example',
      ' https://fallback.example,https://primary.example ',
      ['https://last.example'],
    ),
    ['https://primary.example', 'https://fallback.example', 'https://last.example'],
  );
  assert.throws(() => parseRpcUrls('file:///tmp/socket'), /must use http or https/);
  assert.throws(() => parseRpcUrls('', '', []), /at least one RPC URL/);
});

test('read calls fall back without involving the broadcast selector', async () => {
  const calls = [];
  const rpc = createGuardedRpcFallback({
    urls: ['https://one.example', 'https://two.example'],
    chainId: 11155111,
    transportFactory: fakeFactory({
      'https://one.example': async ({ method }) => {
        if (method === 'eth_blockNumber') throw new Error('read unavailable');
        return '0xaa36a7';
      },
      'https://two.example': async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        assert.equal(method, 'eth_blockNumber');
        return '0x2a';
      },
    }, calls),
  });

  const transport = rpc.transport({});
  assert.equal(await transport.request({ method: 'eth_blockNumber' }), '0x2a');
  assert.deepEqual(
    calls.map(({ url, method }) => `${url}:${method}`),
    [
      'https://one.example:eth_chainId',
      'https://one.example:eth_blockNumber',
      'https://two.example:eth_chainId',
      'https://two.example:eth_blockNumber',
    ],
  );
  assert.equal(rpc.status().hasBroadcastEndpoint, false);
});

test('read fallback rejects a responsive endpoint on the wrong chain', async () => {
  const calls = [];
  const rpc = createGuardedRpcFallback({
    urls: ['https://wrong.example', 'https://right.example'],
    chainId: 11155111,
    transportFactory: fakeFactory({
      'https://wrong.example': async ({ method }) => {
        if (method === 'eth_chainId') return '0x1';
        throw new Error('wrong-chain data must not be read');
      },
      'https://right.example': async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        return '0x2a';
      },
    }, calls),
  });

  assert.equal(
    await rpc.transport({}).request({ method: 'eth_blockNumber' }),
    '0x2a',
  );
  assert.equal(
    calls.some(({ url, method }) => url === 'https://wrong.example' && method === 'eth_blockNumber'),
    false,
  );
  assert.equal(rpc.status().quarantinedEndpoints, 1);
});

test('broadcast preflight selects one healthy endpoint and sends exactly once', async () => {
  const calls = [];
  const rpc = createGuardedRpcFallback({
    urls: ['https://one.example', 'https://two.example'],
    chainId: 11155111,
    quarantineMs: 1_000,
    transportFactory: fakeFactory({
      'https://one.example': async ({ method }) => {
        assert.equal(method, 'eth_chainId');
        throw new Error('offline');
      },
      'https://two.example': async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        assert.equal(method, 'eth_sendRawTransaction');
        return '0xaccepted';
      },
    }, calls),
  });

  const transport = rpc.transport({});
  assert.equal(
    await transport.request({ method: 'eth_sendRawTransaction', params: ['0x01'] }),
    '0xaccepted',
  );
  assert.deepEqual(
    calls.map(({ url, method }) => `${url}:${method}`),
    [
      'https://one.example:eth_chainId',
      'https://two.example:eth_chainId',
      'https://two.example:eth_sendRawTransaction',
    ],
  );
});

test('an ambiguous broadcast is never replayed on the fallback provider', async () => {
  const calls = [];
  let currentTime = 1_000;
  const rpc = createGuardedRpcFallback({
    urls: ['https://one.example', 'https://two.example'],
    chainId: 11155111,
    quarantineMs: 10_000,
    now: () => currentTime,
    transportFactory: fakeFactory({
      'https://one.example': async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        throw new Error('response lost after send');
      },
      'https://two.example': async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        return '0xfallback-accepted';
      },
    }, calls),
  });

  const transport = rpc.transport({});
  await assert.rejects(
    transport.request({ method: 'eth_sendRawTransaction', params: ['0x01'] }),
    (error) => {
      const broadcastError = error instanceof RpcBroadcastError ? error : error.cause;
      assert.equal(broadcastError instanceof RpcBroadcastError, true);
      assert.equal(broadcastError.broadcastUncertain, true);
      assert.match(broadcastError.transactionHash, /^0x[0-9a-f]{64}$/);
      return true;
    },
  );
  assert.equal(
    calls.filter(({ url, method }) =>
      url === 'https://two.example' && method === 'eth_sendRawTransaction').length,
    0,
  );

  // A later, distinct operation may choose the healthy fallback while the
  // ambiguous primary is quarantined. The failed payload itself was not replayed.
  assert.equal(
    await transport.request({ method: 'eth_sendRawTransaction', params: ['0x02'] }),
    '0xfallback-accepted',
  );
  assert.equal(
    calls.filter(({ url, method }) =>
      url === 'https://two.example' && method === 'eth_sendRawTransaction').length,
    1,
  );
  currentTime += 20_000;
});
