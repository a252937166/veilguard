import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from '../lib/single-flight.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('first take acknowledges processing and runs the job exactly once', async () => {
  const flights = createSingleFlight({ setTimer: () => null });
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = () => { runs += 1; return gate.then(() => 'done'); };

  assert.deepEqual(flights.take('k', run), { processing: true });
  assert.deepEqual(flights.take('k', run), { processing: true });
  await settle();
  assert.equal(flights.inFlight, 1);

  release();
  await settle();
  assert.equal(runs, 1);
  assert.equal(flights.inFlight, 0);
  // A success stays redeliverable so a client that lost the response can
  // reconcile without re-running (or double-charging) the work.
  assert.deepEqual(flights.take('k', run), { result: 'done' });
  assert.deepEqual(flights.take('k', run), { result: 'done' });
  assert.equal(runs, 1);
});

test('a failure is delivered exactly once and the next take retries fresh', async () => {
  const flights = createSingleFlight({ setTimer: () => null });
  let runs = 0;
  const boom = new Error('rpc down');
  assert.deepEqual(
    flights.take('k', () => { runs += 1; return Promise.reject(boom); }),
    { processing: true },
  );
  await settle();

  const delivered = flights.take('k', () => Promise.resolve('unused'));
  assert.equal(delivered.error, boom);

  assert.deepEqual(
    flights.take('k', () => { runs += 1; return Promise.resolve('recovered'); }),
    { processing: true },
  );
  await settle();
  assert.deepEqual(flights.take('k', () => Promise.resolve('unused')), { result: 'recovered' });
  assert.equal(runs, 2);
});

test('a stale settlement timer cannot evict a newer result', async () => {
  const timers = [];
  const flights = createSingleFlight({ setTimer: (fn) => { timers.push(fn); return null; } });
  const boom = new Error('first attempt failed');

  flights.take('k', () => Promise.reject(boom));
  await settle();
  assert.equal(flights.take('k', () => Promise.resolve('unused')).error, boom);

  flights.take('k', () => Promise.resolve('second'));
  await settle();

  timers[0]();
  assert.deepEqual(flights.take('k', () => Promise.resolve('unused')), { result: 'second' });

  timers[1]();
  assert.deepEqual(flights.take('k', () => Promise.resolve('third')), { processing: true });
});
