import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NicheCityTarget, ScrapedLead, TrackingNumber, CallLog, GeneratedSite, OperatorNotification } from '../types';
import { Cpu, Play, Square, TrendingUp, DollarSign, Activity, AlertCircle, CheckCircle, Database, Phone, Globe, Mail, Users, Bell, FileText, Server, ServerOff } from 'lucide-react';

type AutopilotLogType = 'info' | 'success' | 'warn' | 'income' | 'process';

interface ServerLogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: AutopilotLogType;
}

interface ServerCycleResult {
  ranAction: boolean;
  action: string;
  summary: string;
  logs: ServerLogEntry[];
  durationMs: number;
  finishedAt: string;
}

interface ServerStatus {
  isAutopilotOn: boolean;
  isAutoPitchOn: boolean;
  isAutoSubscribeOn: boolean;
  backend: string;
  intervalMs: number;
  lastCycle: ServerCycleResult | null;
  isCycleRunning: boolean;
  nextRunEstimateMs: number | null;
  uptimeMs: number;
  startedAt: string;
}

interface AutopilotViewProps {
  targets: NicheCityTarget[];
  prospects: ScrapedLead[];
  numbers: TrackingNumber[];
  calls: CallLog[];
  sites: GeneratedSite[];
  onAddTarget: (niche: string, city: string) => Promise<void>;
  onScrapeLeads: (targetId: string, niche: string, city: string) => Promise<void>;
  onGeneratePitch: (prospectId: string) => Promise<void>;
  onUpdateStatus: (prospectId: string, status: ScrapedLead['pitchStatus']) => Promise<void>;
  onAddNumber: (num: Omit<TrackingNumber, 'id' | 'createdAt' | 'isActive'>) => Promise<any>;
  onGenerateSite: (targetId: string, trackingNumberId: string) => Promise<any>;
  onSendTrialEmail: (prospectId: string, siteUrl: string, niche: string, city: string) => Promise<any>;
  onAutoSubscribe: (prospectId: string, targetId?: string, siteId?: string) => Promise<any>;
  onRefreshData: () => Promise<void>;
}

interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: AutopilotLogType;
}

