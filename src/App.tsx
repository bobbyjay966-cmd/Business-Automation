import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import TargetsView from './components/TargetsView';
import ProspectsView from './components/ProspectsView';
import WebBuilderView from './components/WebBuilderView';
import CallsView from './components/CallsView';
import AutopilotView from './components/AutopilotView';

import { NicheCityTarget, ScrapedLead, TrackingNumber, CallLog, GeneratedSite } from './types';
import { HelpCircle, Terminal, Info, Database, ShieldAlert, ExternalLink } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('targets');
  
  // Data State
  const [targets, setTargets] = useState<NicheCityTarget[]>([]);
  const [prospects, setProspects] = useState<ScrapedLead[]>([]);
  const [numbers, setNumbers] = useState<TrackingNumber[]>([]);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [sites, setSites] = useState<GeneratedSite[]>([]);

  // Loading States
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [loadingScrape, setLoadingScrape] = useState(false);
  const [loadingPitch, setLoadingPitch] = useState(false);
  const [loadingSite, setLoadingSite] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  // Fetch initial database contents
  const fetchAllData = async () => {
    try {
      const [targetsRes, prospectsRes, numbersRes, callsRes, sitesRes] = await Promise.all([
        fetch('/api/targets'),
        fetch('/api/prospects'),
        fetch('/api/numbers'),
        fetch('/api/calls'),
        fetch('/api/sites')
      ]);

      if (targetsRes.ok) setTargets(await targetsRes.json());
      if (prospectsRes.ok) setProspects(await prospectsRes.json());
      if (numbersRes.ok) setNumbers(await numbersRes.json());
      if (callsRes.ok) setCalls(await callsRes.json());
      if (sitesRes.ok) setSites(await sitesRes.json());
    } catch (err) {
      console.error("Error fetching database metrics from backend API:", err);
    }
  };

  useEffect(() => {
    fetchAllData();
  }, []);

  // Stripe Checkout Redirect Callback Verification
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const status = urlParams.get('status');
    const prospectId = urlParams.get('prospectId');
    const siteId = urlParams.get('siteId');

    if (status === 'success') {
      alert(`🎉 Subscription rent processed successfully! Check Stripe invoicing dashboard for status.`);
      window.history.replaceState({}, document.title, window.location.pathname);
      fetchAllData();
    } else if (status === 'cancel') {
      alert(`❌ Subscription rent checkout was cancelled.`);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // API wrappers
  const handleAddTarget = async (niche: string, city: string) => {
    setLoadingTarget(true);
    setApiError(null);
    try {
      const res = await fetch('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche, city })
      });
      if (res.ok) {
        const newTarget = await res.json();
        setTargets(prev => [newTarget, ...prev]);
        setApiError(null);
      } else {
        const err = await res.json();
        setApiError(err.error || "Failed to analyze target market.");
      }
    } catch (err: any) {
      console.error(err);
      setApiError(err.message || "Failed to analyze target market.");
    } finally {
      setLoadingTarget(false);
    }
  };

  const handleDeleteTarget = async (id: string) => {
    if (!confirm("Are you sure you want to delete this target market? All scraped leads and built sites under it will be deleted.")) return;
    try {
      const res = await fetch(`/api/targets/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setTargets(prev => prev.filter(t => t.id !== id));
        setProspects(prev => prev.filter(p => p.targetId !== id));
        setSites(prev => prev.filter(s => s.targetId !== id));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleScrapeLeads = async (targetId: string, niche: string, city: string) => {
    setLoadingScrape(true);
    setApiError(null);
    try {
      const res = await fetch('/api/prospects/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, niche, city })
      });
      if (res.ok) {
        const newProspects = await res.json();
        // Update local prospects (prepend/merge)
        setProspects(prev => {
          const filtered = prev.filter(p => p.targetId !== targetId);
          return [...newProspects, ...filtered];
        });
        // Update target status locally
        setTargets(prev => prev.map(t => t.id === targetId ? { ...t, status: 'active_leads' } : t));
        setApiError(null);
      } else {
        const err = await res.json();
        setApiError(err.error || "Failed to scrape business leads.");
      }
    } catch (err: any) {
      console.error(err);
      setApiError(err.message || "Failed to scrape business leads.");
    } finally {
      setLoadingScrape(false);
    }
  };

  const handleGeneratePitch = async (prospectId: string) => {
    setLoadingPitch(true);
    setApiError(null);
    try {
      const res = await fetch(`/api/prospects/${prospectId}/pitch`, { method: 'POST' });
      if (res.ok) {
        const updatedLead = await res.json();
        setProspects(prev => prev.map(p => p.id === prospectId ? updatedLead : p));
        setApiError(null);
      } else {
        const err = await res.json();
        setApiError(err.error || "Failed to generate custom AI pitch.");
      }
    } catch (err: any) {
      console.error(err);
      setApiError(err.message || "Failed to generate custom AI pitch.");
    } finally {
      setLoadingPitch(false);
    }
  };

  const handleUpdateStatus = async (prospectId: string, status: ScrapedLead['pitchStatus']) => {
    try {
      const res = await fetch(`/api/prospects/${prospectId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        const updated = await res.json();
        setProspects(prev => prev.map(p => p.id === prospectId ? updated : p));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveNotes = async (prospectId: string, notes: string) => {
    try {
      const res = await fetch(`/api/prospects/${prospectId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
      });
      if (res.ok) {
        const updated = await res.json();
        setProspects(prev => prev.map(p => p.id === prospectId ? updated : p));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddNumber = async (num: Omit<TrackingNumber, 'id' | 'createdAt' | 'isActive'>): Promise<TrackingNumber | undefined> => {
    try {
      const res = await fetch('/api/numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(num)
      });
      if (res.ok) {
        const newNum = await res.json();
        setNumbers(prev => [newNum, ...prev]);
        return newNum;
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteNumber = async (id: string) => {
    if (!confirm("Are you sure you want to deprovision this virtual phone line?")) return;
    try {
      const res = await fetch(`/api/numbers/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setNumbers(prev => prev.filter(n => n.id !== id));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleGenerateSite = async (targetId: string, trackingNumberId: string): Promise<any> => {
    setLoadingSite(true);
    setApiError(null);
    try {
      const res = await fetch('/api/sites/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, trackingNumberId })
      });
      if (res.ok) {
        const newSite = await res.json();
        setSites(prev => [newSite, ...prev]);
        setTargets(prev => prev.map(t => t.id === targetId ? { ...t, status: 'site_created' } : t));
        setApiError(null);
        return newSite;
      } else {
        const err = await res.json();
        setApiError(err.error || "Failed to build local landing page.");
      }
    } catch (err: any) {
      console.error(err);
      setApiError(err.message || "Failed to build local landing page.");
    } finally {
      setLoadingSite(false);
    }
  };

  const handleDeleteSite = async (id: string) => {
    if (!confirm("Are you sure you want to delete this landing page?")) return;
    try {
      const res = await fetch(`/api/sites/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSites(prev => prev.filter(s => s.id !== id));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSendTrialEmail = async (prospectId: string, siteUrl: string, niche: string, city: string): Promise<any> => {
    try {
      const res = await fetch('/api/outreach/trial-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId, siteUrl, niche, city })
      });
      if (res.ok) {
        const data = await res.json();
        // Update prospect in local state
        setProspects(prev => prev.map(p => p.id === prospectId ? { ...p, trialEmailSent: true, trialEmailContent: data.emailContent, pitchStatus: 'Trial' as const } : p));
        return data;
      }
    } catch (err) {
      console.error('Failed to send trial email:', err);
    }
  };

  const handleAutoSubscribe = async (prospectId: string, targetId?: string, siteId?: string): Promise<any> => {
    try {
      const res = await fetch('/api/billing/auto-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId, targetId, siteId })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        // Merge the latest prospect record back into local state
        if (data.prospect) {
          setProspects(prev => prev.map(p => p.id === prospectId ? { ...p, ...data.prospect } : p));
        }
        if (data.targetId) {
          setTargets(prev => prev.map(t => t.id === data.targetId ? { ...t, status: 'rented' as const } : t));
        }
        return data;
      }
      // 412 -> prerequisites missing (no site / no number) - return silently
      if (res.status === 412) {
        return { success: false, prerequisites: data, status: res.status };
      }
      return { success: false, error: data?.error || 'Unknown error', status: res.status };
    } catch (err: any) {
      console.error('Auto-subscribe error:', err);
      return { success: false, error: err?.message || String(err) };
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-slate-200 flex flex-col font-sans">
      <Header activeTab={activeTab} setActiveTab={setActiveTab} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* API Error Notification */}
        {apiError && (
          <div className="mb-8 bg-rose-500/10 border border-rose-500/30 rounded-2xl p-5 flex items-start justify-between gap-4 shadow-lg shadow-rose-950/25 animate-fadeIn">
            <div className="flex items-start gap-4 min-w-0">
              <div className="bg-rose-500/10 p-2.5 rounded-xl text-rose-400 shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="font-bold text-white text-sm">Execution Interrupted</h3>
                <p className="text-xs text-slate-300 leading-relaxed mt-0.5">
                  {apiError}
                </p>
                {/\b(econnrefused|enotfound|fetch failed|failed to fetch|connection refused|model.{0,30}(not found|does not exist|unknown model)|no such model|timed?\s?out|abort|etimedout|llm.{0,10}not\s?set|http\s?(401|403|404|422|429|500|502|503|504))\b/i.test(apiError) && (
                  <div className="text-[11px] text-amber-400/95 leading-relaxed mt-2 bg-amber-500/5 px-3.5 py-2.5 rounded-xl border border-amber-500/10 space-y-1.5">
                    <div>
                      💡 <strong>NVIDIA AI API required:</strong> this app uses NVIDIA's cloud-hosted DeepSeek V4 Pro model. Configure your key in the <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">.env</code> file.
                    </div>
                    <ol className="list-decimal pl-5 space-y-1 marker:text-amber-500/70">
                      <li>
                        <strong>Get a free NVIDIA API key</strong> (includes free credits):{' '}
                        <a href="https://build.nvidia.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-white font-bold inline-flex items-center gap-0.5">build.nvidia.com <ExternalLink className="w-2.5 h-2.5" /></a>
                      </li>
                      <li>
                        Set <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">NVIDIA_API_KEY=nvapi-...</code> in your <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">.env</code> file.
                      </li>
                      <li>
                        (Optional) The default model is <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">deepseek-ai/deepseek-v4-pro</code>. Override with <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">NVIDIA_MODEL</code> and <code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">NVIDIA_BASE_URL</code>.
                      </li>
                    </ol>
                    <div className="italic text-amber-300/90">
                      The DeepSeek model supports native JSON mode (<code className="bg-amber-500/10 px-1 py-0.5 rounded text-amber-300 font-mono">response_format: json_object</code>) for fast, reliable structured output.
                    </div>
                  </div>
                )}
              </div>
            </div>
            <button 
              onClick={() => setApiError(null)}
              className="text-slate-400 hover:text-white transition-colors cursor-pointer text-xs font-bold font-mono border border-white/10 hover:bg-white/5 rounded-lg px-2.5 py-1"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Informational banner */}
        <div className="mb-8 bg-blue-600/10 border border-blue-500/20 rounded-2xl p-5 flex items-start gap-4 shadow-lg shadow-blue-950/25">
          <div className="bg-blue-500/10 p-2.5 rounded-xl text-blue-400 shrink-0">
            <Info className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-white text-sm">Automated Rank & Rent Engine Active</h3>
            <p className="text-xs text-slate-300 leading-relaxed mt-0.5">
              This system implements the complete workflow from the guide: search-grounded market analysis, business listing discovery, local landing page compilation, and whisper-enabled phone forwarder tracking. All logs are securely recorded in the local file system.
            </p>
          </div>
        </div>

        {/* Tab contents */}
        <div className="transition-all duration-200">
          {activeTab === 'targets' && (
            <TargetsView
              targets={targets}
              onAddTarget={handleAddTarget}
              onDeleteTarget={handleDeleteTarget}
              loading={loadingTarget}
            />
          )}

          {activeTab === 'prospects' && (
            <ProspectsView
              targets={targets}
              prospects={prospects}
              onScrapeLeads={handleScrapeLeads}
              onGeneratePitch={handleGeneratePitch}
              onUpdateStatus={handleUpdateStatus}
              onSaveNotes={handleSaveNotes}
              scraping={loadingScrape}
              pitching={loadingPitch}
            />
          )}

          {activeTab === 'sites' && (
            <WebBuilderView
              targets={targets}
              numbers={numbers}
              sites={sites}
              prospects={prospects}
              onGenerateSite={handleGenerateSite}
              onDeleteSite={handleDeleteSite}
              generating={loadingSite}
            />
          )}

          {activeTab === 'calls' && (
            <CallsView
              numbers={numbers}
              calls={calls}
              onAddNumber={handleAddNumber}
              onDeleteNumber={handleDeleteNumber}
              loading={false}
            />
          )}

          {activeTab === 'autopilot' && (
            <AutopilotView
              targets={targets}
              prospects={prospects}
              numbers={numbers}
              calls={calls}
              sites={sites}
              onAddTarget={handleAddTarget}
              onScrapeLeads={handleScrapeLeads}
              onGeneratePitch={handleGeneratePitch}
              onUpdateStatus={handleUpdateStatus}
              onAddNumber={handleAddNumber}
              onGenerateSite={handleGenerateSite}
              onSendTrialEmail={handleSendTrialEmail}
              onAutoSubscribe={handleAutoSubscribe}
              onRefreshData={fetchAllData}
            />
          )}
        </div>
      </main>

      <footer className="bg-[#050505] border-t border-white/5 py-8 px-4 mt-16">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 text-center md:text-left">
          <div>
            <div className="flex items-center justify-center md:justify-start gap-2 text-white font-extrabold text-sm">
              <Database className="w-4.5 h-4.5 text-blue-500" />
              <span>Rank & Rent Operations Hub</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Fully compliant automated execution pipeline. No mock interfaces, actual SEO grounding engines operational.
            </p>
          </div>
          <div className="text-xs font-mono font-bold text-slate-500">
            SYS TIME: 2026-06-26 06:39:07
          </div>
        </div>
      </footer>
    </div>
  );
}
