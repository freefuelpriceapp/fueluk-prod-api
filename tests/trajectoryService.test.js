'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the db module so requiring the trajectory service doesn't fail.
require('module')._cache[require.resolve('../src/config/db')] = {
  exports: { getPool: () => null },
};

const trajectory = require('../src/services/trajectoryService');

function point(price, hoursAgo) {
  return {
    price_pence: price,
    recorded_at: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(),
  };
}

test('classifyDelta: rising', () => {
  const c = trajectory.classifyDelta(2.4);
  assert.equal(c.direction, 'rising');
  assert.equal(c.delta, 2.4);
  assert.match(c.recommendation, /rising/i);
});

test('classifyDelta: falling', () => {
  const c = trajectory.classifyDelta(-3.1);
  assert.equal(c.direction, 'falling');
  assert.equal(c.delta, -3.1);
  assert.match(c.recommendation, /falling|wait/i);
});

test('classifyDelta: stable when |delta| < 0.5p', () => {
  const c = trajectory.classifyDelta(0.3);
  assert.equal(c.direction, 'stable');
  assert.match(c.recommendation, /stable/i);
});

test('confidenceFor: >=6 points = high, 4–5 = medium, <4 = low', () => {
  assert.equal(trajectory.confidenceFor(7), 'high');
  assert.equal(trajectory.confidenceFor(6), 'high');
  assert.equal(trajectory.confidenceFor(5), 'medium');
  assert.equal(trajectory.confidenceFor(4), 'medium');
  assert.equal(trajectory.confidenceFor(3), 'low');
});

test('computeDeltaFromPoints: newest minus oldest', () => {
  const points = [point(150, 168), point(151, 120), point(152, 72), point(153, 24)];
  const d = trajectory.computeDeltaFromPoints(points);
  assert.equal(d.delta, 3);
  assert.equal(d.pointCount, 4);
});

test('computeDeltaFromPoints: null on empty', () => {
  assert.equal(trajectory.computeDeltaFromPoints([]), null);
});

test('buildStationTrajectory: high-confidence rising block', () => {
  const points = [
    point(150, 160), point(150.5, 140), point(151, 120), point(151.5, 96),
    point(152, 72),  point(152.5, 48),  point(153, 24),
  ];
  const block = trajectory.buildStationTrajectory(points, { fuelType: 'e10', source: 'station' });
  assert.equal(block.direction, 'rising');
  assert.equal(block.delta_7d_p, 3);
  assert.equal(block.confidence, 'high');
  assert.equal(block.source, 'station');
  assert.equal(block.fuel_type, 'e10');
});

test('buildStationTrajectory: national source forces confidence=low', () => {
  const points = [point(150, 168), point(152, 24)];
  const block = trajectory.buildStationTrajectory(points, { fuelType: 'e10', source: 'national' });
  assert.equal(block.source, 'national');
  assert.equal(block.confidence, 'low');
});

test('annotateTrajectory: <4 station points falls back to national', async () => {
  // Stub pool: station history returns 2 rows, national avg returns 7 rows.
  const fakePool = {
    async query(sql, params) {
      if (/FROM price_history[\s\S]*AND fuel_type = \$2\s+AND recorded_at/.test(sql) && params.length === 2) {
        return { rows: [point(150, 72), point(151, 24)] }; // 2 points
      }
      if (/DATE_TRUNC/.test(sql)) {
        return {
          rows: [
            { day: new Date(Date.now() - 168 * 3600 * 1000), avg_price: 150 },
            { day: new Date(Date.now() - 144 * 3600 * 1000), avg_price: 150.5 },
            { day: new Date(Date.now() - 120 * 3600 * 1000), avg_price: 151 },
            { day: new Date(Date.now() - 96 * 3600 * 1000),  avg_price: 151.5 },
            { day: new Date(Date.now() - 72 * 3600 * 1000),  avg_price: 152 },
            { day: new Date(Date.now() - 48 * 3600 * 1000),  avg_price: 152.3 },
            { day: new Date(Date.now() - 24 * 3600 * 1000),  avg_price: 152.5 },
          ],
        };
      }
      return { rows: [] };
    },
  };
  trajectory.__setPoolForTests(fakePool);
  trajectory.__clearNationalCacheForTests();

  const stations = [{ id: 'abc' }];
  const { perStation, national } = await trajectory.annotateTrajectory(stations, { fuelType: 'E10' });
  assert.ok(national);
  assert.equal(national.source, 'national');
  assert.equal(perStation.length, 1);
  assert.ok(perStation[0]);
  assert.equal(perStation[0].source, 'national');
  assert.equal(perStation[0].confidence, 'low');
});

test('annotateTrajectory: ≥6 station points gives high confidence, source=station', async () => {
  const fakePool = {
    async query(sql, params) {
      if (/FROM price_history[\s\S]*AND fuel_type = \$2\s+AND recorded_at/.test(sql) && params.length === 2) {
        return {
          rows: [
            point(150, 160), point(150.5, 140), point(151, 120),
            point(151.5, 96), point(152, 72), point(152.5, 48), point(153, 24),
          ],
        };
      }
      if (/DATE_TRUNC/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  trajectory.__setPoolForTests(fakePool);
  trajectory.__clearNationalCacheForTests();
  const { perStation } = await trajectory.annotateTrajectory([{ id: 's1' }], { fuelType: 'E10' });
  assert.equal(perStation[0].source, 'station');
  assert.equal(perStation[0].confidence, 'high');
  assert.equal(perStation[0].direction, 'rising');
});

test('getNationalTrajectory: result cached for 30 min', async () => {
  let calls = 0;
  const fakePool = {
    async query(sql) {
      if (/DATE_TRUNC/.test(sql)) {
        calls += 1;
        return {
          rows: [
            { day: new Date(Date.now() - 168 * 3600 * 1000), avg_price: 150 },
            { day: new Date(Date.now() - 24 * 3600 * 1000),  avg_price: 152 },
          ],
        };
      }
      return { rows: [] };
    },
  };
  trajectory.__setPoolForTests(fakePool);
  trajectory.__clearNationalCacheForTests();
  await trajectory.getNationalTrajectory('E10');
  await trajectory.getNationalTrajectory('E10');
  await trajectory.getNationalTrajectory('E10');
  assert.equal(calls, 1, 'expected cache hit after first call');
});
