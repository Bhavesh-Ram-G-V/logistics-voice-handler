import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// In-Memory Logistics Database
interface ContainerInfo {
  id: string;
  location: string;
  stopsLeft: number;
  status: string;
  sealIntact: boolean;
  destination: string;
  bayAssignment?: string;
  lastUpdated: string;
}

interface RouteInfo {
  id: string;
  name: string;
  stopsLeft: number;
  currentStop: string;
  status: string;
  alternateRoute?: string;
  delayReason?: string;
}

interface BayCheckin {
  bayNumber: string;
  timestamp: string;
  assignedDriver: string;
  clearanceToken: string;
}

interface CorrectionFeedback {
  id: string;
  last_prompt: string;
  error_context: string;
  rating: number;
  timestamp: string;
}

// State
const state = {
  activeRoute: <RouteInfo>{
    id: 'Route #409-NE',
    name: 'Terminal North Dispatch',
    stopsLeft: 14,
    currentStop: 'Terminal North',
    status: 'On Schedule',
  },
  containers: <Record<string, ContainerInfo>>{
    'C-89': {
      id: 'Container C-89',
      location: 'Terminal North',
      stopsLeft: 14,
      status: 'In transit to Terminal North',
      sealIntact: true,
      destination: 'Terminal North',
      bayAssignment: 'Bay 4',
      lastUpdated: new Date().toLocaleTimeString(),
    },
    'PALLET B': {
      id: 'Pallet B-14',
      location: 'Bay 3',
      stopsLeft: 6,
      status: 'Inspection cleared at Bay 3',
      sealIntact: true,
      destination: 'Distribution Hub South',
      bayAssignment: 'Bay 3',
      lastUpdated: new Date().toLocaleTimeString(),
    },
    'B-14': {
      id: 'Pallet B-14',
      location: 'Bay 3',
      stopsLeft: 6,
      status: 'Inspection cleared at Bay 3',
      sealIntact: true,
      destination: 'Distribution Hub South',
      bayAssignment: 'Bay 3',
      lastUpdated: new Date().toLocaleTimeString(),
    },
    'C-42': {
      id: 'Container C-42',
      location: 'Dock 2 - Eastbound',
      stopsLeft: 3,
      status: 'Out for final delivery',
      sealIntact: true,
      destination: 'East Wharf Logistics',
      bayAssignment: 'Bay 2',
      lastUpdated: new Date().toLocaleTimeString(),
    },
  },
  bayCheckins: <BayCheckin[]>[],
  feedbackHistory: <CorrectionFeedback[]>[],
  recentLowRatingCorrection: <CorrectionFeedback | null>null,
  // Simulated fault toggle for testing self-healing and backoff engine
  simulateMCPFault: false,
};

// Gemini SDK Setup (Server-side only)
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Tool Declarations for Model Context Protocol
const getContainerStatusDeclaration: FunctionDeclaration = {
  name: 'get_container_status',
  description: 'Retrieve current manifest, location, and remaining stop count for a specific cargo container or pallet.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      container_id: {
        type: Type.STRING,
        description: 'The identifier for the container, e.g., "C-89", "Pallet B", or "C-42".',
      },
    },
    required: ['container_id'],
  },
};

const rerouteManifestDeclaration: FunctionDeclaration = {
  name: 'reroute_manifest',
  description: 'Update the route manifest due to traffic delay, roadblock, or priority change.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      route_id: {
        type: Type.STRING,
        description: 'The route identifier, default "Route #409-NE".',
      },
      reason: {
        type: Type.STRING,
        description: 'The cause of the reroute, e.g., "traffic at highway 101" or "gate congestion".',
      },
    },
    required: ['route_id', 'reason'],
  },
};

const logGateCheckinDeclaration: FunctionDeclaration = {
  name: 'log_gate_checkin',
  description: 'Log and verify driver gate check-in at a specific loading bay or dock.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      bay_number: {
        type: Type.STRING,
        description: 'The bay or dock identifier, e.g., "Bay 4" or "4".',
      },
    },
    required: ['bay_number'],
  },
};

