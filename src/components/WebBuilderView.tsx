import React, { useState } from 'react';
import { NicheCityTarget, TrackingNumber, GeneratedSite, ScrapedLead } from '../types';
import { Globe, PlusCircle, Check, Copy, Download, Code, Eye, Laptop, ArrowUpRight, Loader2, Trash2, FileText, AlertCircle, Sparkles } from 'lucide-react';

interface WebBuilderViewProps {
  targets: NicheCityTarget[];
  numbers: TrackingNumber[];
  sites: GeneratedSite[];
  prospects: ScrapedLead[];
  onGenerateSite: (targetId: string, trackingNumberId: string) => Promise<any>;
  onDeleteSite: (id: string) => Promise<void>;
  generating: boolean;
}

export default function WebBuilderView({
  targets,
  numbers,
  sites,
  prospects,
  onGenerateSite,
  onDeleteSite,
  generating
}: WebBuilderViewProps) {
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [selectedNumberId, setSelectedNumberId] = useState('');
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<'live' | 'code'>('live');
  const [copied, setCopied] = useState(false);
  const [rentingProspectId, setRentingProspectId] = useState('');
  const [isRenting, setIsRenting] = useState(false);
  // Inline result for the auto-subscribe call (instead of a browser redirect
  // like the old Stripe Checkout button). Shows the subscription + invoice
  // summary, or a 412-prerequisites warning when the site is missing a
  // matching phone line, or a sendInvoiceFailed warning when Stripe didn't
  // email the invoice.
  const [rentResult, setRentResult] = useState<
    | null
    | {
        kind: 'success' | 'prereq' | 'failed';
        message: string;
        sub?: string;
        invoiceUrl?: string;
        subscriptionId?: string;
        invoiceId?: string;
        sendInvoiceFailed?: boolean;
        amount?: number;
        currency?: string;
        dueDate?: string;
      }
  >(null);

  const activeSite = sites.find(s => s.id === activeSiteId) || sites[0];
  // Allow Rented prospects too so the operator can re-issue / verify an
  // existing subscription. The endpoint is idempotent (won't double-charge).
  const activeTargetProspects = prospects.filter(
    (p) => p.targetId === activeSite?.targetId
  );

  // Manual "Send Rent Invoice" — uses /api/billing/auto-subscribe so the
  // money mechanics match the autopilot (send_invoice, 7-day due, monthly
  // recurring, Stripe emails the invoice). Idempotent server-side: re-running
  // it on a prospect that already has stripeSubscriptionId just confirms it.
  const handleRentSite = async () => {
    if (!rentingProspectId || !activeSite) return;
    setIsRenting(true);
    setRentResult(null);
    try {
      const res = await fetch('/api/billing/auto-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospectId: rentingProspectId,
          siteId: activeSite.id,
          targetId: activeSite.targetId,
        })
      });
      const data = await res.json().catch(() => ({} as any));
      if (res.ok && data.success) {
        setRentResult({
          kind: 'success',
          message: data.mode === 'live'
            ? `Stripe subscription ${data.subscriptionId} active. Invoice ${data.invoiceId} emailed to ${data.customerEmail}.`
            : `Mock subscription ${data.subscriptionId} active. Invoice ${data.invoiceId} would email to ${data.customerEmail} (set STRIPE_SECRET_KEY in .env to send real Stripe emails).`,
          invoiceUrl: data.invoiceUrl,
          subscriptionId: data.subscriptionId,
          invoiceId: data.invoiceId,
          sendInvoiceFailed: !!data.sendInvoiceFailed,
          amount: data.amountDue,
          currency: data.currency,
          dueDate: data.dueDate,
          sub: data.alreadyHadSubscription
            ? 'Existing subscription — no duplicate charge.'
            : (data.sendInvoiceFailed
              ? `⚠️ Stripe did NOT email the invoice. Open dashboard.stripe.com → Settings → Branding → Emails and enable 'Send invoices via Stripe email'. (${data.sendInvoiceError || 'unknown error'})`
              : undefined),
        });
      } else if (res.status === 412) {
        const needsSite = !!data?.needsSite;
        const needsLine = !!data?.needsLine;
        setRentResult({
          kind: 'prereq',
          message: 'Cannot send the rent invoice yet.',
          sub: [
            needsSite ? '• a site is not deployed for this target' : null,
            needsLine ? '• a tracking phone line is not provisioned for this target' : null,
          ].filter(Boolean).join(' ') || 'Build the site and provision a tracking line first.',
        });
      } else {
        setRentResult({
          kind: 'failed',
          message: data?.error || `Failed (HTTP ${res.status}).`,
        });
      }
    } catch (err: any) {
      setRentResult({
        kind: 'failed',
        message: err?.message || String(err) || 'Network error contacting /api/billing/auto-subscribe.',
      });
    } finally {
      setIsRenting(false);
    }
  };

  React.useEffect(() => {
    if (targets.length > 0 && !selectedTargetId) {
      setSelectedTargetId(targets[0].id);
    }
    if (numbers.length > 0 && !selectedNumberId) {
      setSelectedNumberId(numbers[0].id);
    }
  }, [targets, numbers, selectedTargetId, selectedNumberId]);

  React.useEffect(() => {
    if (sites.length > 0 && !activeSiteId) {
      setActiveSiteId(sites[0].id);
    }
  }, [sites, activeSiteId]);

  // Clear the inline rent-invoice result panel whenever the active site
  // changes, so the operator isn't shown a stale "subscription active" /
  // "failed" panel for an unrelated tenant.
  React.useEffect(() => {
    setRentResult(null);
  }, [activeSiteId]);

  // Removed redundant definition of activeSite

  const handleBuildSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTargetId || !selectedNumberId) return;
    await onGenerateSite(selectedTargetId, selectedNumberId);
  };

  const handleCopyCode = () => {
    if (!activeSite) return;
    navigator.clipboard.writeText(activeSite.htmlCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadFile = () => {
    if (!activeSite) return;
    const blob = new Blob([activeSite.htmlCode], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `index-${activeSite.city.toLowerCase().replace(/\s+/g, '')}-${activeSite.niche.toLowerCase().replace(/\s+/g, '')}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid lg:grid-cols-3 gap-8">
      {/* Site Creation Panel */}
      <div className="lg:col-span-1 space-y-6">
        {/* Create Landing Page Form */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-400" />
            AI Lead Page Builder
          </h2>
          <p className="text-xs text-slate-400 mb-4">
            Link a target market with an active tracking phone number. We'll deploy an optimized, high-converting, responsive local service SEO landing page code.
          </p>

          <form onSubmit={handleBuildSite} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Target SEO Market</label>
              <select
                value={selectedTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white"
                required
              >
                <option value="" disabled className="text-slate-600">Select Target Market</option>
                {targets.map(t => (
                  <option key={t.id} value={t.id} className="bg-[#111] text-white">{t.niche} - {t.city}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Phone Tracking Line</label>
              <select
                value={selectedNumberId}
                onChange={(e) => setSelectedNumberId(e.target.value)}
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white"
                required
              >
                <option value="" disabled className="text-slate-600">Select Call Forwarder</option>
                {numbers.map(n => (
                  <option key={n.id} value={n.id} className="bg-[#111] text-white">{n.friendlyName} ({n.phoneNumber})</option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={generating || targets.length === 0 || numbers.length === 0}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl transition-all duration-150 shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 disabled:opacity-75 cursor-pointer"
            >
              {generating ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-white" />
                  Generating Page HTML...
                </>
              ) : (
                <>
                  <PlusCircle className="w-4.5 h-4.5 text-white" />
                  Generate Local Landing Page
                </>
              )}
            </button>
          </form>
        </div>

        {/* Generated Sites List */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Active Landers ({sites.length})</h2>
          {sites.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
              <p className="text-xs text-slate-400">No landing pages built yet.</p>
              <p className="text-xs text-slate-500 mt-1">Bind parameters to construct one above.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {sites.map((site) => {
                const isSelected = activeSiteId === site.id;
                return (
                  <div
                    key={site.id}
                    onClick={() => setActiveSiteId(site.id)}
                    className={`p-4 rounded-xl border transition-all duration-150 cursor-pointer flex justify-between items-center gap-4 ${
                      isSelected
                        ? 'bg-white/5 border-blue-500 shadow-md'
                        : 'border-white/5 bg-white/[0.01] hover:border-white/10 hover:bg-white/[0.02]'
                    }`}
                  >
                    <div className="min-w-0">
                      <h3 className="font-bold text-white text-sm truncate">{site.niche} Lander</h3>
                      <p className="text-xs text-slate-400 truncate">{site.city}</p>
                      <span className="text-[10px] font-mono font-medium text-slate-500">{site.domainName}</span>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSite(site.id);
                        if (activeSiteId === site.id) {
                          setActiveSiteId(null);
                        }
                      }}
                      className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                      title="Delete site"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Stripe Rent Card — uses send_invoice (auto-subscribe) to match the
            autopilot flow exactly. The OLD Stripe Checkout button redirected
            to a card-required payment page; this card-collecting flow was
            misleading operators, so the button now issues the same invoice
            flow the AI Autopilot runs by itself and shows the result inline. */}
        {activeSite && activeTargetProspects.length > 0 && (
          <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl relative overflow-hidden">
            <div className="absolute right-0 top-0 translate-x-4 -translate-y-4 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none"></div>

            <h2 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
              <span className="text-emerald-400">💵</span>
              Lease Asset via Stripe
              <span className="bg-emerald-500/10 text-emerald-400 text-[8px] font-mono px-1.5 py-0.5 rounded border border-emerald-500/20 font-bold">
                SEND_INVOICE
              </span>
            </h2>
            <p className="text-[11px] text-slate-400 mb-4">
              Rent out <span className="font-mono text-slate-300">{activeSite.domainName}</span> to a local business client. Stripe emails the tenant a $450/mo invoice due in 7 days, then monthly. <strong className="text-emerald-300">No card required.</strong>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">Select CRM Tenant Partner</label>
                <select
                  value={rentingProspectId}
                  onChange={(e) => {
                    setRentResult(null); // clear stale result for previously-issued tenant
                    setRentingProspectId(e.target.value);
                  }}
                  className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white"
                  required
                >
                  <option value="" className="text-slate-600">Select CRM Prospect</option>
                  {activeTargetProspects.map(p => (
                    <option key={p.id} value={p.id} className="bg-[#111] text-white">
                      {p.name} ({p.pitchStatus})
                      {p.stripeSubscriptionId ? ` · 450/mo ACTIVE` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <button
                onClick={handleRentSite}
                disabled={isRenting || !rentingProspectId}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:opacity-50 text-white font-bold py-3.5 rounded-xl transition-all duration-150 shadow-lg shadow-emerald-900/20 flex items-center justify-center gap-2 cursor-pointer text-xs"
              >
                {isRenting ? (
                  <>
                    <Loader2 className="w-4.5 h-4.5 animate-spin text-white" />
                    Issuing Stripe rent invoice...
                  </>
                ) : (
                  <>
                    <FileText className="w-4 h-4 text-white" />
                    Send $450 Rent Invoice (Due in 7d)
                  </>
                )}
              </button>

              {/* Inline result panel — replaces the disruptive Stripe Checkout redirect */}
              {rentResult && (
                <div
                  className={`mt-2 p-3 rounded-xl border text-[11px] font-mono leading-relaxed ${
                    rentResult.kind === 'success' && rentResult.sendInvoiceFailed
                      ? 'border-amber-500/40 bg-amber-500/5 text-amber-200'
                      : rentResult.kind === 'success'
                        ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200'
                        : rentResult.kind === 'prereq'
                          ? 'border-blue-500/40 bg-blue-500/5 text-blue-200'
                          : 'border-rose-500/40 bg-rose-500/5 text-rose-200'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {rentResult.kind === 'success' && !rentResult.sendInvoiceFailed
                      ? <Check className="w-4 h-4 mt-0.5 shrink-0" />
                      : rentResult.kind === 'success'
                        ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        : rentResult.kind === 'prereq'
                          ? <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
                          : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-white">{rentResult.message}</div>
                      {rentResult.sub && <div className="mt-1 opacity-90">{rentResult.sub}</div>}
                      {rentResult.kind === 'success' && (
                        <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-300">
                          {rentResult.amount != null && rentResult.currency && (
                            <div>Amount: <span className="text-white font-bold">${(rentResult.amount / 100).toFixed(2)} {(rentResult.currency || 'usd').toUpperCase()}/mo</span></div>
                          )}
                          {rentResult.dueDate && (
                            <div>Due: <span className="text-white">{rentResult.dueDate.slice(0, 10)}</span></div>
                          )}
                          {rentResult.subscriptionId && (
                            <div className="col-span-2 truncate">Sub: <span className="text-slate-400">{rentResult.subscriptionId}</span></div>
                          )}
                          {rentResult.invoiceId && (
                            <div className="col-span-2 truncate">Invoice: <span className="text-slate-400">{rentResult.invoiceId}</span></div>
                          )}
                          {rentResult.invoiceUrl && (
                            <div className="col-span-2 mt-1">
                              <a href={rentResult.invoiceUrl} target="_blank" rel="noreferrer" className="underline text-emerald-300 hover:text-emerald-200 inline-flex items-center gap-1">
                                <ArrowUpRight className="w-3 h-3" /> Open hosted invoice
                              </a>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Code and Live Preview Panel */}
      <div className="lg:col-span-2 space-y-6">
        {activeSite ? (
          <div className="bg-[#0a0a0a] rounded-2xl border border-white/10 overflow-hidden shadow-2xl flex flex-col h-[700px]">
            {/* Header Toolbar */}
            <div className="bg-[#050505] text-white p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-white/10">
              <div>
                <span className="text-[10px] font-bold text-blue-400 uppercase font-mono tracking-wider">LIVE VISUAL WEB WORKSPACE</span>
                <h3 className="font-extrabold text-white text-base mt-0.5">{activeSite.siteTitle}</h3>
                <p className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
                  <span>{activeSite.city} - {activeSite.niche}</span>
                  <span className="text-slate-600">•</span>
                  <a
                    href={activeSite.domainName.startsWith('http') ? activeSite.domainName : `https://${activeSite.domainName}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline flex items-center gap-0.5 font-mono"
                  >
                    {activeSite.domainName}
                    <ArrowUpRight className="w-3 h-3" />
                  </a>
                </p>
              </div>

              {/* Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setPreviewTab('live')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
                    previewTab === 'live' ? 'bg-white/10 text-blue-400 border border-white/15' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  Live Preview
                </button>

                <button
                  onClick={() => setPreviewTab('code')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
                    previewTab === 'code' ? 'bg-white/10 text-blue-400 border border-white/15' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Code className="w-3.5 h-3.5" />
                  Source HTML
                </button>

                <div className="h-6 w-px bg-white/10 mx-1 hidden sm:block"></div>

                <button
                  onClick={handleCopyCode}
                  className="bg-white/5 hover:bg-white/10 text-slate-200 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition border border-white/5"
                  title="Copy full HTML code"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>

                <button
                  onClick={handleDownloadFile}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-black flex items-center gap-1 transition shadow-lg shadow-blue-900/10"
                  title="Download self-hosted HTML file"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export File
                </button>
              </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 bg-slate-900 overflow-hidden relative">
              {previewTab === 'live' ? (
                <iframe
                  title="Local Landing Page Live Preview"
                  srcDoc={activeSite.htmlCode}
                  className="w-full h-full border-none bg-white"
                  sandbox="allow-scripts"
                />
              ) : (
                <textarea
                  readOnly
                  value={activeSite.htmlCode}
                  className="w-full h-full p-6 font-mono text-xs bg-[#050505] text-slate-300 focus:outline-none resize-none border-none"
                />
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-16 text-center shadow-xl h-[600px] flex flex-col justify-center items-center">
            <Globe className="w-12 h-12 text-slate-600 mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">No Active Web Draft Selected</h2>
            <p className="text-sm text-slate-400 max-w-md">
              Please link a target market with an active forwarding number and click "Generate Local Landing Page" to compile responsive web markup instantly.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