export default function AutopilotView({
  targets,
  prospects,
  numbers,
  calls,
  sites,
  onAddTarget,
  onScrapeLeads,
  onGeneratePitch,
  onUpdateStatus,
  onAddNumber,
  onGenerateSite,
  onSendTrialEmail,
  onAutoSubscribe,
  onRefreshData,
}: AutopilotViewProps) {
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [isRunningCycle, setIsRunningCycle] = useState(false);
  const [lastServerLogs, setLastServerLogs] = useState<ServerLogEntry[]>([]);
  const [lastServerSummary, setLastServerSummary] = useState<string>('');

  const isAutopilotOn = serverStatus?.isAutopilotOn ?? false;
  const isAutoPitchOn = serverStatus?.isAutoPitchOn ?? true;
  const isAutoSubscribeOn = serverStatus?.isAutoSubscribeOn ?? true;
  const isServerCycleRunning = serverStatus?.isCycleRunning ?? false;

  const [optimisticAutopilotOn, setOptimisticAutopilotOn] = useState<boolean | null>(null);
  const displayAutopilotOn = optimisticAutopilotOn ?? isAutopilotOn;

  const runServerCycle = useCallback(async (): Promise<ServerCycleResult | null> => {
    try {
      const res = await fetch('/api/autopilot/run', { method: 'POST' });
      if (!res.ok) return null;
      const data = (await res.json()) as ServerCycleResult;
      if (data?.logs) setLastServerLogs(data.logs);
      if (data?.summary) setLastServerSummary(data.summary);
      return data;
    } catch {
      return null;
    }
  }, []);

  const refreshServerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/autopilot/status');
      if (!res.ok) return;
      const data = (await res.json()) as ServerStatus;
      setServerStatus(data);
      setOptimisticAutopilotOn(null);
      if (data.lastCycle) {
        setLastServerLogs(data.lastCycle.logs);
        setLastServerSummary(data.lastCycle.summary);
      }
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    refreshServerStatus();
    const id = setInterval(refreshServerStatus, 5_000);
    return () => clearInterval(id);
  }, [refreshServerStatus]);

  const lastCycleFinishedAtRef = useRef<string | null>(null);
  useEffect(() => {
    const finishedAt = serverStatus?.lastCycle?.finishedAt;
    if (finishedAt && finishedAt !== lastCycleFinishedAtRef.current) {
      lastCycleFinishedAtRef.current = finishedAt;
      onRefreshData();
    }
  }, [serverStatus?.lastCycle?.finishedAt, onRefreshData]);

  useEffect(() => {
    localStorage.setItem('rankrent_autopilot_active', String(displayAutopilotOn));
    localStorage.setItem('rankrent_autopitch_active', String(isAutoPitchOn));
    localStorage.setItem('rankrent_autosubscribe_active', String(isAutoSubscribeOn));
  }, [displayAutopilotOn, isAutoPitchOn, isAutoSubscribeOn]);

  const setServerSetting = async (patch: Partial<Pick<ServerStatus, 'isAutopilotOn' | 'isAutoPitchOn' | 'isAutoSubscribeOn'>>) => {
    if (isToggling) return;
    setIsToggling(true);
    if (typeof patch.isAutopilotOn === 'boolean') {
      setOptimisticAutopilotOn(patch.isAutopilotOn);
    }
    try {
      const res = await fetch('/api/autopilot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        await refreshServerStatus();
      } else {
        setOptimisticAutopilotOn(null);
      }
    } catch {
      setOptimisticAutopilotOn(null);
    } finally {
      setIsToggling(false);
    }
  };

  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (lastServerLogs.length === 0) return;
    setLogs(
      lastServerLogs.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        message: l.message,
        type: l.type,
      })),
    );
  }, [lastServerLogs]);

  const consoleEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const [notifications, setNotifications] = useState<OperatorNotification[]>([]);
  const [operatorEmail, setOperatorEmail] = useState<string>('halvsiebobbproductions@gmail.com');
  const refreshNotifications = async () => {
    try {
      const res = await fetch('/api/notifications');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        if (data.operatorEmail) setOperatorEmail(data.operatorEmail);
      }
    } catch (e) {
      // silent
    }
  };
  useEffect(() => {
    refreshNotifications();
    const interval = setInterval(refreshNotifications, 6000);
    return () => clearInterval(interval);
  }, []);

  const rentedCount = prospects.filter(p => p.pitchStatus === 'Rented').length;
  const trialCount = prospects.filter(p => p.pitchStatus === 'Trial').length;
  const pitchCount = prospects.filter(p => p.pitchStatus === 'Pitched').length;
  const trackerCount = numbers.length;
  const completedCallsCount = calls.filter(c => c.status === 'completed').length;

  const rentedMRR = rentedCount * 450;
  const trialMRR = trialCount * 150;
  const trackerRetainerMRR = trackerCount * 49;
  const totalMRR = rentedMRR + trialMRR + trackerRetainerMRR;

  const callLeadRevenue = completedCallsCount * 5.00;
  const cumulativeRent = rentedCount * 900;
  const cumulativeTrials = trialCount * 300;
  const lifetimeEarnings = callLeadRevenue + cumulativeRent + cumulativeTrials;

  const tickIntervalMs = serverStatus?.intervalMs ?? 12_000;
  const tickIntervalLabel =
    tickIntervalMs >= 60_000
      ? `${Math.round(tickIntervalMs / 60_000)}m`
      : `${Math.round(tickIntervalMs / 1000)}s`;

  return (
    <div className="space-y-8 animate-fade-in" id="autopilot-dashboard">
      {/* Header Automation Toggle Row */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-lg ${
            displayAutopilotOn
              ? 'bg-blue-600 text-white animate-pulse shadow-blue-500/25'
              : 'bg-white/5 text-slate-400'
          }`}>
            <Cpu className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              Autonomous Rank & Rent Autopilot System
              <span className={`h-2.5 w-2.5 rounded-full ${displayAutopilotOn ? 'bg-emerald-500 animate-ping' : 'bg-slate-600'}`} />
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Activate hands-free operations. The decision loop runs on the server — closing this tab does not stop the pipeline.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <button
            onClick={async () => {
              setIsRunningCycle(true);
              const result = await runServerCycle();
              setIsRunningCycle(false);
              if (result) onRefreshData();
            }}
            disabled={isRunningCycle}
            className="flex-1 md:flex-none px-4 py-3 bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            title="Trigger one decision cycle on the server (next action)"
          >
            <Activity className={`w-4 h-4 ${isRunningCycle ? 'animate-spin text-blue-400' : 'text-slate-400'}`} />
            Run Manual Cycle
          </button>

          <button
            onClick={() => setServerSetting({ isAutopilotOn: !displayAutopilotOn })}
            disabled={isToggling}
            className={`flex-1 md:flex-none px-5 py-3 rounded-xl text-xs font-black transition flex items-center justify-center gap-2 shadow-lg cursor-pointer disabled:opacity-50 ${
              displayAutopilotOn
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/20'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/20'
            }`}
          >
            {displayAutopilotOn ? (
              <>
                <Square className="w-4 h-4 text-white fill-white" />
                Stop AI Autopilot
              </>
            ) : (
              <>
                <Play className="w-4 h-4 text-white fill-white animate-pulse" />
                Start AI Autopilot
              </>
            )}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] font-mono text-slate-400">
          {serverStatus ? (
            <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-1 rounded-md">
              <Server className="w-3 h-3" />
              Server-side loop ACTIVE
              {serverStatus.backend && serverStatus.backend !== 'json' && (
                <span className="opacity-60">· {serverStatus.backend.split(':')[0]}</span>
              )}
              {serverStatus.intervalMs && (
                <span className="opacity-60">· {tickIntervalLabel} tick</span>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 bg-white/5 border border-white/10 px-2 py-1 rounded-md text-slate-500">
              <ServerOff className="w-3 h-3" />
              Connecting to server...
            </span>
          )}
          {lastServerSummary && (
            <span className="opacity-70 truncate max-w-[60ch]">
              Last cycle: {lastServerSummary}
            </span>
          )}
        </div>
      </div>

      {/* Passive Income Metrics Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gradient-to-br from-blue-600/10 to-transparent border border-blue-500/20 rounded-2xl p-6 shadow-xl relative overflow-hidden">
          <div className="absolute right-3 top-3 opacity-10">
            <TrendingUp className="w-24 h-24 text-blue-400" />
          </div>
          <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider block font-mono">ESTIMATED PASSIVE YIELD</span>
          <div className="text-3xl font-black text-white mt-1.5 flex items-baseline gap-1">
            ${totalMRR.toLocaleString()}
            <span className="text-xs font-bold text-slate-400 font-sans">/ month (MRR)</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Dynamic subscription income from locked local business tenancies and retainers.
          </p>
          <div className="border-t border-white/5 pt-3 mt-4 grid grid-cols-2 gap-1 text-[10px] font-mono font-medium text-slate-500">
            <div>Lease Contracts: <span className="text-white font-bold">${rentedMRR}</span></div>
            <div>Trials Yield: <span className="text-white font-bold">${trialMRR}</span></div>
          </div>
        </div>

        <div className="bg-gradient-to-br from-emerald-600/10 to-transparent border border-emerald-500/20 rounded-2xl p-6 shadow-xl relative overflow-hidden">
          <div className="absolute right-3 top-3 opacity-10">
            <DollarSign className="w-24 h-24 text-emerald-400" />
          </div>
          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider block font-mono">CUMULATIVE EARNINGS</span>
          <div className="text-3xl font-black text-white mt-1.5 flex items-baseline gap-1">
            ${lifetimeEarnings.toFixed(2)}
            <span className="text-[10px] font-bold text-emerald-400 font-mono bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">CASH LOCK</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            All-time passive revenue secured through call routing, setup fees, and retainer models.
          </p>
          <div className="border-t border-white/5 pt-3 mt-4 grid grid-cols-2 gap-1 text-[10px] font-mono font-medium text-slate-500">
            <div>Call Lead Fees: <span className="text-white font-bold">${callLeadRevenue.toFixed(2)}</span></div>
            <div>Setup Invoices: <span className="text-white font-bold">${cumulativeRent + cumulativeTrials}</span></div>
          </div>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl relative overflow-hidden">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block font-mono">DIGITAL LANDLORD PORTFOLIO</span>
          <div className="text-3xl font-black text-white mt-1.5 flex items-baseline gap-2">
            {rentedCount} / {targets.length}
            <span className="text-xs font-bold text-slate-400">SEO assets rented</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Ranked landing pages currently leased to local businesses on trial or full subscription.
          </p>
          <div className="w-full bg-white/10 rounded-full h-1.5 mt-4">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${targets.length > 0 ? (rentedCount / targets.length) * 100 : 0}%` }}
            />
          </div>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl relative overflow-hidden">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block font-mono">PAY-PER-LEAD DISPATCHER</span>
          <div className="text-3xl font-black text-white mt-1.5 flex items-baseline gap-1">
            {completedCallsCount}
            <span className="text-xs font-bold text-slate-400">forwarded leads</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Consumer phone inquiries bridged to local clients with real-time whisper verification.
          </p>
          <div className="border-t border-white/5 pt-3 mt-4 flex justify-between text-[10px] font-mono font-medium text-slate-500">
            <span>Pay Per Lead: $5.00/call</span>
            <span className="text-emerald-400 font-bold">Bridge Active</span>
          </div>
        </div>
      </div>

      {/* Autopilot Operation Process Map */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
        <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-5">AI Agent Operational Pipeline Architecture</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
          {[
            { step: '01', title: 'Niche Scan', desc: 'Identify high CPC terms', icon: Database, color: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
            { step: '02', title: 'Map Scrape', desc: 'Find weak local sites', icon: Users, color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
            { step: '03', title: 'AI Cold Pitch', desc: 'Generate customized copy', icon: Mail, color: 'text-pink-400 bg-pink-500/10 border-pink-500/20' },
            { step: '04', title: 'Line Provision', desc: 'Register tracking lines', icon: Phone, color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
            { step: '05', title: 'SEO Landers', desc: 'Deploy premium sites', icon: Globe, color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
            { step: '06', title: 'Calls Bridge', desc: 'Forward consumer leads', icon: Activity, color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' },
            { step: '07', title: 'Lease Lock', desc: 'MRR Passive Rent collected', icon: DollarSign, color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' },
          ].map((pipeline, idx) => {
            const PipeIcon = pipeline.icon;
            return (
              <div key={pipeline.step} className="border border-white/5 bg-[#111]/30 p-4 rounded-xl flex flex-col justify-between items-center text-center relative">
                {idx < 6 && (
                  <div className="hidden lg:block absolute top-1/2 -right-3 transform -translate-y-1/2 z-10 text-slate-700 font-extrabold text-base">➔</div>
                )}
                <span className="text-[10px] font-mono font-black text-slate-500 self-start">{pipeline.step}</span>
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center my-2 border ${pipeline.color}`}>
                  <PipeIcon className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white truncate">{pipeline.title}</h4>
                  <p className="text-[9px] text-slate-500 mt-1 leading-normal">{pipeline.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Autopilot Console and Live Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Terminal Live logs */}
        <div className="lg:col-span-2 bg-[#050505] rounded-2xl border border-white/10 overflow-hidden shadow-2xl flex flex-col h-[480px]">
          <div className="bg-[#0c0c0c] border-b border-white/5 px-5 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
              </div>
              <span className="text-[10px] font-bold text-slate-400 font-mono tracking-wider uppercase ml-1.5">AI OPERATIONS LIVE RETINAL TRACE LOGS</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="bg-blue-500/10 text-blue-400 text-[9px] border border-blue-500/25 px-2 py-0.5 rounded font-mono">
                INTERVAL: {tickIntervalLabel.toUpperCase()}
              </span>
              <button
                onClick={() => setLogs([])}
                className="text-[9px] font-mono text-slate-500 hover:text-slate-300 transition uppercase cursor-pointer"
              >
                Clear Console
              </button>
            </div>
          </div>

          <div className="flex-1 p-5 font-mono text-xs overflow-y-auto space-y-3 scrollbar-thin scrollbar-thumb-white/10">
            {logs.length === 0 ? (
              <div className="text-slate-600 italic text-center py-20">
                Console logs are empty. Server autopilot background loop or manual cycle will print logs here.
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex items-start gap-3 leading-relaxed">
                  <span className="text-slate-600 shrink-0 select-none text-[10px] font-semibold mt-0.5">[{log.timestamp}]</span>
                  <span className={`flex-1 font-mono ${
                    log.type === 'success' ? 'text-emerald-400' :
                    log.type === 'warn' ? 'text-amber-500 font-bold' :
                    log.type === 'income' ? 'text-yellow-300 font-bold' :
                    log.type === 'process' ? 'text-sky-400 font-semibold italic' :
                    'text-slate-300'
                  }`}>
                    {log.message}
                  </span>
                </div>
              ))
            )}
            <div ref={consoleEndRef} />
          </div>

          <div className="bg-[#080808] border-t border-white/5 p-3 flex items-center gap-2 text-[10px] font-mono text-slate-400 px-5">
            <span className="font-extrabold text-blue-400 uppercase tracking-wider shrink-0">STATUS:</span>
            <div className="flex items-center gap-2 animate-pulse truncate">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
              <span className="truncate italic text-slate-300">
                {lastServerSummary
                  || (isServerCycleRunning ? '⚡ Cycle in progress…' : 'Waiting for next server cycle...')
                }</span>
            </div>
          </div>
        </div>

        {/* Autopilot Insights & Instructions */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl space-y-6">
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider">Passive CRM Analytics</span>
            <h3 className="font-extrabold text-white text-base mt-1">Digital Asset Valuations</h3>
            <p className="text-xs text-slate-400 mt-1 leading-normal">
              Autonomous Rank & Rent turns raw local search volume into monthly subscription real estate.
            </p>
          </div>

          <div className="border-t border-b border-white/10 py-4 space-y-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider block">AUTOPILOT CONTROLS</span>
            <div className="bg-blue-600/10 border border-blue-500/25 p-4 rounded-xl flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                  Instant Auto-Contact Pipeline
                  <span className="bg-blue-500/25 text-blue-400 text-[8px] font-mono px-1.5 py-0.5 rounded border border-blue-500/30">
                    CRM AUTO-PITCH
                  </span>
                </h4>
                <p className="text-[10px] text-slate-400 leading-normal">
                  Automatically generate AI pitches for newly scraped prospects, transitioning their status to 'Pitched' immediately.
                </p>
              </div>
              <button
                onClick={() => setServerSetting({ isAutoPitchOn: !isAutoPitchOn })}
                className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 focus:outline-none shrink-0 cursor-pointer ${
                  isAutoPitchOn ? 'bg-blue-600' : 'bg-slate-700'
                }`}
                title="Toggle autonomous pitch generation (server-side)"
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${
                    isAutoPitchOn ? 'translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl flex justify-between items-center">
              <div>
                <h4 className="text-xs font-bold text-white">Cold Prospects (Scraped)</h4>
                <p className="text-[10px] text-slate-500 mt-0.5">Discovered via Google Map API</p>
              </div>
              <span className="font-mono font-bold text-slate-300 text-sm">{prospects.filter(p => p.pitchStatus === 'Scraped').length} leads</span>
            </div>

            <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl flex justify-between items-center">
              <div>
                <h4 className="text-xs font-bold text-white">Value Proposition Pitches</h4>
                <p className="text-[10px] text-slate-500 mt-0.5">AI personalized email drafts</p>
              </div>
              <span className="font-mono font-bold text-indigo-400 text-sm">{pitchCount} copy</span>
            </div>

            <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl flex justify-between items-center">
              <div>
                <h4 className="text-xs font-bold text-white">Active Trial Leads</h4>
                <p className="text-[10px] text-slate-500 mt-0.5">Lease setup & proving value</p>
              </div>
              <span className="font-mono font-bold text-blue-400 text-sm">{trialCount} sites</span>
            </div>

            <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl flex justify-between items-center">
              <div>
                <h4 className="text-xs font-bold text-white">Fully Rented Assets</h4>
                <p className="text-[10px] text-slate-500 mt-0.5">Active recurring clients locked</p>
              </div>
              <span className="font-mono font-bold text-emerald-400 text-sm">{rentedCount} contracts</span>
            </div>
          </div>

          <div className="border-t border-white/10 pt-5 space-y-2 text-xs text-slate-400 leading-normal bg-blue-600/[0.01] rounded-xl p-4 border border-blue-500/5">
            <div className="flex gap-2 items-start">
              <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span><strong>24/7 server execution:</strong> The decision loop runs on the server, not in this tab. You can close the browser and the pipeline keeps working.</span>
            </div>
            <div className="flex gap-2 items-start mt-2">
              <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span><strong>Pay-per-lead bridge:</strong> Every customer call automatically generates <strong>$5.00 passive cash flow</strong> to the portfolio balance.</span>
            </div>
          </div>
        </div>
      </div>

      {/* Operator Notifications Feed */}
      <div className="bg-[#0a0a0a] rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
        <div className="bg-[#0c0c0c] border-b border-white/5 px-5 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-yellow-400" />
            <span className="text-xs font-bold text-slate-300 font-mono tracking-wider uppercase">
              Operator Notifications Feed
            </span>
            <span className="bg-yellow-500/10 text-yellow-400 text-[9px] border border-yellow-500/25 px-2 py-0.5 rounded font-mono">
              {operatorEmail}
            </span>
          </div>
          <button
            onClick={refreshNotifications}
            className="text-[9px] font-mono text-slate-500 hover:text-slate-300 transition uppercase cursor-pointer"
            title="Refresh"
          >
            Refresh
          </button>
        </div>
        <div className="p-5 max-h-[420px] overflow-y-auto space-y-3 scrollbar-thin scrollbar-thumb-white/10">
          {notifications.length === 0 ? (
            <div className="text-slate-600 italic text-center py-10 text-xs font-mono">
              No notifications yet. System events will appear here.
            </div>
          ) : (
            notifications.slice(0, 12).map((n) => {
              const outcome: string | undefined =
                typeof n.metadata?.outcome === 'string' ? n.metadata.outcome : undefined;
              type Tone = 'system' | 'neutral';
              let tone: Tone = 'neutral';
              if (n.type === 'system') tone = 'system';

              const TONE_STYLE: Record<Tone, { border: string; bg: string; tint: string; chip: string }> = {
                system:     { border: 'border-slate-500/30',    bg: 'bg-slate-500/5',     tint: 'text-slate-300',    chip: outcome === 'uncollectible' ? '☠️ UNCOLLECTIBLE' : outcome === 'void' ? '🗑️ VOID' : '🛠️ SYSTEM' },
                neutral:    { border: 'border-blue-500/30',     bg: 'bg-blue-500/5',      tint: 'text-blue-300',     chip: 'ℹ️ INFO' },
              };
              const toneStyle = TONE_STYLE[tone];

              const TONE_ICON: Record<Tone, React.ReactNode> = {
                system:     <AlertCircle className="w-4 h-4 text-slate-300" />,
                neutral:    <FileText className="w-4 h-4 text-blue-400" />,
              };

              return (
                <div
                  key={n.id}
                  className={`p-4 rounded-xl border font-mono text-xs whitespace-pre-wrap leading-relaxed ${toneStyle.border} ${toneStyle.bg}`}
                >
                  <div className="flex justify-between items-start gap-3 mb-1.5">
                    <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${toneStyle.border} ${toneStyle.tint} shrink-0`}>
                      {toneStyle.chip}
                    </span>
                    <span className="font-bold text-white text-sm flex-1 flex items-start gap-2 leading-snug">
                      {TONE_ICON[tone]}
                      <span>{n.title}</span>
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono shrink-0 text-right">
                      {new Date(n.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{n.message}</pre>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