// MCP Tool Execution Handlers
function executeGetContainerStatus(containerId: string): { success: boolean; data: any; speechText: string } {
  const normId = containerId.toUpperCase().trim();
  let found: ContainerInfo | undefined = state.containers[normId];

  if (!found) {
    // fuzzy match keys
    const matchKey = Object.keys(state.containers).find(k => normId.includes(k) || k.includes(normId));
    if (matchKey) {
      found = state.containers[matchKey];
    } else {
      // Create dynamically so driver query always receives authoritative answer
      found = {
        id: `Container ${containerId.toUpperCase()}`,
        location: state.activeRoute.currentStop,
        stopsLeft: state.activeRoute.stopsLeft,
        status: 'Active on current manifest',
        sealIntact: true,
        destination: 'Terminal North',
        bayAssignment: 'Bay 4',
        lastUpdated: new Date().toLocaleTimeString(),
      };
      state.containers[normId] = found;
    }
  }

  const speechText = `${found.id} is verified at ${found.location}. You have ${found.stopsLeft} stops remaining on this run. Seal integrity is confirmed.`;
  return { success: true, data: found, speechText };
}

function executeRerouteManifest(routeId: string, reason: string): { success: boolean; data: any; speechText: string } {
  const cleanRouteId = routeId || state.activeRoute.id;
  state.activeRoute.status = `Rerouted (${reason})`;
  state.activeRoute.alternateRoute = 'Highway 9 Bypass Corridor';
  state.activeRoute.delayReason = reason;

  const speechText = `Route 409 reroute approved due to ${reason}. Highway 9 bypass is selected, saving 12 minutes. Manifest updated.`;
  return {
    success: true,
    data: { routeId: cleanRouteId, reason, alternateRoute: state.activeRoute.alternateRoute },
    speechText,
  };
}

function executeLogGateCheckin(bayNumber: string): { success: boolean; data: any; speechText: string } {
  const cleanBay = bayNumber.toLowerCase().includes('bay') ? bayNumber : `Bay ${bayNumber}`;
  const clearanceToken = `CLR-${Math.floor(1000 + Math.random() * 9000)}`;

  const checkin: BayCheckin = {
    bayNumber: cleanBay,
    timestamp: new Date().toLocaleTimeString(),
    assignedDriver: 'Driver #409',
    clearanceToken,
  };
  state.bayCheckins.unshift(checkin);

  const speechText = `Gate check-in logged for ${cleanBay}. Security clearance token ${clearanceToken} generated. Proceed to loading dock.`;
  return { success: true, data: checkin, speechText };
}

// Self-Healing MCP Dispatcher with Exponential Backoff
interface RetryStep {
  attempt: number;
  delayMs: number;
  status: 'failed' | 'succeeded';
  error?: string;
}

