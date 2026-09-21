const crypto = require('crypto');
const path = require('path');
const db = require('./db');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  // .env is optional if environment variables are already set
}

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';

// Bedrock Mantle (OpenAI-compatible)
const BEDROCK_API_KEY = process.env.BEDROCK_API_KEY || '';
const BEDROCK_BASE_URL = process.env.BEDROCK_BASE_URL || 'https://bedrock-mantle.us-east-1.api.aws/v1';
const BEDROCK_PROJECT = process.env.BEDROCK_PROJECT || 'default';
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'mistral.mistral-large-3-675b-instruct';

// Cloudflare Workers AI (Fallback)
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
const CF_MODEL = process.env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct';

const SPORTS = (process.env.SPORTS || 'basketball_nba,soccer_epl,americanfootball_nfl').split(',');
const REGIONS = process.env.REGIONS || 'us,uk,eu';

const MAX_EVENTS_PER_SPORT = Number(process.env.MAX_EVENTS_PER_SPORT || 6);

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

async function fetchAIPrediction(event, cleanSport, implied) {
  const systemPrompt = 'You are a sports betting analyst. You are given bookmaker-implied win probabilities that have already been de-vigged (overround removed). Decide if there is a value pick worth flagging. Reply with ONLY compact JSON, no prose, no markdown fences: {"pick": string, "confidence": number between 0 and 1, "reasoning": string under 40 words}. "pick" must be exactly one of the team names given, or the string "no_bet" if you see no edge worth flagging.';
  const userContent = `Event: ${event.home_team} vs ${event.away_team}. Sport: ${cleanSport}. Commence: ${event.commence_time}. Market-implied probabilities: ${JSON.stringify(implied)}`;

  // Priority 1: Bedrock Mantle (Mistral Large 3, Kimi K2.5, DeepSeek, Qwen, etc.)
  if (BEDROCK_API_KEY) {
    try {
      const res = await fetch(`${BEDROCK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BEDROCK_API_KEY}`,
          'openai-project': BEDROCK_PROJECT,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: BEDROCK_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: 150,
          temperature: 0.2
        })
      });

      if (res.ok) {
        const data = await res.json();
        return {
          content: data.choices?.[0]?.message?.content || '',
          model: BEDROCK_MODEL
        };
      }
      const errText = await res.text();
      console.warn(`[Pipeline] Bedrock Mantle unavailable (${res.status}), switching to Cloudflare AI fallback... (${errText.slice(0, 100)})`);
    } catch (e) {
      console.warn(`[Pipeline] Bedrock Mantle error (${e.message}), switching to Cloudflare AI fallback...`);
    }
  }

  // Priority 2: Cloudflare Workers AI fallback
  if (CF_ACCOUNT_ID && CF_API_TOKEN) {
    const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      })
    });

    if (!cfRes.ok) {
      const errText = await cfRes.text();
      throw new Error(`Cloudflare AI (${cfRes.status}): ${errText}`);
    }

    const cfData = await cfRes.json();
    const content = cfData.result?.response || cfData.response || cfData.result?.choices?.[0]?.message?.content || '';
    return {
      content,
      model: CF_MODEL
    };
  }

  throw new Error('No AI credentials configured in .env (set BEDROCK_API_KEY or CF_API_TOKEN)');
}

async function runPipeline() {
  const providerName = BEDROCK_API_KEY ? `Bedrock Mantle (${BEDROCK_MODEL}) [with Cloudflare fallback]` : `Cloudflare AI (${CF_MODEL})`;
  console.log(`[Pipeline] Starting on-demand sports prediction run using: ${providerName}...`);
  const usdToInr = await getFxRate();
  const allExisting = db.load('predictions');
  const existingMap = new Map(allExisting.map(p => [p.event_id, p]));
  let processedCount = 0;

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

    // Prioritize upcoming events starting soonest
    const sortedEvents = [...events].sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    const targetEvents = sortedEvents.slice(0, MAX_EVENTS_PER_SPORT);

    console.log(`[Pipeline] Analyzing ${targetEvents.length} upcoming matches for ${cleanSport}...`);

    // Process each match (de-vig & LLM pick)
    for (const event of targetEvents) {
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

      let llmPick = 'no_bet';
      let confidence = 0;
      let reasoning = '';
      let llmParseFailed = false;
      let activeModel = CF_MODEL;

      try {
        const aiResult = await fetchAIPrediction(event, cleanSport, implied);
        const candidate = aiResult.content;
        activeModel = aiResult.model;

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
        console.error('[Pipeline] AI analysis error for event:', event.id, err.message);
        llmPick = 'no_bet';
        reasoning = 'AI analysis unavailable: ' + err.message;
        llmParseFailed = true;
      }

      const pickedOdds = implied.find(p => p.team === llmPick) || null;
      const existing = existingMap.get(event.id);

      const record = {
        id: existing?.id || crypto.randomUUID(),
        received_at: existing?.received_at || new Date().toISOString(),
        actual_result: existing ? existing.actual_result : null,
        ...(existing && existing.was_correct !== undefined ? { was_correct: existing.was_correct } : {}),
        event_id: event.id,
        sport: cleanSport,
        home_team: event.home_team,
        away_team: event.away_team,
        commence_time: event.commence_time,
        bookmaker_count: event.bookmakers.length,
        market_implied_probabilities: implied,
        llm_model: activeModel,
        llm_pick: llmPick,
        llm_confidence: confidence,
        llm_reasoning: reasoning,
        llm_parse_failed: llmParseFailed,
        picked_avg_decimal_odds: pickedOdds ? pickedOdds.avg_decimal_odds : null,
        fx_usd_to_inr: usdToInr,
        generated_at: new Date().toISOString()
      };

      existingMap.set(event.id, record);
      processedCount++;
    }
  }

  const updatedPredictions = Array.from(existingMap.values());
  db.saveAll('predictions', updatedPredictions);

  console.log(`[Pipeline] Completed. Analyzed ${processedCount} matches. Total database records: ${updatedPredictions.length}.`);
  return { ok: true, count: processedCount, total: updatedPredictions.length };
}

module.exports = { runPipeline };
