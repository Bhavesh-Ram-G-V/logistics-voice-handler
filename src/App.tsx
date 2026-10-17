/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Truck,
  RotateCcw,
  Volume2,
  CheckCircle2,
  AlertTriangle,
  Radio,
  Server,
  Zap,
  HardDrive,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Activity,
  Sparkles,
  Battery,
  BatteryCharging,
  BatteryFull,
  BatteryMedium,
  BatteryLow,
  BatteryWarning,
  History,
  Clock,
  WifiOff,
  X,
  MapPin,
  Navigation,
} from 'lucide-react';
import * as d3 from 'd3';

interface RouteContext {
  id: string;
  name: string;
  stopsLeft: number;
  currentStop: string;
  status: string;
  alternateRoute?: string;
  delayReason?: string;
}

interface QueuedRequest {
  id: string;
  query: string;
  timestamp: string;
  status: 'pending' | 'dispatched';
}

interface RetryAttempt {
  attempt: number;
  delayMs: number;
  status: 'failed' | 'succeeded';
  error?: string;
}

interface CorrectionFeedback {
  id: string;
  last_prompt: string;
  error_context: string;
  rating: number;
  timestamp: string;
}

interface BatteryState {
  level: number;
  charging: boolean;
  supported: boolean;
}

interface VoiceHistoryItem {
  id: string;
  query: string;
  response: string;
  timestamp: string;
  tool?: string;
}

interface WaypointNode {
  id: number;
  name: string;
  code: string;
  distance: string;
  eta: string;
  active: boolean;
  x?: number;
  y?: number;
}

const WAYPOINTS: WaypointNode[] = [
  { id: 1, name: 'Terminal North', code: 'TN-01', distance: 'Active Stop', eta: 'Now', active: true },
  { id: 2, name: 'Bay 4 Check-In', code: 'BY-04', distance: '+2.1 mi', eta: '08:45 AM', active: false },
  { id: 3, name: 'Depot Central', code: 'DC-03', distance: '+4.5 mi', eta: '09:05 AM', active: false },
  { id: 4, name: 'Cold-Chain Bay 3', code: 'CC-03', distance: '+7.2 mi', eta: '09:25 AM', active: false },
  { id: 5, name: 'West Wharf Hub', code: 'WW-05', distance: '+9.8 mi', eta: '09:50 AM', active: false },
  { id: 6, name: 'Industrial Gateway', code: 'IG-06', distance: '+12.4 mi', eta: '10:15 AM', active: false },
  { id: 7, name: 'Highway 101 Depot', code: 'HW-07', distance: '+15.1 mi', eta: '10:40 AM', active: false },
  { id: 8, name: 'North River Silos', code: 'NR-08', distance: '+18.3 mi', eta: '11:05 AM', active: false },
  { id: 9, name: 'Cross-Dock Delta', code: 'CD-09', distance: '+21.0 mi', eta: '11:30 AM', active: false },
  { id: 10, name: 'Airport Cargo Terminal', code: 'AC-10', distance: '+24.6 mi', eta: '11:55 AM', active: false },
  { id: 11, name: 'Eastbound Spur', code: 'ES-11', distance: '+27.4 mi', eta: '12:20 PM', active: false },
  { id: 12, name: 'Substation Dock 2', code: 'SD-12', distance: '+30.8 mi', eta: '12:45 PM', active: false },
  { id: 13, name: 'Midtown Transfer', code: 'MT-13', distance: '+33.9 mi', eta: '01:10 PM', active: false },
  { id: 14, name: 'South Harbor Gate', code: 'SH-14', distance: '+36.5 mi', eta: '01:35 PM', active: false },
];

