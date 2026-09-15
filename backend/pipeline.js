const crypto = require('crypto');
const db = require('./db');

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
const CF_MODEL = process.env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct';
const SPORTS = (process.env.SPORTS || 'basketball_nba,soccer_epl,americanfootball_nfl').split(',');
const REGIONS = process.env.REGIONS || 'us,uk,eu';

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function getFxRate() {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR');
    const data = await res.json();
    return data.rates?.INR || 95.5;
  } catch {
    return 95.5;
  }
}

async function runPipeline() {
  console.log('[Pipeline] Starting on-demand sports prediction run...');
  const usdToInr = await getFxRate();
  const predictions = [];

  for (const sport of SPORTS) {
    const cleanSport = sport.trim();
    if (!cleanSport) continue;

    console.log(`[Pipeline] Fetching odds for: ${cleanSport}`);
    const url = `https://api.the-odds-api.com/v4/sports/${cleanSport}/odds/?apiKey=${ODDS_API_KEY}&regions=${REGIONS}&markets=h2h&oddsFormat=decimal`;
    
    let events = [];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[Pipeline] Odds API error for ${cleanSport}: ${res.statusText}`);
        continue;
      }
      events = await res.json();
    } catch (e) {
      console.error(`[Pipeline] Network error fetching ${cleanSport}:`, e.message);
      continue;
    }

    if (!Array.isArray(events) || events.length === 0) continue;

    // Process each match (de-vig)
    for (const event of events) {
      if (!event.bookmakers || !event.bookmakers.length) continue;
      const probsByTeam = {};
      const oddsByTeam = {};

      for (const bm of event.bookmakers) {
        const market = (bm.markets || []).find(m => m.key === 'h2h');
        if (!market) continue;
        const overround = market.outcomes.reduce((sum, o) => sum + 1 / o.price, 0);
        for (const outcome of market.outcomes) {
          const fairProb = (1 / outcome.price) / overround;
          (probsByTeam[outcome.name] ||= []).push(fairProb);
          (oddsByTeam[outcome.name] ||= []).push(outcome.price);
        }
      }

      const implied = Object.keys(probsByTeam).map(team => ({
        team,
        implied_probability: Number(avg(probsByTeam[team]).toFixed(4)),
        avg_decimal_odds: Number(avg(oddsByTeam[team]).toFixed(3))
      })).sort((a, b) => b.implied_probability - a.implied_probability);

      if (!implied.length) continue;

      // Ask Cloudflare Llama 3.1
      let llmPick = 'no_bet';
      let confidence = 0;
      let reasoning = '';
      let llmParseFailed = false;

      try {
        const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messages: [
              {
                role: 'system',
                content: 'You are a sports betting analyst. You are given bookmaker-implied win probabilities that have already been de-vigged (overround removed). Decide if there is a value pick worth flagging. Reply with ONLY compact JSON, no prose, no markdown fences: {"pick": string, "confidence": number between 0 and 1, "reasoning": string under 40 words}. "pick" must be exactly one of the team names given, or the string "no_bet" if you see no edge worth flagging.'
              },
              {
                role: 'user',
                content: `Event: ${event.home_team} vs ${event.away_team}. Sport: ${cleanSport}. Commence: ${event.commence_time}. Market-implied probabilities: ${JSON.stringify(implied)}`
              }
            ]
          })
        });

        const cfData = await cfRes.json();
        let candidate = cfData.result?.response || cfData.response;
        if (!candidate && cfData.result?.choices?.[0]?.message) {
          candidate = cfData.result.choices[0].message.content;
        }

        let parsed;
        if (typeof candidate === 'object' && candidate !== null) {
          parsed = candidate;
        } else if (typeof candidate === 'string') {
          const match = candidate.match(/\{[\s\S]*\}/);
          parsed = match ? JSON.parse(match[0]) : JSON.parse(candidate);
        }

        if (parsed && parsed.pick) {
          llmPick = parsed.pick;
          confidence = parsed.confidence ?? 0.5;
          reasoning = parsed.reasoning || '';
        } else {
          llmPick = 'no_bet';
          reasoning = 'No clear edge identified';
        }
      } catch (err) {
        console.error('[Pipeline] Cloudflare AI error for event:', event.id, err.message);
        llmPick = 'no_bet';
        reasoning = 'AI analysis unavailable: ' + err.message;
        llmParseFailed = true;
      }

      const pickedOdds = implied.find(p => p.team === llmPick) || null;

      const record = {
        id: crypto.randomUUID(),
        received_at: new Date().toISOString(),
        actual_result: null,
        event_id: event.id,
        sport: cleanSport,
        home_team: event.home_team,
        away_team: event.away_team,
        commence_time: event.commence_time,
        bookmaker_count: event.bookmakers.length,
        market_implied_probabilities: implied,
        llm_pick: llmPick,
        llm_confidence: confidence,
        llm_reasoning: reasoning,
        llm_parse_failed: llmParseFailed,
        picked_avg_decimal_odds: pickedOdds ? pickedOdds.avg_decimal_odds : null,
        fx_usd_to_inr: usdToInr,
        generated_at: new Date().toISOString()
      };

      db.append('predictions', record);
      predictions.push(record);
    }
  }

  console.log(`[Pipeline] Completed. Ingested ${predictions.length} predictions.`);
  return { ok: true, count: predictions.length };
}

module.exports = { runPipeline };