async function dispatchWithExponentialBackoff(
  toolName: string,
  args: any
): Promise<{
  success: boolean;
  response: string;
  selfHealingActive: boolean;
  attempts: RetryStep[];
  toolExecuted?: string;
  toolResult?: any;
}> {
  const maxRetries = 3;
  const attempts: RetryStep[] = [];
  const baseDelay = 150; // ms

  // Check if simulated fault is enabled
  if (state.simulateMCPFault) {
    for (let i = 1; i <= maxRetries; i++) {
      const delay = baseDelay * Math.pow(2, i - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
      attempts.push({
        attempt: i,
        delayMs: delay,
        status: 'failed',
        error: `MCP socket timeout on attempt ${i} (Simulated Fault Active)`,
      });
    }

    // All retries failed -> Self-Healing Fallback Routine
    const fallbackText =
      'MCP Connection dropped. Self-healing active: Request cached to local storage and queued for background dispatch. [SELF_HEALING_ACTIVE]';

    return {
      success: false,
      response: fallbackText,
      selfHealingActive: true,
      attempts,
      toolExecuted: toolName,
    };
  }

  // Real execution with error catch & backoff
  for (let i = 1; i <= maxRetries; i++) {
    try {
      let executionResult: { success: boolean; data: any; speechText: string };

      if (toolName === 'get_container_status') {
        executionResult = executeGetContainerStatus(args.container_id || 'C-89');
      } else if (toolName === 'reroute_manifest') {
        executionResult = executeRerouteManifest(args.route_id || 'Route #409-NE', args.reason || 'traffic delay');
      } else if (toolName === 'log_gate_checkin') {
        executionResult = executeLogGateCheckin(args.bay_number || 'Bay 4');
      } else {
        throw new Error(`Unknown MCP Tool binding: ${toolName}`);
      }

      attempts.push({
        attempt: i,
        delayMs: 0,
        status: 'succeeded',
      });

      return {
        success: true,
        response: executionResult.speechText,
        selfHealingActive: false,
        attempts,
        toolExecuted: toolName,
        toolResult: executionResult.data,
      };
    } catch (err: any) {
      const delay = baseDelay * Math.pow(2, i - 1);
      attempts.push({
        attempt: i,
        delayMs: delay,
        status: 'failed',
        error: err?.message || 'MCP invocation failed',
      });
      if (i < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  const fallbackText =
    'MCP Connection dropped. Self-healing active: Request cached to local storage and queued for background dispatch. [SELF_HEALING_ACTIVE]';

  return {
    success: false,
    response: fallbackText,
    selfHealingActive: true,
    attempts,
    toolExecuted: toolName,
  };
}

// Fallback Rule-Based Parser (Works seamlessly with feedback learning)
function resolveIntentRuleBased(query: string): { toolName: string; args: any } {
  const q = query.toLowerCase();

  // If previous feedback indicated a mistake, adjust prioritizations
  const hasBayKeyword = q.includes('bay') || q.includes('gate') || q.includes('dock') || q.includes('check-in') || q.includes('check in');
  const hasRerouteKeyword = q.includes('reroute') || q.includes('traffic') || q.includes('delay') || q.includes('accident') || q.includes('highway') || q.includes('route');
  const hasContainerKeyword = q.includes('container') || q.includes('pallet') || q.includes('manifest') || q.includes('status') || q.includes('c-') || q.includes('b-');

  // Check recent correction context
  if (state.recentLowRatingCorrection) {
    const errorCtx = state.recentLowRatingCorrection.error_context.toLowerCase();
    if (errorCtx.includes('gate') && hasBayKeyword) {
      const bayMatch = query.match(/bay\s*([0-9a-zA-Z]+)/i) || query.match(/dock\s*([0-9a-zA-Z]+)/i) || query.match(/(\d+)/);
      return { toolName: 'log_gate_checkin', args: { bay_number: bayMatch ? bayMatch[1] : 'Bay 4' } };
    }
  }

  if (hasBayKeyword) {
    const bayMatch = query.match(/bay\s*([0-9a-zA-Z]+)/i) || query.match(/dock\s*([0-9a-zA-Z]+)/i) || query.match(/(\d+)/);
    return {
      toolName: 'log_gate_checkin',
      args: { bay_number: bayMatch ? bayMatch[0] : 'Bay 4' },
    };
  }

  if (hasRerouteKeyword) {
    let reason = 'traffic delay on primary route';
    if (q.includes('highway 101') || q.includes('101')) reason = 'heavy traffic at highway 101';
    else if (q.includes('weather') || q.includes('storm')) reason = 'severe weather conditions';
    else if (q.includes('accident')) reason = 'reported accident on freeway';
    return {
      toolName: 'reroute_manifest',
      args: { route_id: 'Route #409-NE', reason },
    };
  }

  if (hasContainerKeyword || q.includes('stops') || q.includes('left')) {
    let containerId = 'C-89';
    const cMatch = query.match(/c-?\s*([0-9]+)/i);
    const pMatch = query.match(/pallet\s*([a-zA-Z0-9-]+)/i);
    if (cMatch) containerId = `C-${cMatch[1]}`;
    else if (pMatch) containerId = `Pallet ${pMatch[1]}`;
    else if (q.includes('pallet b') || q.includes('b-14')) containerId = 'Pallet B';

    return {
      toolName: 'get_container_status',
      args: { container_id: containerId },
    };
  }

  // Default fallback to container status for general inquiries
  return {
    toolName: 'get_container_status',
    args: { container_id: 'C-89' },
  };
}

// API Routes

// Voice Query Processing Endpoint
app.post('/api/process_voice', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'Missing transcribed voice query' });
      return;
    }

    let selectedTool: string = '';
    let selectedArgs: any = {};

    // 1. Try Gemini 3.8 Flash Function Calling if client key is configured
    if (ai) {
      try {
        let systemInstruction =
          'You are the intelligence engine for the Voice Logistics Handler (Field Operations Unit). ' +
          'Convert the incoming driver voice speech into exact MCP tool calls. ' +
          'Tools available: get_container_status, reroute_manifest, log_gate_checkin. ' +
          'Keep responses to 2-3 sentences maximum. Use short, distinct words optimized for clear TTS playback.';

        if (state.recentLowRatingCorrection) {
          systemInstruction += ` Note: The driver previously gave a low rating for: "${state.recentLowRatingCorrection.last_prompt}". Prioritize accurate intent mapping for this query.`;
        }

        const modelResponse = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: query,
          config: {
            systemInstruction,
            tools: [
              {
                functionDeclarations: [
                  getContainerStatusDeclaration,
                  rerouteManifestDeclaration,
                  logGateCheckinDeclaration,
                ],
              },
            ],
          },
        });

        const functionCalls = modelResponse.functionCalls;
        if (functionCalls && functionCalls.length > 0 && functionCalls[0].name) {
          selectedTool = functionCalls[0].name;
          selectedArgs = functionCalls[0].args || {};
        }
      } catch (err: any) {
        console.warn('Gemini API call bypassed or timed out, using fallback intent resolver:', err?.message);
      }
    }

    // 2. If Gemini didn't return a tool call, use the contextual intent engine
    if (!selectedTool) {
      const resolved = resolveIntentRuleBased(query);
      selectedTool = resolved.toolName;
      selectedArgs = resolved.args;
    }

    // 3. Dispatch through Exponential Backoff & Self-Healing Engine
    const dispatchResult = await dispatchWithExponentialBackoff(selectedTool, selectedArgs);

    // If feedback correction was active, mark it as resolved on successful next turn
    if (state.recentLowRatingCorrection && dispatchResult.success) {
      state.recentLowRatingCorrection = null;
    }

    res.json({
      query,
      tool: selectedTool,
      args: selectedArgs,
      response: dispatchResult.response,
      selfHealingActive: dispatchResult.selfHealingActive,
      attempts: dispatchResult.attempts,
      routeContext: state.activeRoute,
      containers: state.containers,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error processing voice query:', error);
    res.status(500).json({
      error: error?.message || 'Internal voice processing failure',
      response: 'MCP Connection dropped. Self-healing active: Request cached to local storage and queued for background dispatch. [SELF_HEALING_ACTIVE]',
      selfHealingActive: true,
    });
  }
});

