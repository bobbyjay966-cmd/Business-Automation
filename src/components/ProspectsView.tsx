import React, { useState } from 'react';
import { NicheCityTarget, ScrapedLead } from '../types';
import { Users, Search, Play, Mail, Phone, Copy, Check, FileDown, PlusCircle, Star, Edit, CheckSquare, MessageSquare, Database, LogOut, CheckCircle, ExternalLink, RefreshCw, DollarSign } from 'lucide-react';
import { initAuth, googleSignIn, logout, createSpreadsheet, appendLeadsToSpreadsheet } from '../lib/sheetsAuth';

interface ProspectsViewProps {
  targets: NicheCityTarget[];
  prospects: ScrapedLead[];
  onScrapeLeads: (targetId: string, niche: string, city: string) => Promise<void>;
  onGeneratePitch: (prospectId: string) => Promise<void>;
  onUpdateStatus: (prospectId: string, status: ScrapedLead['pitchStatus']) => Promise<void>;
  onSaveNotes: (prospectId: string, notes: string) => Promise<void>;
  scraping: boolean;
  pitching: boolean;
}

export default function ProspectsView({
  targets,
  prospects,
  onScrapeLeads,
  onGeneratePitch,
  onUpdateStatus,
  onSaveNotes,
  scraping,
  pitching,
}: ProspectsViewProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [activeLead, setActiveLead] = useState<ScrapedLead | null>(null);
  const [notesText, setNotesText] = useState('');
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedSms, setCopiedSms] = useState(false);

  // Google Sheets state and effects
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState<string | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState<string>(() => {
    return localStorage.getItem('rankrent_sheets_spreadsheet_id') || '';
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [sheetsFeedback, setSheetsFeedback] = useState<string | null>(null);

  React.useEffect(() => {
    const unsubscribe = initAuth(
      (currentUser, currentToken) => {
        setUser(currentUser);
        setToken(currentToken);
      },
      () => {
        setUser(null);
        setToken(null);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleSpreadsheetIdChange = (id: string) => {
    setSpreadsheetId(id);
    localStorage.setItem('rankrent_sheets_spreadsheet_id', id);
  };

  const handleSheetsConnect = async () => {
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setToken(result.accessToken);
        setSheetsFeedback('Successfully connected Google Account!');
      }
    } catch (error: any) {
      const code = error?.code || '';
      const hostname = error?.hostname || (typeof window !== 'undefined' ? window.location.hostname : '');
      if (code === 'auth/unauthorized-domain' || (typeof error?.message === 'string' && error.message.includes('auth/unauthorized-domain'))) {
        alert(
          `Google Connection Failed: Firebase: Error (auth/unauthorized-domain)\n\n` +
          `The host "${hostname}" is not whitelisted in your Firebase project "${error?.projectId || 'firebase project'}".\n\n` +
          `To fix this, open:\n` +
          `https://console.firebase.google.com/project/${error?.projectId || '<project>'}/authentication/settings\n\n` +
          `Then under "Authorized domains" click "Add domain" and add "${hostname}" (and any other host you deploy to, e.g. your production URL).`
        );
      } else {
        alert(`Google Connection Failed: ${error.message || error}`);
      }
    }
  };

  const handleSheetsDisconnect = async () => {
    try {
      await logout();
      setUser(null);
      setToken(null);
      setSheetsFeedback('Disconnected Google account.');
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateNewSheet = async () => {
    if (!token) return;
    setIsSyncing(true);
    setSheetsFeedback(null);
    try {
      const title = `Rank & Rent CRM Leads - ${selectedTarget ? selectedTarget.city + ' ' + selectedTarget.niche : 'SaaS Campaign'}`;
      const newId = await createSpreadsheet(token, title);
      handleSpreadsheetIdChange(newId);
      setSheetsFeedback('Created new Google Sheet Campaign Spreadsheet!');
    } catch (error: any) {
      setSheetsFeedback(`Failed to create spreadsheet: ${error.message || error}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncLeads = async () => {
    if (!token) {
      alert('Please connect Google Sheets first!');
      return;
    }
    if (!spreadsheetId) {
      alert('Please enter or create a Spreadsheet ID first!');
      return;
    }

    const contacted = prospects.filter(p => 
      p.pitchStatus === 'Pitched' || p.pitchStatus === 'Trial' || p.pitchStatus === 'Rented'
    );

    if (contacted.length === 0) {
      alert('No contacted CRM prospects to synchronize (Status must be Pitched, Trial, or Rented).');
      return;
    }

    setIsSyncing(true);
    setSheetsFeedback(null);
    try {
      await appendLeadsToSpreadsheet(token, spreadsheetId, contacted);
      setSheetsFeedback(`Successfully synchronized ${contacted.length} lead records to Google Sheet!`);
    } catch (error: any) {
      setSheetsFeedback(`Failed to sync: ${error.message || error}`);
    } finally {
      setIsSyncing(false);
    }
  };

  React.useEffect(() => {
    if (targets.length > 0 && !selectedTargetId) {
      setSelectedTargetId(targets[0].id);
    }
  }, [targets, selectedTargetId]);

  const selectedTarget = targets.find(t => t.id === selectedTargetId);
  const filteredProspects = prospects.filter(p => p.targetId === selectedTargetId);

  const handleScrape = async () => {
    if (!selectedTarget) return;
    await onScrapeLeads(selectedTarget.id, selectedTarget.niche, selectedTarget.city);
  };

  const handleSelectLead = (lead: ScrapedLead) => {
    setActiveLead(lead);
    setNotesText(lead.notes || '');
  };

  const handleSaveNotes = async () => {
    if (!activeLead) return;
    await onSaveNotes(activeLead.id, notesText);
    alert('Notes saved successfully.');
  };

  const copyToClipboard = (text: string, isEmail: boolean) => {
    navigator.clipboard.writeText(text);
    if (isEmail) {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    } else {
      setCopiedSms(true);
      setTimeout(() => setCopiedSms(false), 2000);
    }
  };

  const handleExportCsv = () => {
    if (filteredProspects.length === 0) return;
    const headers = ['Business Name', 'Phone', 'Website', 'Rating', 'Reviews', 'Address', 'GMB Claimed', 'Pitch Status', 'Notes'];
    const rows = filteredProspects.map(p => [
      `"${p.name.replace(/"/g, '""')}"`,
      `"${p.phone || ''}"`,
      `"${p.website || ''}"`,
      p.rating,
      p.reviewCount,
      `"${p.address.replace(/"/g, '""')}"`,
      p.gmbStatus,
      p.pitchStatus,
      `"${(p.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `rank-rent-leads-${selectedTarget?.city}-${selectedTarget?.niche}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportContactedCsv = () => {
    const contactedProspects = prospects.filter(p => 
      p.pitchStatus === 'Pitched' || p.pitchStatus === 'Trial' || p.pitchStatus === 'Rented'
    );
    
    if (contactedProspects.length === 0) {
      alert("No prospects have been contacted yet (Status must be Pitched, Trial, or Rented).");
      return;
    }
    
    const headers = ['Business Name', 'Niche', 'City', 'Phone', 'Website', 'Rating', 'Reviews', 'Address', 'GMB Status', 'Pitch CRM Status', 'Notes', 'Custom AI Email Pitch', 'Custom AI SMS Pitch', 'Date Discovered'];
    const rows = contactedProspects.map(p => [
      `"${p.name.replace(/"/g, '""')}"`,
      `"${p.niche.replace(/"/g, '""')}"`,
      `"${p.city.replace(/"/g, '""')}"`,
      `"${p.phone || ''}"`,
      `"${p.website || ''}"`,
      p.rating,
      p.reviewCount,
      `"${p.address.replace(/"/g, '""')}"`,
      p.gmbStatus,
      p.pitchStatus,
      `"${(p.notes || '').replace(/"/g, '""')}"`,
      `"${(p.pitchEmailContent || '').replace(/"/g, '""')}"`,
      `"${(p.pitchSmsContent || '').replace(/"/g, '""')}"`,
      `"${p.createdAt}"`
    ]);

    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `contacted-crm-leads-export.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="grid lg:grid-cols-3 gap-8">
      {/* Target selector & list */}
      <div className="lg:col-span-2 space-y-6">
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-400" />
                Scrape & Qualify Leads
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Scrape local business profiles, qualify website needs, and pitch free trial leads.</p>
            </div>

            <div className="flex items-center gap-3">
              <select
                value={selectedTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
                className="bg-[#111] border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="" disabled className="text-slate-600">Select Target Market</option>
                {targets.map(t => (
                  <option key={t.id} value={t.id} className="bg-[#111] text-white">{t.niche} - {t.city}</option>
                ))}
              </select>

              {selectedTarget && (
                <button
                  onClick={handleScrape}
                  disabled={scraping}
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-xl text-xs transition flex items-center gap-2 disabled:opacity-75 cursor-pointer shadow-lg shadow-blue-900/20"
                >
                  {scraping ? (
                    <span className="flex items-center gap-1">
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                      Searching...
                    </span>
                  ) : (
                    <>
                      <PlusCircle className="w-4 h-4 text-white" />
                      Scrape Google Leads
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {filteredProspects.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-white/[0.01]">
              <Users className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <h3 className="font-bold text-white text-sm">No Leads Scraped Yet</h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                Trigger our search-grounding lead scraper using the button above to discover local businesses without websites or with weak GMB profiles.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white/5 p-4 rounded-xl border border-white/10">
                <span className="text-xs font-mono font-bold text-slate-400">{filteredProspects.length} Opportunities Located</span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleExportCsv}
                    className="text-xs font-bold text-slate-300 hover:text-blue-400 transition flex items-center gap-1.5 cursor-pointer bg-white/5 px-2.5 py-1.5 rounded-lg border border-white/5"
                    title="Export currently filtered target leads"
                  >
                    <FileDown className="w-3.5 h-3.5 text-blue-400" />
                    Export Selected Market (.csv)
                  </button>
                  <button
                    onClick={handleExportContactedCsv}
                    className="text-xs font-black text-white bg-blue-600 hover:bg-blue-500 transition flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-lg shadow-lg shadow-blue-900/10 border border-blue-500/30"
                    title="Export all pitched, trial, and rented leads for external CRM systems"
                  >
                    <FileDown className="w-3.5 h-3.5 text-white" />
                    Export Contacted CRM Leads (.csv)
                  </button>
                </div>
              </div>

              {/* Google Sheets Live Sync Integration Panel */}
              <div className="bg-white/[0.02] rounded-xl border border-white/10 p-5 space-y-4 shadow-inner">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                        Google Sheets CRM Sync
                        <span className="bg-emerald-500/10 text-emerald-400 text-[8px] font-mono px-1.5 py-0.5 rounded border border-emerald-500/20">
                          LIVE OAUTH
                        </span>
                      </h4>
                      <p className="text-[10px] text-slate-400 mt-0.5">Automate exporting contacted CRM prospects directly to target Google spreadsheets.</p>
                    </div>
                  </div>

                  {!user ? (
                    <button
                      onClick={handleSheetsConnect}
                      className="text-xs font-bold text-white bg-slate-800 hover:bg-[#111] hover:border-slate-700 transition flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 cursor-pointer shadow-md"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
                      </svg>
                      Connect Google Account
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/5 px-2.5 py-1 rounded-lg border border-emerald-500/15">
                        Connected: {user.email || 'Google Account'}
                      </span>
                      <button
                        onClick={handleSheetsDisconnect}
                        className="text-[10px] font-bold text-rose-400 hover:text-rose-300 transition flex items-center gap-1 cursor-pointer"
                        title="Disconnect account"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    </div>
                  )}
                </div>

                {user && (
                  <div className="grid md:grid-cols-3 gap-3 items-end">
                    <div className="md:col-span-2 space-y-1.5">
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
                        Active Google Spreadsheet ID
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={spreadsheetId}
                          onChange={(e) => handleSpreadsheetIdChange(e.target.value)}
                          placeholder="Paste sheet ID or create a new one..."
                          className="flex-1 bg-[#090909] border border-white/5 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500/30 font-mono"
                        />
                        <button
                          onClick={handleCreateNewSheet}
                          disabled={isSyncing}
                          className="bg-white/5 hover:bg-white/10 text-slate-200 text-xs font-semibold px-3 py-1.5 rounded-lg border border-white/5 transition flex items-center gap-1 cursor-pointer shrink-0"
                          title="Generate a brand new campaign spreadsheet in your Google Drive"
                        >
                          <PlusCircle className="w-3.5 h-3.5 text-emerald-400" />
                          Create New
                        </button>
                      </div>
                    </div>

                    <button
                      onClick={handleSyncLeads}
                      disabled={isSyncing || !spreadsheetId}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-2 rounded-lg text-xs transition flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-emerald-950/20 disabled:opacity-50"
                    >
                      {isSyncing ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin text-white" />
                          Synchronizing...
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-3.5 h-3.5 text-white" />
                          Sync CRM to Google Sheet
                        </>
                      )}
                    </button>
                  </div>
                )}

                {sheetsFeedback && (
                  <div className={`text-[10px] font-mono p-3 rounded-lg flex items-center justify-between gap-3 ${
                    sheetsFeedback.toLowerCase().includes('failed') || sheetsFeedback.toLowerCase().includes('error')
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  }`}>
                    <span className="leading-relaxed">{sheetsFeedback}</span>
                    {spreadsheetId && !sheetsFeedback.toLowerCase().includes('failed') && (
                      <a
                        href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] font-bold text-sky-400 hover:text-sky-300 transition flex items-center gap-1 cursor-pointer shrink-0 font-sans"
                      >
                        Open Spreadsheet <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-slate-400 font-bold uppercase tracking-wider">
                      <th className="pb-3 font-semibold">Business</th>
                      <th className="pb-3 font-semibold">Website</th>
                      <th className="pb-3 text-right font-semibold">GMB Stats</th>
                      <th className="pb-3 text-center font-semibold">GMB Claimed</th>
                      <th className="pb-3 text-center font-semibold">Pitch CRM</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredProspects.map((lead) => {
                      const isActive = activeLead?.id === lead.id;
                      return (
                        <tr
                          key={lead.id}
                          onClick={() => handleSelectLead(lead)}
                          className={`hover:bg-white/[0.01] cursor-pointer transition ${isActive ? 'bg-white/5 font-semibold text-white' : ''}`}
                        >
                          <td className="py-4">
                            <div className="font-bold text-white text-sm">{lead.name}</div>
                            <div className="text-slate-400 text-[10px] mt-0.5 font-medium truncate max-w-[200px]">{lead.address}</div>
                          </td>
                          <td className="py-4">
                            {lead.website ? (
                              <a
                                href={lead.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:underline font-bold truncate max-w-[120px] inline-block"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {lead.website.replace('https://', '').replace('www.', '')}
                              </a>
                            ) : (
                              <span className="text-rose-400 bg-rose-500/10 border border-rose-500/20 font-bold px-2 py-0.5 rounded text-[10px]">
                                No Website! (Prime Target)
                              </span>
                            )}
                          </td>
                          <td className="py-4 text-right">
                            <div className="flex items-center justify-end gap-1 font-bold text-slate-300">
                              <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                              {lead.rating}
                            </div>
                            <div className="text-[10px] text-slate-400 font-medium">{lead.reviewCount} reviews</div>
                          </td>
                          <td className="py-4 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              lead.gmbStatus === 'Unclaimed' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                              lead.gmbStatus === 'Claimed' ? 'bg-white/5 text-slate-300 border border-white/10' : 'bg-white/[0.01] text-slate-500 border border-white/5'
                            }`}>
                              {lead.gmbStatus}
                            </span>
                          </td>
                          <td className="py-4 text-center">
                            <span className={`px-2 py-1 rounded font-bold uppercase text-[10px] border ${
                              lead.pitchStatus === 'Rented' ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30' :
                              lead.pitchStatus === 'Trial' ? 'bg-blue-600/20 text-blue-400 border-blue-500/30' :
                              lead.pitchStatus === 'Pitched' ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30' :
                              lead.pitchStatus === 'Disqualified' ? 'bg-rose-600/20 text-rose-400 border-rose-500/30' : 'bg-white/5 text-slate-300 border-white/5'
                            }`}>
                              {lead.pitchStatus}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Prospect Pitching & Notes Workspace */}
      <div className="lg:col-span-1 space-y-6">
        {activeLead ? (
          <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl space-y-6">
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider">CRM LEAD DETAIL</span>
              <h3 className="font-extrabold text-white text-base mt-1 flex items-center gap-2">
                {activeLead.name}
                {activeLead.pitchStatus === 'Rented' && activeLead.stripeSubscriptionId && (
                  <span className="bg-emerald-500/10 text-emerald-400 text-[9px] font-mono px-2 py-0.5 rounded border border-emerald-500/20 font-bold shrink-0 animate-pulse">
                    $450/mo Stripe Active
                  </span>
                )}
              </h3>
              <p className="text-xs text-slate-400 font-medium">{activeLead.phone || "No phone listed"}</p>

              {/* Stripe Subscription / Invoice Card */}
              {activeLead.stripeSubscriptionId && (
                <div className="mt-4 bg-gradient-to-br from-emerald-600/10 via-transparent to-transparent border border-emerald-500/25 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider font-mono text-emerald-400 flex items-center gap-1">
                      <DollarSign className="w-3 h-3" /> Stripe Subscription
                      <span className={`ml-1 px-1.5 py-0.5 rounded border text-[8px] font-bold ${activeLead.subscriptionMode === 'live' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-slate-700/40 border-slate-500/40 text-slate-300'}`}>
                        {activeLead.subscriptionMode === 'live' ? 'LIVE' : 'MOCK'}
                      </span>
                    </span>
                    {activeLead.stripeInvoiceUrl && (
                      <a
                        href={activeLead.stripeInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] font-bold text-emerald-300 hover:text-emerald-200 underline flex items-center gap-1"
                        title="Open hosted invoice in Stripe"
                      >
                        <ExternalLink className="w-3 h-3" /> Open invoice
                      </a>
                    )}
                  </div>

                  {/* Status row: subscription state (revenue) + invoice state (billing-document) are
                      rendered as TWO SEPARATE badges so an operator can tell at a glance whether
                      the recurring billing cycle is healthy vs whether the most recent invoice
                      has been voided/uncollectible/refunded. */}
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const sub = activeLead.stripeSubscriptionStatus || 'active';
                      const SUB_STYLE: Record<string, { label: string; cls: string }> = {
                        active:            { label: 'active',           cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
                        past_due:          { label: 'past_due',         cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
                        unpaid:            { label: 'unpaid',           cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
                        canceled:          { label: 'canceled',         cls: 'bg-slate-700/40 text-slate-300 border-slate-500/40' },
                        incomplete:        { label: 'incomplete',       cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
                        incomplete_expired:{ label: 'incomplete_expired', cls: 'bg-slate-700/40 text-slate-300 border-slate-500/40' },
                        paused:            { label: 'paused',           cls: 'bg-slate-700/40 text-slate-300 border-slate-500/40' },
                        trialing:          { label: 'trialing',         cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
                      };
                      const s = SUB_STYLE[sub] || { label: sub, cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' };
                      return (
                        <span
                          className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border flex items-center gap-1 ${s.cls}`}
                          title={`Subscription state from Stripe: "${sub}". Healthy = active / trialing. Warning = past_due, incomplete. Terminal = canceled, unpaid, incomplete_expired.`}
                        >
                          <span className="opacity-70">SUB</span> {s.label}
                        </span>
                      );
                    })()}
                    {activeLead.stripeInvoiceStatus && activeLead.stripeInvoiceStatus !== 'paid' && activeLead.stripeInvoiceStatus !== 'open' && activeLead.stripeInvoiceStatus !== 'draft' && (() => {
                      const inv = activeLead.stripeInvoiceStatus;
                      const INV_STYLE: Record<string, { label: string; cls: string; tip: string }> = {
                        void:          { label: 'invoice void',          cls: 'bg-slate-700/50 text-slate-300 border-slate-500/40',  tip: 'Most recent invoice was voided/deleted — hosted URL no longer resolves.' },
                        uncollectible: { label: 'invoice uncollectible', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30',      tip: 'Stripe Smart Retries fully exhausted on most recent invoice.' },
                        refunded:      { label: 'invoice refunded',      cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30', tip: 'Most recent invoice was paid and then refunded. Subscription may still be active.' },
                      };
                      const s = INV_STYLE[inv];
                      if (!s) return null;
                      return (
                        <span
                          className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border flex items-center gap-1 ${s.cls}`}
                          title={s.tip}
                        >
                          <span className="opacity-70">INV</span> {s.label}
                        </span>
                      );
                    })()}
                    {activeLead.stripeChargeRefundedId && activeLead.stripeInvoiceStatus !== 'refunded' && (
                      <span
                        className="text-[10px] font-mono font-bold px-2 py-0.5 rounded border flex items-center gap-1 bg-orange-500/15 text-orange-300 border-orange-500/30"
                        title={`A charge was refunded (id=${activeLead.stripeChargeRefundedId}). The original invoice stays 'paid' on Stripe's books since refunds are charge-level events — the recurring subscription continues unless separately canceled.`}
                      >
                        <span className="opacity-70">REFUND</span> charge: <span className="font-mono opacity-80">{activeLead.stripeChargeRefundedId.slice(-8)}</span>
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono text-slate-300">
                    <div>Customer: <span className="text-white">{activeLead.email || 'n/a'}</span></div>
                    <div>Sub ID: <span className="text-slate-400 truncate">{activeLead.stripeSubscriptionId}</span></div>
                    <div>Invoice: <span className="text-slate-400">{activeLead.stripeInvoiceNumber || activeLead.stripeInvoiceId}</span></div>
                    <div>Amount: <span className="text-white font-bold">${((activeLead.subscriptionAmount || 45000) / 100).toFixed(2)} {(activeLead.subscriptionCurrency || 'usd').toUpperCase()}/mo</span></div>
                    <div>Next due: <span className="text-white">{activeLead.subscriptionNextDueDate?.slice(0, 10) || '—'}</span></div>
                    <div>Last paid: <span className="text-white">{activeLead.subscriptionLastPaidAt ? activeLead.subscriptionLastPaidAt.slice(0, 10) : '—'}</span></div>
                  </div>
                </div>
              )}
            </div>

            {/* Change Status */}
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">Lead CRM Status</label>
              <div className="grid grid-cols-2 gap-2">
                {(['Scraped', 'Pitched', 'Trial', 'Rented', 'Disqualified'] as const).map((status) => (
                  <button
                    key={status}
                    onClick={() => onUpdateStatus(activeLead.id, status)}
                    className={`px-3 py-2 rounded-xl text-xs font-bold border transition ${
                      activeLead.pitchStatus === status
                        ? 'bg-blue-600 text-white border-blue-500 shadow-md'
                        : 'bg-white/5 text-slate-300 border-white/10 hover:border-white/20 hover:bg-white/10'
                    }`}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>

            {/* AI Pitch Generator */}
            <div className="border-t border-white/10 pt-6">
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-3">Custom Cold Pitch (Robert's Script)</h4>
              
              {!activeLead.pitchEmailContent ? (
                <button
                  onClick={() => onGeneratePitch(activeLead.id)}
                  disabled={pitching}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl text-xs flex items-center justify-center gap-2 transition disabled:opacity-75 cursor-pointer shadow-lg shadow-blue-900/20"
                >
                  {pitching ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                      Drafting Pitch with AI...
                    </span>
                  ) : (
                    <>
                      <Mail className="w-4 h-4 text-white" />
                      Generate Personalized Pitch
                    </>
                  )}
                </button>
              ) : (
                <div className="space-y-4">
                  {/* Email Pitch */}
                  <div className="bg-white/[0.02] p-4 rounded-xl border border-white/10 space-y-2">
                    <div className="flex justify-between items-center border-b border-white/5 pb-2 mb-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                        <Mail className="w-3 h-3 text-slate-400" /> Email Pitch Script
                      </span>
                      <button
                        onClick={() => copyToClipboard(activeLead.pitchEmailContent || '', true)}
                        className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition flex items-center gap-1 cursor-pointer"
                      >
                        {copiedEmail ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copiedEmail ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{activeLead.pitchEmailContent}</p>
                  </div>

                  {/* SMS Pitch */}
                  <div className="bg-white/[0.02] p-4 rounded-xl border border-white/10 space-y-2">
                    <div className="flex justify-between items-center border-b border-white/5 pb-2 mb-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                        <MessageSquare className="w-3 h-3 text-slate-400" /> SMS Pitch Script
                      </span>
                      <button
                        onClick={() => copyToClipboard(activeLead.pitchSmsContent || '', false)}
                        className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition flex items-center gap-1 cursor-pointer"
                      >
                        {copiedSms ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        {copiedSms ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{activeLead.pitchSmsContent}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Notes Section */}
            <div className="border-t border-white/10 pt-6">
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">CRM Call Notes</label>
              <textarea
                value={notesText}
                onChange={(e) => setNotesText(e.target.value)}
                placeholder="Log business callback dates, owner names, pricing demands..."
                rows={3}
                className="w-full bg-[#111] border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
              <button
                onClick={handleSaveNotes}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded-xl text-xs mt-2 transition cursor-pointer shadow-lg shadow-blue-900/10"
              >
                Save Notes
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white/5 rounded-2xl border border-white/10 p-12 text-center shadow-xl">
            <Users className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <h3 className="font-bold text-white text-sm">Select A Prospect</h3>
            <p className="text-xs text-slate-400 max-w-xs mx-auto mt-1">
              Select any company lead from the list to update CRM status, log notes, and generate cold outreach copies.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
