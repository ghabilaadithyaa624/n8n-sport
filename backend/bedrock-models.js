/**
 * Bedrock Mantle Multi-Model Engine for Node.js
 *
 * Supported model roles:
 * - main: Mistral Large 3 (675B)
 * - coding: Qwen 3 Coder (30B A3B)
 * - reasoning: DeepSeek V3.2
 * - multimodal: Kimi K2.5
 * - math: Kimi K2 Thinking
 */

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  // optional if already set in environment
}

const BEDROCK_API_KEY = process.env.BEDROCK_API_KEY || '';
const BEDROCK_BASE_URL = process.env.BEDROCK_BASE_URL || 'https://bedrock-mantle.us-east-1.api.aws/v1';
const BEDROCK_PROJECT = process.env.BEDROCK_PROJECT || 'default';

const MODEL_ROLES = {
  main: 'mistral.mistral-large-3-675b-instruct',
  coding: 'qwen.qwen3-coder-30b-a3b-instruct',
  reasoning: 'deepseek.v3.2',
  multimodal: 'moonshotai.kimi-k2.5',
  math: 'moonshotai.kimi-k2-thinking'
};

async function callBedrock({ role = 'main', model = null, messages = [], prompt = '', systemPrompt = '', maxTokens = 300, temperature = 0.2 }) {
  if (!BEDROCK_API_KEY) {
    throw new Error('BEDROCK_API_KEY is not set in backend/.env');
  }

  const modelId = model || MODEL_ROLES[role] || MODEL_ROLES.main;

  const payloadMessages = [...messages];
  if (systemPrompt && !payloadMessages.some(m => m.role === 'system')) {
    payloadMessages.unshift({ role: 'system', content: systemPrompt });
  }
  if (prompt) {
    payloadMessages.push({ role: 'user', content: prompt });
  }

  const res = await fetch(`${BEDROCK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BEDROCK_API_KEY}`,
      'openai-project': BEDROCK_PROJECT,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelId,
      messages: payloadMessages,
      max_tokens: maxTokens,
      temperature
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bedrock Mantle error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  return choice?.content || choice?.reasoning || '';
}

module.exports = {
  MODEL_ROLES,
  callBedrock
};
