import React, { useState } from 'react';
import { TrackingNumber, CallLog } from '../types';
import { PhoneCall, PlusCircle, Phone, User, Clock, CheckCircle2, AlertCircle, Trash2, Volume2 } from 'lucide-react';

interface CallsViewProps {
  numbers: TrackingNumber[];
  calls: CallLog[];
  onAddNumber: (num: Omit<TrackingNumber, 'id' | 'createdAt' | 'isActive'>) => Promise<any>;
  onDeleteNumber: (id: string) => Promise<void>;
  loading: boolean;
}

export default function CallsView({
  numbers,
  calls,
  onAddNumber,
  onDeleteNumber,
  loading
}: CallsViewProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const [whisperMessage, setWhisperMessage] = useState('Call from Robert\'s leads.');
  const [recordCalls, setRecordCalls] = useState(true);

  const [activeRecordingUrl, setActiveRecordingUrl] = useState<string | null>(null);

  const handleCreateNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber || !forwardTo) return;
    await onAddNumber({
      phoneNumber,
      friendlyName: friendlyName || `${phoneNumber} Forwarder`,
      forwardTo,
      whisperMessage,
      recordCalls
    });
    setPhoneNumber('');
    setFriendlyName('');
    setForwardTo('');
    setWhisperMessage("Call from Robert's leads.");
  };

  return (
    <div className="grid lg:grid-cols-3 gap-8">
      {/* Tracking number manager */}
      <div className="lg:col-span-1 space-y-6">
        {/* Create Line */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
            <PhoneCall className="w-5 h-5 text-blue-400" />
            Provision Call Trackers
          </h2>
          <p className="text-xs text-slate-400 mb-4">
            Provision virtual phone lines. When customers call, we track the metrics, trigger whisper prompts, and forward the connection to the client.
          </p>

          <form onSubmit={handleCreateNumber} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Virtual Tracking Line Number</label>
              <input
                type="text"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="e.g. +1 (469) 203-5678"
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white placeholder-slate-650"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Forward to Real Owner Number</label>
              <input
                type="text"
                value={forwardTo}
                onChange={(e) => setForwardTo(e.target.value)}
                placeholder="e.g. +1 (214) 784-0199"
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white placeholder-slate-650"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Friendly Campaign Name</label>
              <input
                type="text"
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder="e.g. Dallas Roofing Lead campaign"
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white placeholder-slate-650"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Whisper Announcement Message</label>
              <input
                type="text"
                value={whisperMessage}
                onChange={(e) => setWhisperMessage(e.target.value)}
                placeholder="e.g. Call from Robert's Dallas Roofing leads."
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white placeholder-slate-650"
              />
              <span className="text-[10px] text-slate-500 font-medium block mt-1">
                Announced to the business owner right before they answer, proving instant rank & rent value!
              </span>
            </div>

            <div className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                id="recordCalls"
                checked={recordCalls}
                onChange={(e) => setRecordCalls(e.target.checked)}
                className="w-4.5 h-4.5 bg-[#111] border-white/10 rounded focus:ring-blue-500/20 text-blue-600"
              />
              <label htmlFor="recordCalls" className="text-xs font-bold text-slate-300 select-none cursor-pointer">
                Record calls for lead audit
              </label>
            </div>

            <button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl transition shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 cursor-pointer"
            >
              <PlusCircle className="w-4.5 h-4.5 text-white" />
              Provision Tracking Line
            </button>
          </form>
        </div>

      </div>

      {/* Active Forwarding Numbers List & Call History Logs */}
      <div className="lg:col-span-2 space-y-6">
        {/* Active tracking lines */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <h2 className="text-base font-bold text-white mb-4">Provisioned Virtual Tracking Campaigns</h2>
          {numbers.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-white/10 rounded-2xl bg-white/[0.01]">
              <p className="text-xs text-slate-400">No forwarding tracking lines created yet.</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {numbers.map((n) => (
                <div key={n.id} className="border border-white/5 p-5 rounded-2xl bg-[#111]/40 flex justify-between items-start gap-4 hover:border-white/10 transition duration-150">
                  <div className="min-w-0">
                    <span className="text-[10px] font-bold text-blue-400 uppercase tracking-widest block font-mono">ACTIVE CAMPAIGN</span>
                    <h3 className="font-extrabold text-white text-sm truncate mt-1">{n.friendlyName}</h3>
                    
                    <div className="space-y-1 mt-3">
                      <div className="flex items-center gap-1.5 text-xs text-slate-300">
                        <Phone className="w-3.5 h-3.5 text-slate-500" />
                        <span className="font-bold font-mono text-slate-300">{n.phoneNumber}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-300">
                        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">FORWARD TO</span>
                        <span className="font-bold font-mono text-slate-300">{n.forwardTo}</span>
                      </div>
                    </div>

                    <div className="bg-white/[0.02] p-2.5 rounded-xl border border-white/5 text-[10px] text-slate-400 font-medium italic mt-3 flex items-start gap-1">
                      <Volume2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>"{n.whisperMessage}"</span>
                    </div>
                  </div>

                  <button
                    onClick={() => onDeleteNumber(n.id)}
                    className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                    title="Deprovision campaign"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Real-time incoming call log */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-base font-bold text-white">Incoming Call Forwarder Audits</h2>
              <p className="text-xs text-slate-400 mt-0.5">Real-time trace logs of redirected consumer calls showing whisper outcomes and auditable recordings.</p>
            </div>
            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-full text-[10px] font-bold font-mono uppercase tracking-wider">
              ● Connected
            </span>
          </div>

          {calls.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-white/[0.01]">
              <PhoneCall className="w-10 h-10 text-slate-600 mx-auto mb-3" />
              <p className="text-xs text-slate-400">No consumer calls processed yet on virtual numbers.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {calls.map((call) => {
                const isMissed = call.status === 'no-answer';
                return (
                  <div key={call.id} className="border border-white/5 p-4 rounded-xl bg-white/[0.01] hover:bg-white/[0.02] hover:border-white/10 flex flex-col md:flex-row justify-between md:items-center gap-4 transition shadow-lg">
                    {/* Caller Info */}
                    <div className="flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isMissed ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                        <User className="w-4.5 h-4.5" />
                      </div>

                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-sm">{call.callerNumber}</span>
                          <span className="text-[10px] font-medium text-slate-400 bg-white/5 px-2 py-0.5 rounded-full border border-white/5">{call.callerLocation}</span>
                        </div>
                        
                        <div className="text-[10px] text-slate-400 font-medium mt-1">
                          Called: <span className="font-bold text-slate-300">{call.trackingNumber}</span> ➔ Forwarded: <span className="font-bold text-slate-300">{call.forwardTo}</span>
                        </div>
                      </div>
                    </div>

                    {/* Metadata & Audio Player */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      {/* Duration */}
                      <div className="text-right">
                        <div className="flex items-center justify-end gap-1 font-mono text-xs font-bold text-slate-300">
                          <Clock className="w-3.5 h-3.5 text-slate-500" />
                          {call.durationSeconds > 0 ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s` : '0s'}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {new Date(call.dateCreated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </div>
                      </div>

                      {/* Status Check */}
                      <div>
                        {isMissed ? (
                          <span className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-bold px-2.5 py-1 rounded-lg flex items-center gap-1.5 uppercase tracking-wide">
                            <AlertCircle className="w-3.5 h-3.5" /> Missed Call
                          </span>
                        ) : (
                          <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold px-2.5 py-1 rounded-lg flex items-center gap-1.5 uppercase tracking-wide">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Answered
                          </span>
                        )}
                      </div>

                      {/* Live Call Record playback */}
                      {call.recordingUrl && (
                        <div className="flex items-center gap-2">
                          {activeRecordingUrl === call.id ? (
                            <div className="flex items-center gap-2">
                              <audio
                                src={call.recordingUrl}
                                controls
                                autoPlay
                                className="h-8 max-w-[160px] md:max-w-[200px]"
                                onEnded={() => setActiveRecordingUrl(null)}
                              />
                              <button
                                onClick={() => setActiveRecordingUrl(null)}
                                className="text-xs font-bold text-rose-400 hover:underline cursor-pointer"
                              >
                                Stop
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setActiveRecordingUrl(call.id)}
                              className="bg-white/5 hover:bg-white/10 text-slate-200 font-bold px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 transition border border-white/10 cursor-pointer"
                            >
                              <Volume2 className="w-3.5 h-3.5 text-blue-400" />
                              Audit Audio
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
