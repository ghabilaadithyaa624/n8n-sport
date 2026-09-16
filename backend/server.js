const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---- Ingest from n8n ----------------------------------------------------

app.post('/api/predictions', (req, res) => {
  const p = req.body || {};
  if (!p.event_id || !p.sport || !p.llm_pick) {
    return res.status(400).json({ ok: false, error: 'event_id, sport, and llm_pick are required' });
  }
  const record = {
    id: crypto.randomUUID(),
    received_at: new Date().toISOString(),
    actual_result: null,
    ...p
  };
  db.append('predictions', record);
  res.json({ ok: true, id: record.id });
});

app.post('/api/errors', (req, res) => {
  const e = req.body || {};
  const record = {
    id: crypto.randomUUID(),
    received_at: new Date().toISOString(),
    sport: e.sport || 'unknown',
    message: e.message || 'no message provided',
    occurred_at: e.occurred_at || new Date().toISOString()
  };
  db.append('errors', record);
  res.json({ ok: true, id: record.id });
});

// Record what actually happened, once it's known, so accuracy is measurable
// instead of assumed. event_id must match a previously ingested prediction.
// Pass actual_winner: null to clear a previously recorded result.
app.post('/api/results', (req, res) => {
  const body = req.body || {};
  const event_id = body.event_id;
  const actual_winner = body.actual_winner;
  const isClear = Object.prototype.hasOwnProperty.call(body, 'actual_winner') && actual_winner === null;
  if (!event_id) {
    return res.status(400).json({ ok: false, error: 'event_id is required' });
  }
  if (!isClear && !actual_winner) {
    return res.status(400).json({ ok: false, error: 'actual_winner is required (or pass null to clear)' });
  }
  const predictions = db.load('predictions');
  let updated = 0;
  for (const p of predictions) {
    if (p.event_id === event_id) {
      if (isClear) {
        p.actual_result = null;
        if (Object.prototype.hasOwnProperty.call(p, 'was_correct')) delete p.was_correct;
      } else {
        p.actual_result = actual_winner;
        p.was_correct = p.llm_pick !== 'no_bet' ? p.llm_pick === actual_winner : null;
      }
      updated += 1;
    }
  }
  if (updated === 0) return res.status(404).json({ ok: false, error: 'no prediction found for that event_id' });
  db.saveAll('predictions', predictions);
  res.json({ ok: true, updated, action: isClear ? 'cleared' : 'recorded' });
});

// ---- Read for the dashboard ---------------------------------------------

app.get('/api/predictions', (req, res) => {
  let predictions = db.load('predictions');
  const { sport, pick, limit } = req.query;
  if (sport) predictions = predictions.filter(p => p.sport === sport);
  if (pick === 'value_only') predictions = predictions.filter(p => p.llm_pick !== 'no_bet');
  predictions.sort((a, b) => new Date(b.generated_at || b.received_at) - new Date(a.generated_at || a.received_at));
  if (limit) predictions = predictions.slice(0, Number(limit));
  res.json({ ok: true, count: predictions.length, predictions });
});

app.get('/api/errors', (req, res) => {
  let errors = db.load('errors');
  errors.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  const { limit } = req.query;
  if (limit) errors = errors.slice(0, Number(limit));
  res.json({ ok: true, count: errors.length, errors });
});

// The honesty layer: this is what tells you whether the model is actually
// worth listening to, instead of just trusting its confidence numbers.
app.get('/api/accuracy', (req, res) => {
  const predictions = db.load('predictions');
  const graded = predictions.filter(p => p.was_correct !== null && p.was_correct !== undefined);
  const bySport = {};
  for (const p of graded) {
    bySport[p.sport] ||= { total: 0, correct: 0 };
    bySport[p.sport].total += 1;
    if (p.was_correct) bySport[p.sport].correct += 1;
  }
  const overall = {
    graded_predictions: graded.length,
    correct: graded.filter(p => p.was_correct).length,
    accuracy: graded.length ? Number((graded.filter(p => p.was_correct).length / graded.length * 100).toFixed(1)) : null,
    llm_parse_failures: predictions.filter(p => p.llm_parse_failed).length,
    total_predictions: predictions.length
  };
  res.json({ ok: true, overall, by_sport: bySport });
});

let isRunningPipeline = false;

app.post('/api/trigger', async (req, res) => {
  if (isRunningPipeline) {
    return res.json({ ok: true, message: 'Pipeline is already running, please wait a moment...' });
  }
  isRunningPipeline = true;
  res.json({ ok: true, message: 'Pipeline started!' });
  try {
    const pipeline = require('./pipeline');
    await pipeline.runPipeline();
  } catch (err) {
    console.error('[Trigger] Error during execution:', err);
  } finally {
    isRunningPipeline = false;
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/index.html`);
});