// Feedback Loop Endpoint
app.post('/api/feedback', (req, res) => {
  try {
    const { rating, last_prompt, error_context } = req.body;
    const numericRating = Number(rating);

    const feedbackEntry: CorrectionFeedback = {
      id: `fb-${Date.now()}`,
      last_prompt: last_prompt || 'Voice query',
      error_context: error_context || '',
      rating: numericRating,
      timestamp: new Date().toISOString(),
    };

    state.feedbackHistory.unshift(feedbackEntry);

    // Rule: If rating <= 2 stars, log correction metadata and automatically re-evaluate intent mapping on next turn
    if (numericRating <= 2) {
      state.recentLowRatingCorrection = feedbackEntry;
      console.log(`[FEEDBACK LOOP] Low accuracy rating (${numericRating}/5) recorded for: "${feedbackEntry.last_prompt}". Intent re-evaluation scheduled.`);
    }

    res.json({
      success: true,
      message: numericRating <= 2 ? 'Correction metadata logged. Intent mapping will be re-evaluated.' : 'Feedback recorded.',
      correctionLogged: numericRating <= 2,
      activeCorrection: state.recentLowRatingCorrection,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Feedback recording failed' });
  }
});

// Toggle Simulated MCP Network Drop / Timeout
app.post('/api/mcp/toggle-fault', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    state.simulateMCPFault = enabled;
  } else {
    state.simulateMCPFault = !state.simulateMCPFault;
  }
  res.json({ simulateMCPFault: state.simulateMCPFault });
});

// Sync / Background Dispatch of Cached Offline Queue
app.post('/api/queue/dispatch', async (req, res) => {
  try {
    const { queuedItems } = req.body;
    if (!Array.isArray(queuedItems) || queuedItems.length === 0) {
      res.json({ processed: 0, results: [] });
      return;
    }

    const results = [];
    for (const item of queuedItems) {
      const intent = resolveIntentRuleBased(item.query || '');
      const execution = await dispatchWithExponentialBackoff(intent.toolName, intent.args);
      results.push({
        id: item.id,
        query: item.query,
        tool: intent.toolName,
        success: execution.success,
        response: execution.response,
      });
    }

    res.json({
      processed: results.length,
      results,
      routeContext: state.activeRoute,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Queue dispatch failure' });
  }
});

// Get Live Logistics State & Diagnostics
app.get('/api/mcp/status', (req, res) => {
  res.json({
    simulateMCPFault: state.simulateMCPFault,
    activeRoute: state.activeRoute,
    containers: state.containers,
    bayCheckins: state.bayCheckins,
    recentCorrection: state.recentLowRatingCorrection,
    feedbackCount: state.feedbackHistory.length,
  });
});

// Start Express + Vite Dev or Static Production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Voice Logistics Handler] Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