export default function App() {
  // Voice & Input State
  const [isListening, setIsListening] = useState<boolean>(false);
  const [transcription, setTranscription] = useState<string>('');
  const [isInterim, setIsInterim] = useState<boolean>(false);
  const [inputTimestamp, setInputTimestamp] = useState<string>('--:--');

  // Agent Output State
  const [agentResponse, setAgentResponse] = useState<string>(
    'Awaiting driver input. Dispatches, manifest updates, and waypoint queries will be announced here.'
  );
  const [responseTimestamp, setResponseTimestamp] = useState<string>('--:--');
  const [lastUtterance, setLastUtterance] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // System & MCP Status State
  const [mcpStatus, setMcpStatus] = useState<'online' | 'reconnecting' | 'self_healing'>('online');
  const [simulateMCPFault, setSimulateMCPFault] = useState<boolean>(false);
  const [retryHistory, setRetryHistory] = useState<RetryAttempt[]>([]);
  const [lastExecutedTool, setLastExecutedTool] = useState<string>('');
  const [lastToolArgs, setLastToolArgs] = useState<any>(null);

  // Logistics Route Context
  const [routeContext, setRouteContext] = useState<RouteContext>({
    id: 'Route #409-NE',
    name: 'Terminal North Dispatch',
    stopsLeft: 14,
    currentStop: 'Terminal North',
    status: 'On Schedule',
  });

  // Offline / Self-Healing Cache in localStorage
  const [offlineQueue, setOfflineQueue] = useState<QueuedRequest[]>(() => {
    try {
      const stored = localStorage.getItem('mcp_offline_queue');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Feedback State
  const [rating, setRating] = useState<number>(3);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<boolean>(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string>('');
  const [correctionNotice, setCorrectionNotice] = useState<string | null>(null);
  const [correctionLogs, setCorrectionLogs] = useState<CorrectionFeedback[]>([]);

  // Battery Status API State
  const [battery, setBattery] = useState<BatteryState>({
    level: 94,
    charging: false,
    supported: false,
  });

  // Voice Interaction History (last 5 successful queries)
  const [voiceHistory, setVoiceHistory] = useState<VoiceHistoryItem[]>(() => {
    try {
      const stored = localStorage.getItem('field_voice_history');
      if (stored) return JSON.parse(stored);
    } catch {
      // fallback
    }
    return [
      {
        id: 'vh-init-1',
        query: 'Status of Container C-89',
        response: 'Container C-89 is verified at Terminal North. You have 14 stops remaining on this run. Seal integrity is confirmed.',
        timestamp: '08:30:12 AM',
        tool: 'get_container_status',
      },
      {
        id: 'vh-init-2',
        query: 'Log gate check-in at Bay 4',
        response: 'Gate check-in logged for Bay 4. Security clearance token CLR-4091 generated. Proceed to loading dock.',
        timestamp: '08:15:40 AM',
        tool: 'log_gate_checkin',
      },
    ];
  });

  // Offline Queue Reconnection Sync Progress
  const [syncProgress, setSyncProgress] = useState<{
    isSyncing: boolean;
    total: number;
    synced: number;
    lastCompletedTime: string | null;
  }>({
    isSyncing: false,
    total: 0,
    synced: 0,
    lastCompletedTime: null,
  });

  // Offline Toast Notification State
  const [showOfflineToast, setShowOfflineToast] = useState<boolean>(false);
  const [toastDismissed, setToastDismissed] = useState<boolean>(false);

  // D3 Route Waypoints Visualizer State
  const d3SvgRef = useRef<SVGSVGElement | null>(null);
  const [selectedWaypoint, setSelectedWaypoint] = useState<WaypointNode>(WAYPOINTS[0]);

  // Diagnostics Panel toggle
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);

  // Speech Recognition reference
  const recognitionRef = useRef<any>(null);
  const isListeningRef = useRef<boolean>(false);

  // Sync offline queue to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('mcp_offline_queue', JSON.stringify(offlineQueue));
    } catch (e) {
      console.warn('LocalStorage save error:', e);
    }
  }, [offlineQueue]);

  // Sync voice history to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('field_voice_history', JSON.stringify(voiceHistory));
    } catch (e) {
      console.warn('Voice history save error:', e);
    }
  }, [voiceHistory]);

  // Network Offline/Online Detection
  useEffect(() => {
    const handleOffline = () => {
      setMcpStatus('self_healing');
      setShowOfflineToast(true);
      setToastDismissed(false);
    };

    const handleOnline = () => {
      setMcpStatus('online');
      setShowOfflineToast(false);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      handleOffline();
    }

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // D3 SVG Waypoints Renderer
  useEffect(() => {
    if (!d3SvgRef.current) return;

    const svg = d3.select(d3SvgRef.current);
    svg.selectAll('*').remove();

    // Map 14 waypoints across 2 continuous rows
    const waypointsWithCoords = WAYPOINTS.map((wp, index) => {
      let x = 0;
      let y = 0;
      if (index < 7) {
        // Row 1 (Stops 1 to 7): left to right
        x = 28 + index * 53;
        y = 28;
      } else {
        // Row 2 (Stops 8 to 14): right to left
        x = 346 - (index - 7) * 53;
        y = 66;
      }
      return { ...wp, x, y };
    });

    const defs = svg.append('defs');

    // Route corridor gradient
    const gradient = defs
      .append('linearGradient')
      .attr('id', 'routeCorridorGradient')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '100%');

    gradient.append('stop').attr('offset', '0%').attr('stop-color', '#38bdf8');
    gradient.append('stop').attr('offset', '55%').attr('stop-color', '#0284c7');
    gradient.append('stop').attr('offset', '100%').attr('stop-color', '#10b981');

    // Glow filter for active waypoint
    const filter = defs
      .append('filter')
      .attr('id', 'activeWaypointGlow')
      .attr('x', '-50%')
      .attr('y', '-50%')
      .attr('width', '200%')
      .attr('height', '200%');
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Connected Corridor Path Points
    const pathPoints: [number, number][] = [
      ...waypointsWithCoords.slice(0, 7).map(w => [w.x!, w.y!] as [number, number]),
      [368, 47], // Right turnaround arc
      ...waypointsWithCoords.slice(7).map(w => [w.x!, w.y!] as [number, number]),
    ];

    const lineGenerator = d3
      .line()
      .curve(d3.curveCatmullRom.alpha(0.5));

    // Road track underlay
    svg
      .append('path')
      .attr('d', lineGenerator(pathPoints))
      .attr('fill', 'none')
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 6)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round');

    // Active Route Corridor Dashed Line
    svg
      .append('path')
      .attr('d', lineGenerator(pathPoints))
      .attr('fill', 'none')
      .attr('stroke', 'url(#routeCorridorGradient)')
      .attr('stroke-width', 2.5)
      .attr('stroke-dasharray', '5 3')
      .attr('stroke-linecap', 'round')
      .attr('opacity', 0.9);

    // Node Groups
    const nodeGroups = svg
      .selectAll('g.waypoint-node')
      .data(waypointsWithCoords)
      .enter()
      .append('g')
      .attr('class', 'waypoint-node')
      .attr('transform', d => `translate(${d.x}, ${d.y})`)
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        setSelectedWaypoint(d);
      });

    // Inactive Nodes (2 to 14)
    nodeGroups
      .filter(d => !d.active)
      .append('circle')
      .attr('r', 6.5)
      .attr('fill', d => (d.id === selectedWaypoint.id ? '#1e293b' : '#0f172a'))
      .attr('stroke', d => (d.id === selectedWaypoint.id ? '#38bdf8' : '#475569'))
      .attr('stroke-width', d => (d.id === selectedWaypoint.id ? 2 : 1.5));

    nodeGroups
      .filter(d => !d.active)
      .append('text')
      .attr('dy', 2.5)
      .attr('text-anchor', 'middle')
      .attr('fill', d => (d.id === selectedWaypoint.id ? '#38bdf8' : '#94a3b8'))
      .attr('font-size', '7px')
      .attr('font-family', 'monospace')
      .attr('font-weight', '700')
      .text(d => d.id);

    // Active Node (Waypoint 1: Terminal North)
    const activeGroup = nodeGroups.filter(d => d.active);

    // Outer Animated Pulse Ring
    activeGroup
      .append('circle')
      .attr('r', 13)
      .attr('fill', 'none')
      .attr('stroke', '#38bdf8')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.5)
      .attr('class', 'animate-pulse');

    // Radial Glow Halo
    activeGroup
      .append('circle')
      .attr('r', 9.5)
      .attr('fill', '#0284c7')
      .attr('opacity', 0.35)
      .attr('filter', 'url(#activeWaypointGlow)');

    // Core Active Circle
    activeGroup
      .append('circle')
      .attr('r', 7.5)
      .attr('fill', '#0284c7')
      .attr('stroke', '#38bdf8')
      .attr('stroke-width', 2.2);

    // Active Number
    activeGroup
      .append('text')
      .attr('dy', 2.5)
      .attr('text-anchor', 'middle')
      .attr('fill', '#ffffff')
      .attr('font-size', '7.5px')
      .attr('font-weight', '900')
      .attr('font-family', 'monospace')
      .text('1');

    // Floating Active Tag
    const activeTag = activeGroup.append('g').attr('transform', 'translate(0, -12)');
    activeTag
      .append('rect')
      .attr('x', -16)
      .attr('y', -7)
      .attr('width', 32)
      .attr('height', 10)
      .attr('rx', 2.5)
      .attr('fill', '#0369a1')
      .attr('stroke', '#38bdf8')
      .attr('stroke-width', 0.8);

    activeTag
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 0.5)
      .attr('fill', '#f0f9ff')
      .attr('font-size', '6.5px')
      .attr('font-weight', '800')
      .attr('font-family', 'monospace')
      .text('ACTIVE');
  }, [selectedWaypoint, routeContext.currentStop, routeContext.stopsLeft]);

  // Battery Status API Integration
  useEffect(() => {
    let batteryObj: any = null;

    const syncBattery = (b: any) => {
      setBattery({
        level: Math.round(b.level * 100),
        charging: b.charging,
        supported: true,
      });
    };

    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
      (navigator as any)
        .getBattery()
        .then((b: any) => {
          batteryObj = b;
          syncBattery(b);

          const onLevelChange = () => syncBattery(b);
          const onChargingChange = () => syncBattery(b);

          b.addEventListener('levelchange', onLevelChange);
          b.addEventListener('chargingchange', onChargingChange);
        })
        .catch(() => {
          setBattery(prev => ({ ...prev, supported: false }));
        });
    }

    return () => {
      // cleanup when unmounting
    };
  }, []);

  // Initialize SpeechRecognition on mount
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = 'en-US';

      rec.onstart = () => {
        setIsListening(true);
        isListeningRef.current = true;
      };

      rec.onresult = (event: any) => {
        let interim = '';
        let final = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }

        const displayText = final || interim;
        if (displayText.trim()) {
          setTranscription(displayText);
          setIsInterim(!final);
          setInputTimestamp(getFormattedTime());
        }

        if (final.trim()) {
          processVoiceQuery(final.trim());
        }
      };

      rec.onerror = (event: any) => {
        console.warn('SpeechRecognition event error:', event.error);
        setIsListening(false);
        isListeningRef.current = false;
        if (event.error === 'not-allowed') {
          setTranscription(
            'Microphone access denied. Grant permissions or use the quick voice prompt buttons below.'
          );
        } else if (event.error === 'no-speech') {
          // silent idle
        }
      };

      rec.onend = () => {
        setIsListening(false);
        isListeningRef.current = false;
      };

      recognitionRef.current = rec;
    }

    // Fetch initial MCP status
    fetchStatus();
  }, []);

  const getFormattedTime = (): string => {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/mcp/status');
      if (res.ok) {
        const data = await res.json();
        if (data.activeRoute) setRouteContext(data.activeRoute);
        if (data.simulateMCPFault !== undefined) setSimulateMCPFault(data.simulateMCPFault);
      }
    } catch {
      // offline/local dev mode
    }
  };

  // Web SpeechSynthesis (TTS) Playback
  const speakResponse = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      // Strip system tags like [SELF_HEALING_ACTIVE] from speech audio
      const cleanSpeech = text.replace(/\[SELF_HEALING_ACTIVE\]/g, '').trim();
      const utterance = new SpeechSynthesisUtterance(cleanSpeech);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = 'en-US';

      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(
        v =>
          v.lang.startsWith('en') &&
          (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('David'))
      );
      if (preferred) utterance.voice = preferred;

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('SpeechSynthesis error:', e);
    }
  };

  // Process Voice Query to Backend MCP Engine
  const processVoiceQuery = async (queryText: string) => {
    setIsProcessing(true);
    setInputTimestamp(getFormattedTime());
    setTranscription(queryText);
    setIsInterim(false);

    try {
      const response = await fetch('/api/process_voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText }),
      });

      const data = await response.json();

      if (data.attempts) {
        setRetryHistory(data.attempts);
      }
      if (data.tool) {
        setLastExecutedTool(data.tool);
      }
      if (data.args) {
        setLastToolArgs(data.args);
      }

      // Update route context if modified
      if (data.routeContext) {
        setRouteContext(data.routeContext);
      }

      // Handle Self-Healing tag & badge
      if (data.selfHealingActive || (data.response && data.response.includes('[SELF_HEALING_ACTIVE]'))) {
        setMcpStatus('self_healing');
        setShowOfflineToast(true);
        setToastDismissed(false);

        // Cache failed request to local storage queue
        const newQueueItem: QueuedRequest = {
          id: `queue-${Date.now()}`,
          query: queryText,
          timestamp: new Date().toLocaleTimeString(),
          status: 'pending',
        };
        setOfflineQueue(prev => [newQueueItem, ...prev]);
      } else {
        setMcpStatus('online');
      }

      const replyText = data.response || 'Logistics transaction completed.';
      setAgentResponse(replyText);
      setLastUtterance(replyText);
      setResponseTimestamp(getFormattedTime());
      speakResponse(replyText);

      // Record successful voice interaction into Voice History (max 5 items)
      if (!data.selfHealingActive && (!data.response || !data.response.includes('[SELF_HEALING_ACTIVE]'))) {
        const historyItem: VoiceHistoryItem = {
          id: `vh-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          query: queryText,
          response: replyText,
          timestamp: getFormattedTime(),
          tool: data.tool || 'get_container_status',
        };
        setVoiceHistory(prev => [historyItem, ...prev].slice(0, 5));
      }

      // If a correction was active and query succeeded, clear notification
      if (!data.selfHealingActive && correctionNotice) {
        setCorrectionNotice(null);
      }
    } catch (error: any) {
      console.warn('Network call failed, executing client-side self-healing fallback:', error);
      setMcpStatus('self_healing');
      setShowOfflineToast(true);
      setToastDismissed(false);
      const fallbackText =
        'MCP Connection dropped. Self-healing active: Request cached to local storage and queued for background dispatch. [SELF_HEALING_ACTIVE]';

      const newQueueItem: QueuedRequest = {
        id: `queue-${Date.now()}`,
        query: queryText,
        timestamp: new Date().toLocaleTimeString(),
        status: 'pending',
      };
      setOfflineQueue(prev => [newQueueItem, ...prev]);

      setAgentResponse(fallbackText);
      setLastUtterance(fallbackText);
      setResponseTimestamp(getFormattedTime());
      speakResponse(fallbackText);
    } finally {
      setIsProcessing(false);
    }
  };

  // Mic Button Toggle
  const handleMicToggle = () => {
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
    } else {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch {
          recognitionRef.current.stop();
          setTimeout(() => recognitionRef.current?.start(), 150);
        }
      } else {
        // Fallback simulated dictation
        const samples = [
          'Status of Container C-89',
          'Log gate check-in at Bay 4',
          'Report delay due to traffic at highway 101',
          'Status of Pallet B',
        ];
        const randomPrompt = samples[Math.floor(Math.random() * samples.length)];
        const promptInput = window.prompt('Simulate Voice Speech Recognition:', randomPrompt);
        if (promptInput && promptInput.trim()) {
          processVoiceQuery(promptInput.trim());
        }
      }
    }
  };

  // Clear Conversation Exchange
  const handleClear = () => {
    setTranscription('');
    setAgentResponse(
      'Awaiting driver input. Dispatches, manifest updates, and waypoint queries will be announced here.'
    );
    setInputTimestamp('--:--');
    setResponseTimestamp('--:--');
    setLastUtterance('');
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  };

  // Submit Feedback Loop
  const handleSubmitFeedback = async () => {
    setFeedbackSubmitted(true);
    setFeedbackMessage('Recording feedback...');

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating,
          last_prompt: transcription || 'General query',
          error_context: `Agent response: ${agentResponse} | Tool: ${lastExecutedTool || 'none'}`,
        }),
      });

      const data = await res.json();

      if (rating <= 2) {
        setCorrectionNotice(
          `Low accuracy (${rating}/5★) recorded. Correction metadata logged: intent mapping will be automatically adjusted on next turn.`
        );
        const logItem: CorrectionFeedback = {
          id: `fb-${Date.now()}`,
          last_prompt: transcription || 'Voice command',
          error_context: agentResponse,
          rating,
          timestamp: new Date().toLocaleTimeString(),
        };
        setCorrectionLogs(prev => [logItem, ...prev]);
        setFeedbackMessage('Correction metadata logged for next turn re-evaluation.');
      } else {
        setFeedbackMessage(`Thank you! ${rating}-Star feedback recorded.`);
      }

      setTimeout(() => {
        setFeedbackSubmitted(false);
      }, 3500);
    } catch {
      setFeedbackMessage('Feedback recorded locally.');
      setTimeout(() => setFeedbackSubmitted(false), 2500);
    }
  };

  // Toggle MCP Simulated Fault
  const handleToggleFault = async () => {
    try {
      const res = await fetch('/api/mcp/toggle-fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !simulateMCPFault }),
      });
      const data = await res.json();
      setSimulateMCPFault(data.simulateMCPFault);
      if (!data.simulateMCPFault) {
        setMcpStatus('online');
        setShowOfflineToast(false);
        // Auto-synchronize pending offline queue after reconnection
        if (offlineQueue.length > 0) {
          setTimeout(() => {
            handleDispatchQueue();
          }, 350);
        }
      } else {
        setMcpStatus('self_healing');
        setShowOfflineToast(true);
        setToastDismissed(false);
      }
    } catch {
      setSimulateMCPFault(!simulateMCPFault);
    }
  };

  // Dispatch & Sync Offline Queue with Progress Ring & Status Bar updates
  const handleDispatchQueue = async () => {
    if (offlineQueue.length === 0 || syncProgress.isSyncing) return;
    const itemsToSync = [...offlineQueue];
    const totalCount = itemsToSync.length;

    setSyncProgress({
      isSyncing: true,
      total: totalCount,
      synced: 0,
      lastCompletedTime: null,
    });

    try {
      let successfulCount = 0;
      let remaining = [...itemsToSync];

      for (let i = 0; i < itemsToSync.length; i++) {
        const item = itemsToSync[i];
        try {
          const res = await fetch('/api/process_voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: item.query }),
          });
          if (res.ok) {
            successfulCount++;
            remaining = remaining.filter(q => q.id !== item.id);
            setOfflineQueue([...remaining]);
            setSyncProgress({
              isSyncing: i + 1 < itemsToSync.length,
              total: totalCount,
              synced: successfulCount,
              lastCompletedTime: i + 1 === itemsToSync.length ? getFormattedTime() : null,
            });
          }
        } catch (e) {
          console.warn('Dispatch failed for item:', item.id, e);
          break;
        }
        if (i + 1 < itemsToSync.length) {
          await new Promise(r => setTimeout(r, 280));
        }
      }

      setSyncProgress(prev => ({
        ...prev,
        isSyncing: false,
        total: totalCount,
        synced: successfulCount,
        lastCompletedTime: getFormattedTime(),
      }));

      if (successfulCount > 0) {
        setMcpStatus('online');
        setAgentResponse(
          `Reconnection synchronized: ${successfulCount} of ${totalCount} queued request(s) processed.`
        );
        setResponseTimestamp(getFormattedTime());
      }
    } catch (err) {
      console.error('Queue sync failure:', err);
      setSyncProgress(prev => ({ ...prev, isSyncing: false }));
    }
  };

  return (
    <div className="bg-[#090d16] text-[#f8fafc] min-h-screen flex flex-col font-sans antialiased selection:bg-[#38bdf8] selection:text-[#090d16]">
      {/* Skip Navigation for WCAG AAA Accessibility */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only absolute top-4 left-4 z-50 bg-[#38bdf8] text-[#090d16] px-4 py-2 rounded-md font-bold shadow-lg"
      >
        Skip to primary controls
      </a>

      {/* Header */}
      <header className="bg-[#0f172a] border-b-2 border-slate-700/80 px-4 py-3.5 sticky top-0 z-40 backdrop-blur-md">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <span className="text-2xl" role="img" aria-label="Delivery Truck">
              🚚
            </span>
            <div className="flex flex-col">
              <h1 className="text-lg font-extrabold tracking-tight text-white leading-tight">
                Voice Logistics Handler
              </h1>
              <span className="text-[11px] font-semibold text-slate-400 tracking-wider uppercase">
                Field Operations Unit
              </span>
            </div>
          </div>

          {/* Header Actions: Battery Indicator & MCP Status Badge */}
          <div className="flex items-center gap-2">
            {/* Battery Status Indicator */}
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/90 border border-slate-700 text-xs font-mono font-semibold shadow-inner"
              role="status"
              aria-label={`Field Unit Battery: ${battery.level} percent, ${
                battery.charging ? 'Charging' : 'On battery power'
              }`}
              title={`Field Unit Battery: ${battery.level}% (${
                battery.charging ? 'Charging via vehicle dock' : 'Field unit battery'
              })`}
            >
              {battery.charging ? (
                <div className="flex items-center text-emerald-400">
                  <BatteryCharging className="w-4 h-4 animate-pulse" />
                </div>
              ) : battery.level <= 20 ? (
                <div className="flex items-center text-rose-400">
                  <BatteryWarning className="w-4 h-4 animate-bounce" />
                </div>
              ) : battery.level <= 50 ? (
                <div className="flex items-center text-amber-300">
                  <BatteryMedium className="w-4 h-4" />
                </div>
              ) : (
                <div className="flex items-center text-emerald-400">
                  <BatteryFull className="w-4 h-4" />
                </div>
              )}
              <span
                className={`text-[11px] font-bold ${
                  battery.level <= 20 ? 'text-rose-300' : 'text-slate-200'
                }`}
              >
                {battery.level}%
              </span>
            </div>

            {/* MCP Online Status Badge with High Contrast */}
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors ${
                mcpStatus === 'online'
                  ? 'bg-emerald-950/80 border-emerald-400/60 text-emerald-200'
                  : mcpStatus === 'reconnecting'
                  ? 'bg-amber-950/80 border-amber-400/60 text-amber-200'
                  : 'bg-rose-950/90 border-rose-400/80 text-rose-200'
              }`}
              role="status"
              aria-live="polite"
              aria-label={`System Status: ${
                mcpStatus === 'online'
                  ? 'MCP Online'
                  : mcpStatus === 'reconnecting'
                  ? 'MCP Reconnecting'
                  : 'Self-Healing Active'
              }`}
            >
              <span className="relative flex h-2.5 w-2.5">
                <span
                  className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                    mcpStatus === 'online'
                      ? 'bg-emerald-400'
                      : mcpStatus === 'reconnecting'
                      ? 'bg-amber-400'
                      : 'bg-rose-400'
                  }`}
                ></span>
                <span
                  className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                    mcpStatus === 'online'
                      ? 'bg-emerald-400'
                      : mcpStatus === 'reconnecting'
                      ? 'bg-amber-400'
                      : 'bg-rose-400'
                  }`}
                ></span>
              </span>
              <span className="text-xs font-bold tracking-wide">
                {mcpStatus === 'online'
                  ? 'MCP Online'
                  : mcpStatus === 'reconnecting'
                  ? 'MCP Retrying'
                  : 'Self-Healing Active'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main id="main-content" className="flex-1 max-w-md w-full mx-auto p-4 flex flex-col gap-5">
        {/* Logistics Context Quick Bar */}
        <section
          aria-label="Assigned Route Context"
          className="bg-[#1e293b] border border-slate-700 rounded-xl p-3 shadow-md flex items-center justify-between text-xs text-slate-300"
        >
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-slate-800 font-mono text-sky-300 border border-slate-600 font-bold tracking-wider">
              {routeContext.id}
            </span>
            <span className="font-semibold text-slate-200 truncate max-w-[130px]">
              {routeContext.currentStop}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-200 font-semibold bg-slate-900/60 px-2 py-1 rounded-md border border-slate-700/60">
            <span>📦</span>
            <span>{routeContext.stopsLeft} Stops Left</span>
          </div>
        </section>

        {/* D3-Powered Route Waypoints SVG Visualization */}
        <section
          aria-labelledby="route-waypoints-heading"
          className="bg-[#1e293b] border border-slate-700 rounded-xl p-3.5 shadow-md flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between border-b border-slate-700/80 pb-2">
            <div className="flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-sky-400" />
              <h2
                id="route-waypoints-heading"
                className="text-xs font-bold uppercase tracking-wider text-slate-200"
              >
                14-Stop Corridor Waypoint Map
              </h2>
            </div>
            <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-sky-950 text-sky-300 border border-sky-600/80">
              Stop 1 Active (Terminal North)
            </span>
          </div>

          {/* D3 Rendered SVG Canvas */}
          <div className="w-full bg-[#0a0f1d] rounded-lg p-2 border border-slate-800 relative overflow-hidden">
            <svg
              ref={d3SvgRef}
              viewBox="0 0 380 92"
              className="w-full h-auto select-none"
              role="img"
              aria-label="Route map rendering 14 stops as connected nodes with the active waypoint highlighted"
            ></svg>
            <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 px-1 pt-1 border-t border-slate-800/80">
              <span className="text-sky-400">Stop 1 (Active)</span>
              <span>Loop Corridor (Catmull-Rom)</span>
              <span className="text-emerald-400">Stop 14 (Final Destination)</span>
            </div>
          </div>

          {/* Selected Waypoint Detail Card */}
          <div className="flex items-center justify-between bg-[#0f172a] rounded-lg p-2.5 border border-slate-700/80 text-[11px]">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`px-1.5 py-0.5 rounded font-mono font-bold text-[10px] shrink-0 ${
                  selectedWaypoint.active
                    ? 'bg-sky-950 text-sky-300 border border-sky-600'
                    : 'bg-slate-800 text-slate-300 border border-slate-700'
                }`}
              >
                #{selectedWaypoint.id}
              </span>
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-slate-200 truncate">
                  {selectedWaypoint.name}
                </span>
                <span className="text-slate-400 font-mono text-[10px]">
                  {selectedWaypoint.code} • {selectedWaypoint.distance}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[10px] text-emerald-400 font-mono font-semibold">
                ETA {selectedWaypoint.eta}
              </span>
              <button
                type="button"
                onClick={() =>
                  processVoiceQuery(`Status of Stop ${selectedWaypoint.id} ${selectedWaypoint.name}`)
                }
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 hover:text-white border border-slate-600 hover:border-sky-400 text-[10px] font-bold cursor-pointer transition"
                aria-label={`Ask voice status for Stop ${selectedWaypoint.id}`}
              >
                Query Stop
              </button>
            </div>
          </div>
        </section>

        {/* Correction Alert Banner if <= 2 stars was submitted */}
        {correctionNotice && (
          <div
            role="alert"
            className="bg-amber-950/70 border border-amber-500/60 rounded-xl p-3 text-xs text-amber-200 flex items-start gap-2.5 shadow-md"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-bold block text-amber-300">Feedback Loop Activated:</span>
              <span>{correctionNotice}</span>
            </div>
          </div>
        )}

        {/* Core Voice Control Section */}
        <section
          aria-labelledby="voice-control-heading"
          className="bg-[#1e293b] border-2 border-slate-700 rounded-2xl p-6 shadow-xl text-center relative overflow-hidden flex flex-col items-center"
        >
          <h2 id="voice-control-heading" className="sr-only">
            Voice Command Trigger
          </h2>

          {/* Active Status Text for Screen Readers and Visuals */}
          <div
            id="mic-status-label"
            className={`text-sm font-semibold mb-4 tracking-wide uppercase flex items-center gap-2 transition-colors ${
              isListening
                ? 'text-amber-400'
                : isProcessing
                ? 'text-sky-300 animate-pulse'
                : 'text-sky-300'
            }`}
            aria-live="polite"
          >
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                isListening ? 'bg-amber-400' : isProcessing ? 'bg-sky-400' : 'bg-sky-400'
              }`}
            ></span>
            <span>
              {isListening
                ? 'Live Audio Capture Active'
                : isProcessing
                ? 'Executing MCP Tool...'
                : 'Ready for Voice Command'}
            </span>
          </div>

          {/* Pulse Ring Container */}
          <div className="relative my-2 flex items-center justify-center">
            {/* Live listening animated ring */}
            {isListening && (
              <div
                className="absolute inset-0 w-36 h-36 rounded-full bg-sky-500/20 animate-pulse-ring -m-2 pointer-events-none border border-sky-400/50"
                aria-hidden="true"
              ></div>
            )}

            {/* Big Keyboard-Focusable Mic Button */}
            <button
              id="mic-button"
              type="button"
              onClick={handleMicToggle}
              aria-label={isListening ? 'Stop Voice Input' : 'Start Voice Input'}
              aria-pressed={isListening}
              tabIndex={0}
              className={`relative z-10 w-32 h-32 rounded-full bg-gradient-to-b from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 active:scale-95 text-white flex flex-col items-center justify-center shadow-2xl transition duration-150 border-4 border-slate-900 focus-visible:ring-4 focus-visible:ring-sky-300 group cursor-pointer ${
                isListening ? 'ring-4 ring-amber-400' : ''
              }`}
            >
              <span
                className="text-4xl transition-transform duration-200 group-hover:scale-110"
                role="img"
                aria-hidden="true"
              >
                {isListening ? '⏹️' : '🎙️'}
              </span>
              <span className="text-xs font-black uppercase tracking-wider mt-1 text-sky-950 font-mono">
                {isListening ? 'Listening...' : 'Tap To Speak'}
              </span>
            </button>
          </div>

          {/* Live Waveform Animation (Visible while listening) */}
          {isListening && (
            <div
              className="h-8 flex items-center justify-center gap-1.5 mt-5"
              aria-hidden="true"
            >
              <span
                className="w-1.5 bg-sky-400 rounded-full soundwave-bar animate-soundwave"
                style={{ animationDelay: '0.1s' }}
              ></span>
              <span
                className="w-1.5 bg-sky-300 rounded-full soundwave-bar animate-soundwave"
                style={{ animationDelay: '0.3s' }}
              ></span>
              <span
                className="w-1.5 bg-sky-400 rounded-full soundwave-bar animate-soundwave"
                style={{ animationDelay: '0.15s' }}
              ></span>
              <span
                className="w-1.5 bg-sky-200 rounded-full soundwave-bar animate-soundwave"
                style={{ animationDelay: '0.4s' }}
              ></span>
              <span
                className="w-1.5 bg-sky-400 rounded-full soundwave-bar animate-soundwave"
                style={{ animationDelay: '0.25s' }}
              ></span>
            </div>
          )}

          {/* Keyboard Shortcut Helper */}
          <p className="text-xs text-slate-400 mt-4 leading-relaxed">
            <kbd className="px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sky-300 font-mono font-bold">
              Space
            </kbd>{' '}
            or{' '}
            <kbd className="px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sky-300 font-mono font-bold">
              Enter
            </kbd>{' '}
            to activate. Say commands like{' '}
            <span className="italic text-slate-300 font-medium">"Status of Pallet B"</span> or{' '}
            <span className="italic text-slate-300 font-medium">"Reroute shipment"</span>.
          </p>
        </section>

        {/* Status & Conversation Box (ARIA Live) */}
        <section
          aria-labelledby="conversation-section-heading"
          className="bg-[#1e293b] border border-slate-700 rounded-2xl p-5 shadow-lg flex flex-col gap-4"
        >
          <div className="flex items-center justify-between border-b border-slate-700 pb-2">
            <h2
              id="conversation-section-heading"
              className="text-sm font-bold uppercase tracking-wider text-slate-300"
            >
              Conversation Exchange
            </h2>
            <button
              onClick={handleClear}
              type="button"
              className="text-xs font-semibold text-slate-400 hover:text-white px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 transition cursor-pointer"
              aria-label="Clear Conversation History"
            >
              Clear
            </button>
          </div>

          {/* Recognized Voice Input Block */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="recognized-input-display"
                className="text-xs font-bold uppercase tracking-wider text-sky-300 flex items-center gap-1.5"
              >
                <span className="w-2 h-2 rounded-full bg-sky-400 inline-block"></span>
                Recognized Voice Input
              </label>
              <span className="text-[11px] text-slate-400 font-mono">{inputTimestamp}</span>
            </div>
            <div
              id="recognized-input-display"
              tabIndex={0}
              role="region"
              aria-label="Transcribed user voice speech"
              className="min-h-[58px] p-3.5 bg-[#0f172a] border-2 border-slate-700 rounded-xl text-slate-100 text-sm leading-relaxed font-medium break-words focus:border-sky-400 focus:outline-none"
            >
              {transcription ? (
                <span className={isInterim ? 'text-slate-400 italic' : 'text-white font-medium'}>
                  {transcription}
                </span>
              ) : (
                <span className="text-slate-500 italic">
                  Microphone idle. Tap the button or press Space to dictate...
                </span>
              )}
            </div>
          </div>

          {/* Agent Response Box (ARIA live="polite" for immediate screen reader announcements) */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="agent-response-display"
                className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span>
                Agent Response
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400 font-mono">{responseTimestamp}</span>
                {lastUtterance && (
                  <button
                    onClick={() => speakResponse(lastUtterance)}
                    type="button"
                    aria-label="Replay audio response aloud"
                    className="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sky-300 flex items-center gap-1 cursor-pointer transition"
                  >
                    <Volume2 className="w-3 h-3 text-sky-400" />
                    <span>Replay</span>
                  </button>
                )}
              </div>
            </div>
            {/* Live Region Element for WCAG Screen Readers */}
            <div
              id="agent-response-display"
              role="region"
              aria-live="polite"
              aria-atomic="true"
              tabIndex={0}
              aria-label="Logistics agent automated response"
              className={`min-h-[72px] p-3.5 bg-[#0f172a] border-2 rounded-xl text-sm leading-relaxed font-semibold break-words focus:outline-none ${
                mcpStatus === 'self_healing'
                  ? 'border-rose-500/80 text-rose-300'
                  : 'border-slate-700 text-emerald-300 focus:border-emerald-400'
              }`}
            >
              {agentResponse}
            </div>
          </div>
        </section>

        {/* Scrollable Voice History Component (Last 5 Interactions) */}
        <section
          aria-labelledby="voice-history-heading"
          className="bg-[#1e293b] border border-slate-700 rounded-2xl p-5 shadow-lg flex flex-col gap-3"
        >
          <div className="flex items-center justify-between border-b border-slate-700 pb-2.5">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-sky-400" />
              <h2
                id="voice-history-heading"
                className="text-sm font-bold uppercase tracking-wider text-slate-200"
              >
                Voice History
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-800 text-sky-300 border border-slate-700">
                {voiceHistory.length} / 5 Logged
              </span>
              {voiceHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => setVoiceHistory([])}
                  className="text-[11px] text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-slate-800 border border-transparent hover:border-slate-700 transition cursor-pointer"
                  aria-label="Clear Voice History"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {voiceHistory.length === 0 ? (
            <div className="p-4 rounded-xl bg-[#0f172a] border border-slate-800 text-center text-xs text-slate-500 italic">
              No recent voice interactions recorded. Dictate or tap a prompt above.
            </div>
          ) : (
            <div
              className="max-h-60 overflow-y-auto space-y-2.5 pr-1 focus:outline-none"
              tabIndex={0}
              role="feed"
              aria-label="Scrollable list of recent voice interactions"
            >
              {voiceHistory.map(item => (
                <article
                  key={item.id}
                  className="bg-[#0f172a] border border-slate-700/80 hover:border-slate-600 rounded-xl p-3 shadow-sm transition flex flex-col gap-2 group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                      <Clock className="w-3 h-3 text-slate-500" />
                      <span>{item.timestamp}</span>
                    </div>
                    {item.tool && (
                      <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300 border border-slate-700">
                        {item.tool}
                      </span>
                    )}
                  </div>

                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 flex flex-col gap-1">
                      <p className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                        <span className="text-sky-400 font-mono font-bold">›</span>
                        <span>"{item.query}"</span>
                      </p>
                      <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-2 italic">
                        {item.response}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => processVoiceQuery(item.query)}
                      disabled={isProcessing}
                      className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-900 border border-slate-600 hover:border-sky-400 text-sky-300 hover:text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-sky-400 shadow-sm"
                      aria-label={`Re-run voice query: ${item.query}`}
                      title="Re-run this voice command"
                    >
                      <RotateCcw className="w-3 h-3 text-sky-400 group-hover:rotate-[-45deg] transition-transform" />
                      <span>Re-run</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Feedback Loop Component */}
        <section
          aria-labelledby="feedback-heading"
          className="bg-[#1e293b] border border-slate-700 rounded-2xl p-5 shadow-lg flex flex-col gap-3"
        >
          <div className="flex items-center justify-between border-b border-slate-700 pb-2">
            <h2 id="feedback-heading" className="text-sm font-bold uppercase tracking-wider text-slate-200">
              Agent Accuracy Feedback
            </h2>
            <span className="text-[11px] text-slate-400 font-mono">Post-interaction loop</span>
          </div>

          <form onSubmit={e => e.preventDefault()} className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-semibold text-slate-300">
                Rate recognition & dispatch accuracy:
              </legend>

              {/* 5-Star Accessible Rating Radio Group */}
              <div
                className="flex items-center justify-between px-3 py-2 bg-[#0f172a] rounded-xl border border-slate-700"
                role="radiogroup"
                aria-label="Rating out of 5 stars"
              >
                {[1, 2, 3, 4, 5].map(star => (
                  <label
                    key={star}
                    className="cursor-pointer p-1.5 rounded focus-within:ring-2 focus-within:ring-sky-400 flex flex-col items-center"
                  >
                    <input
                      type="radio"
                      name="agent-rating"
                      value={star}
                      checked={rating === star}
                      onChange={() => setRating(star)}
                      className="sr-only rating-star-input"
                      aria-label={`${star} star${star > 1 ? 's' : ''}`}
                    />
                    <span
                      className={`star-icon text-2xl transition-colors ${
                        star <= rating ? 'text-amber-400' : 'text-slate-600'
                      }`}
                    >
                      ★
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono mt-0.5">{star}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <button
              onClick={handleSubmitFeedback}
              type="button"
              className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-900 border-2 border-slate-600 hover:border-sky-400 text-white font-bold text-sm tracking-wide transition duration-150 flex items-center justify-center gap-2 cursor-pointer focus-visible:ring-4 focus-visible:ring-sky-300"
            >
              <span>Submit Feedback</span>
              {feedbackSubmitted && (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              )}
            </button>

            {feedbackMessage && (
              <p
                role="status"
                aria-live="polite"
                className={`text-xs text-center font-semibold ${
                  rating <= 2 ? 'text-amber-300' : 'text-emerald-400'
                }`}
              >
                {feedbackMessage}
              </p>
            )}
          </form>
        </section>

        {/* Common Voice Prompts Quick Trigger Chips */}
        <section
          aria-label="Voice Command Quick Reference"
          className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 text-xs text-slate-400 flex flex-col gap-2.5 shadow-md"
        >
          <div className="font-bold text-slate-300 uppercase tracking-wide flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <span>💡</span>
              <span>Common Voice Prompts (Tap to Dictate):</span>
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {[
              {
                text: 'Status of Container C-89',
                desc: 'Manifest & stops remaining',
              },
              {
                text: 'Log gate check-in at Bay 4',
                desc: 'Dock verification & clearance token',
              },
              {
                text: 'Report delay due to traffic at highway 101',
                desc: 'Manifest reroute & bypass calculation',
              },
            ].map((promptItem, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => processVoiceQuery(promptItem.text)}
                className="w-full text-left px-3 py-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 hover:border-sky-400/80 border border-slate-700/80 transition flex items-center justify-between group cursor-pointer"
              >
                <div className="flex flex-col">
                  <span className="text-sky-300 font-semibold group-hover:text-sky-200">
                    "{promptItem.text}"
                  </span>
                  <span className="text-[10px] text-slate-400">{promptItem.desc}</span>
                </div>
                <span className="text-xs text-sky-400 opacity-60 group-hover:opacity-100 font-mono">
                  Speak →
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Diagnostics & MCP Engine Inspector Toggle */}
        <section className="border border-slate-800 rounded-xl bg-slate-900/80 overflow-hidden text-xs">
          <button
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="w-full px-4 py-3 flex items-center justify-between text-slate-300 hover:text-white font-semibold transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-sky-400" />
              <span>MCP Tool Engine &amp; Self-Healing Diagnostics</span>
            </span>
            {showDiagnostics ? (
              <ChevronUp className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {showDiagnostics && (
            <div className="p-4 pt-1 border-t border-slate-800/80 flex flex-col gap-4 text-slate-300">
              {/* Fault Injection Switch */}
              <div className="flex items-center justify-between bg-slate-800/60 p-3 rounded-lg border border-slate-700">
                <div className="flex flex-col">
                  <span className="font-bold text-slate-200">Simulate MCP Network Drop / Timeout</span>
                  <span className="text-[11px] text-slate-400">
                    Triggers 3-attempt exponential backoff and Self-Healing Fallback
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleToggleFault}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer border ${
                    simulateMCPFault
                      ? 'bg-rose-950 text-rose-200 border-rose-500'
                      : 'bg-slate-700 text-slate-200 border-slate-600 hover:bg-slate-600'
                  }`}
                >
                  {simulateMCPFault ? 'Fault Active (Dropped)' : 'Normal (Connected)'}
                </button>
              </div>

              {/* Active MCP Tool Binding Info */}
              <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800 font-mono text-[11px] space-y-1">
                <div className="text-slate-400 font-bold uppercase tracking-wider mb-1 flex items-center justify-between">
                  <span>Last Executed Tool Binding</span>
                  <span className="text-sky-400">{lastExecutedTool || 'None yet'}</span>
                </div>
                {lastToolArgs && (
                  <div className="text-slate-300 overflow-x-auto bg-slate-900/90 p-2 rounded">
                    {JSON.stringify(lastToolArgs)}
                  </div>
                )}
                {retryHistory.length > 0 && (
                  <div className="pt-2">
                    <span className="text-slate-400 block font-bold mb-1">
                      Exponential Backoff Retries:
                    </span>
                    <div className="space-y-1">
                      {retryHistory.map((step, idx) => (
                        <div
                          key={idx}
                          className={`text-[10px] flex items-center justify-between px-2 py-0.5 rounded ${
                            step.status === 'succeeded'
                              ? 'bg-emerald-950/60 text-emerald-300'
                              : 'bg-rose-950/60 text-rose-300'
                          }`}
                        >
                          <span>
                            Attempt {step.attempt}: {step.status.toUpperCase()}
                          </span>
                          <span>{step.delayMs > 0 ? `Backoff ${step.delayMs}ms` : 'Immediate'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Field Unit Battery Telemetry Diagnostics */}
              <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800 text-[11px] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-200 flex items-center gap-1.5">
                    <BatteryCharging className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Field Unit Power Telemetry (Battery Status API)</span>
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {battery.supported ? 'Web API Connected' : 'Simulated / Protected'}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-slate-900/80 p-2 rounded">
                  <span className="text-slate-300">
                    Level: <strong className="text-sky-300">{battery.level}%</strong> | State:{' '}
                    <strong className={battery.charging ? 'text-emerald-400' : 'text-slate-300'}>
                      {battery.charging ? 'Charging (Vehicle Dock)' : 'Discharging (Battery)'}
                    </strong>
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setBattery(prev => ({ ...prev, charging: !prev.charging }))}
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 border border-slate-700 cursor-pointer"
                    >
                      Toggle Charge
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setBattery(prev => ({
                          ...prev,
                          level: prev.level <= 20 ? 95 : prev.level <= 50 ? 15 : 45,
                        }))
                      }
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 border border-slate-700 cursor-pointer"
                    >
                      Cycle Level
                    </button>
                  </div>
                </div>
              </div>

              {/* Local Storage Offline Queue & Reconnection Sync Progress */}
              <div className="bg-slate-950/70 p-3.5 rounded-lg border border-slate-800 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-300 flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 text-sky-400" />
                    <span>Offline Queue &amp; Reconnection Sync</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-sky-300 border border-slate-700">
                      {offlineQueue.length} Pending
                    </span>
                    {offlineQueue.length > 0 && (
                      <button
                        type="button"
                        onClick={handleDispatchQueue}
                        disabled={syncProgress.isSyncing}
                        className="px-2.5 py-0.5 rounded bg-sky-900/80 hover:bg-sky-800 disabled:opacity-50 text-sky-200 border border-sky-600 text-[10px] font-bold cursor-pointer transition flex items-center gap-1"
                      >
                        <RefreshCw className={`w-3 h-3 ${syncProgress.isSyncing ? 'animate-spin' : ''}`} />
                        <span>{syncProgress.isSyncing ? 'Syncing...' : 'Sync Now'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress Ring & Status Bar Component */}
                {(syncProgress.total > 0 || syncProgress.isSyncing) && (
                  <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2.5">
                    <div className="flex items-center gap-3">
                      {/* Circular Progress Ring */}
                      <div className="relative w-11 h-11 shrink-0 flex items-center justify-center">
                        <svg className="w-11 h-11 -rotate-90" viewBox="0 0 44 44">
                          {/* Track Circle */}
                          <circle
                            cx="22"
                            cy="22"
                            r="17"
                            className="stroke-slate-800"
                            strokeWidth="4"
                            fill="none"
                          />
                          {/* Progress Arc */}
                          <circle
                            cx="22"
                            cy="22"
                            r="17"
                            className={`transition-all duration-300 ease-out ${
                              syncProgress.synced === syncProgress.total && syncProgress.total > 0
                                ? 'stroke-emerald-400'
                                : 'stroke-sky-400'
                            }`}
                            strokeWidth="4"
                            strokeDasharray={106.8}
                            strokeDashoffset={
                              syncProgress.total > 0
                                ? 106.8 - (syncProgress.synced / syncProgress.total) * 106.8
                                : 106.8
                            }
                            strokeLinecap="round"
                            fill="none"
                          />
                        </svg>
                        <span className="absolute text-[10px] font-mono font-bold text-slate-100">
                          {syncProgress.total > 0
                            ? `${Math.round((syncProgress.synced / syncProgress.total) * 100)}%`
                            : '0%'}
                        </span>
                      </div>

                      {/* Text & Stats */}
                      <div className="flex-1 flex flex-col justify-center">
                        <div className="flex items-center justify-between text-xs font-semibold">
                          <span className="text-slate-200 flex items-center gap-1.5">
                            {syncProgress.isSyncing ? (
                              <>
                                <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-ping"></span>
                                <span className="text-sky-300">Synchronizing Queue...</span>
                              </>
                            ) : syncProgress.synced === syncProgress.total ? (
                              <>
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-emerald-300">Reconnection Synchronized</span>
                              </>
                            ) : (
                              <span>Sync Progress</span>
                            )}
                          </span>
                          <span className="text-[11px] font-mono font-bold text-sky-300">
                            {syncProgress.synced} / {syncProgress.total} items
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 mt-0.5">
                          {syncProgress.isSyncing
                            ? 'Processing cached requests through background MCP dispatch'
                            : syncProgress.lastCompletedTime
                            ? `Last synchronized at ${syncProgress.lastCompletedTime}`
                            : 'All cached requests dispatched'}
                        </span>
                      </div>
                    </div>

                    {/* Status Bar */}
                    <div className="flex flex-col gap-1">
                      <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ease-out rounded-full ${
                            syncProgress.synced === syncProgress.total && syncProgress.total > 0
                              ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                              : 'bg-gradient-to-r from-sky-500 to-sky-400'
                          }`}
                          style={{
                            width: `${
                              syncProgress.total > 0
                                ? Math.round((syncProgress.synced / syncProgress.total) * 100)
                                : 0
                            }%`,
                          }}
                        ></div>
                      </div>
                      <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 px-0.5">
                        <span>0%</span>
                        <span>
                          {syncProgress.total > 0
                            ? `${syncProgress.synced} of ${syncProgress.total} synchronized`
                            : 'Idle'}
                        </span>
                        <span>100%</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Queue Items List */}
                {offlineQueue.length === 0 ? (
                  <div className="flex items-center justify-between text-slate-500 text-[11px]">
                    <span className="italic">No requests currently cached in local storage.</span>
                    <button
                      type="button"
                      onClick={() => {
                        const sample: QueuedRequest = {
                          id: `queue-${Date.now()}`,
                          query: 'Status of Container C-89',
                          timestamp: getFormattedTime(),
                          status: 'pending',
                        };
                        setOfflineQueue(prev => [sample, ...prev]);
                      }}
                      className="text-[10px] text-sky-400 hover:text-sky-300 underline cursor-pointer"
                    >
                      + Add test item
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                    {offlineQueue.map(item => (
                      <div
                        key={item.id}
                        className="bg-slate-900 p-2 rounded border border-slate-800 text-[11px] flex justify-between items-center"
                      >
                        <span className="text-slate-200 font-medium">"{item.query}"</span>
                        <span className="text-amber-400 font-mono text-[10px]">
                          {item.timestamp}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Correction Memory View */}
              {correctionLogs.length > 0 && (
                <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800 text-[11px]">
                  <span className="font-bold text-amber-300 block mb-1">
                    Recent Low-Rating Corrections:
                  </span>
                  <div className="space-y-1">
                    {correctionLogs.map(log => (
                      <div
                        key={log.id}
                        className="text-slate-300 bg-slate-900/80 p-1.5 rounded border border-slate-800 flex justify-between"
                      >
                        <span>
                          "{log.last_prompt}" ({log.rating}★)
                        </span>
                        <span className="text-slate-400 font-mono">{log.timestamp}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Floating Offline Toast Notification */}
      {showOfflineToast && !toastDismissed && (
        <aside
          role="status"
          aria-live="assertive"
          aria-atomic="true"
          className="fixed bottom-14 left-1/2 -translate-x-1/2 w-[92%] max-w-md z-50 animate-in fade-in slide-in-from-bottom-4 duration-300"
        >
          <div className="bg-[#0f172a]/95 border-2 border-rose-500/90 text-rose-100 shadow-[0_10px_35px_rgba(244,63,94,0.35)] backdrop-blur-md rounded-2xl p-4 flex items-start gap-3.5">
            <div className="p-2 rounded-xl bg-rose-950/90 border border-rose-500/50 text-rose-400 shrink-0 mt-0.5 relative">
              <span className="animate-ping absolute -top-1 -right-1 h-3 w-3 rounded-full bg-rose-500 opacity-75"></span>
              <span className="relative flex h-2 w-2 rounded-full bg-rose-500 absolute -top-0.5 -right-0.5"></span>
              <WifiOff className="w-5 h-5" />
            </div>

            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold uppercase tracking-wider text-rose-300 flex items-center gap-1.5">
                  Offline State Detected
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-950 border border-rose-700 text-rose-200 font-bold">
                  Self-Healing Active
                </span>
              </div>
              <p className="text-xs text-slate-200 leading-relaxed font-medium">
                MCP connection unavailable. Driver actions are being <strong className="text-rose-300 font-bold">cached locally</strong> in queue for background sync upon reconnection.
              </p>
              {offlineQueue.length > 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] font-mono font-bold text-amber-300 bg-slate-900/90 px-2 py-0.5 rounded border border-slate-700 flex items-center gap-1">
                    <HardDrive className="w-3 h-3 text-amber-400" />
                    <span>{offlineQueue.length} request(s) cached</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDiagnostics(true);
                      setToastDismissed(true);
                    }}
                    className="text-[11px] font-semibold text-sky-300 hover:text-white underline cursor-pointer"
                  >
                    View Queue →
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setToastDismissed(true)}
              className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition shrink-0 cursor-pointer"
              aria-label="Dismiss offline notification"
              title="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </aside>
      )}

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-800/80 bg-[#0f172a] p-3 text-center text-xs text-slate-400">
        <div className="max-w-md mx-auto flex justify-between items-center px-2">
          <span className="font-mono text-[11px] text-slate-400">WCAG 2.1 AAA High Contrast</span>
          <span className="text-slate-400 text-[11px]">Speech API &amp; WebSynth Ready</span>
        </div>
      </footer>
    </div>
  );
}
