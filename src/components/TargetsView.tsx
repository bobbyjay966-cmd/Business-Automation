import React, { useState } from 'react';
import { NicheCityTarget } from '../types';
import { Search, Loader2, Award, ShieldAlert, BarChart3, HelpCircle, Trash2, ArrowUpRight, TrendingUp } from 'lucide-react';

interface TargetsViewProps {
  targets: NicheCityTarget[];
  onAddTarget: (niche: string, city: string) => Promise<void>;
  onDeleteTarget: (id: string) => Promise<void>;
  loading: boolean;
}

export default function TargetsView({ targets, onAddTarget, onDeleteTarget, loading }: TargetsViewProps) {
  const [niche, setNiche] = useState('');
  const [city, setCity] = useState('');
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!niche.trim() || !city.trim()) return;
    await onAddTarget(niche, city);
    setNiche('');
    setCity('');
  };

  const selectedTarget = targets.find(t => t.id === selectedTargetId) || targets[0];

  React.useEffect(() => {
    if (targets.length > 0 && !selectedTargetId) {
      setSelectedTargetId(targets[0].id);
    }
  }, [targets, selectedTargetId]);

  const getDifficultyColor = (diff: number) => {
    if (diff < 35) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 border';
    if (diff < 65) return 'text-amber-400 bg-amber-500/10 border-amber-500/20 border';
    return 'text-rose-400 bg-rose-500/10 border-rose-500/20 border';
  };

  const getDifficultyLabel = (diff: number) => {
    if (diff < 35) return 'Easy Rank';
    if (diff < 65) return 'Moderate';
    return 'Competitive';
  };

  return (
    <div className="grid lg:grid-cols-3 gap-8">
      {/* Target Market Creator and List */}
      <div className="lg:col-span-1 space-y-6">
        {/* Research Form */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
            <Search className="w-5 h-5 text-blue-400" />
            SEO Keyword Research
          </h2>
          <p className="text-xs text-slate-400 mb-4">
            Input a local niche and city. We'll analyze search patterns in real time via AI to extract real search volumes, ranking difficulty, and competitors.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Local Niche / Service</label>
              <input
                type="text"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="e.g. Plumbing, Tree Service, Towing"
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white placeholder-slate-600"
                required
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">Target City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Dallas, Miami, Orlando"
                className="w-full bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-white placeholder-slate-600"
                required
                disabled={loading}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl transition-all duration-150 shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 disabled:opacity-75 cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-white" />
                  Analyzing SERP with AI...
                </>
              ) : (
                <>
                  <Search className="w-4.5 h-4.5 text-white" />
                  Analyze Target Market
                </>
              )}
            </button>
          </form>
        </div>

        {/* Existing Targets */}
        <div className="bg-white/5 rounded-2xl border border-white/10 p-6 shadow-xl">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Saved Target Markets ({targets.length})</h2>
          {targets.length === 0 ? (
            <div className="text-center py-10 border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
              <p className="text-xs text-slate-400">No markets analyzed yet.</p>
              <p className="text-xs text-slate-500 mt-1">Start research using the form above.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {targets.map((target) => {
                const isSelected = selectedTargetId === target.id;
                return (
                  <div
                    key={target.id}
                    onClick={() => setSelectedTargetId(target.id)}
                    className={`p-4 rounded-xl border transition-all duration-150 cursor-pointer flex justify-between items-start gap-4 ${
                      isSelected
                        ? 'bg-white/5 border-blue-500 shadow-md'
                        : 'border-white/5 bg-white/[0.01] hover:border-white/10 hover:bg-white/[0.02]'
                    }`}
                  >
                    <div className="min-w-0">
                      <h3 className="font-bold text-white text-sm truncate">{target.niche}</h3>
                      <p className="text-xs text-slate-400 font-medium truncate">{target.city}</p>
                      
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full font-mono uppercase bg-white/5 text-slate-300 border border-white/5">
                          Vol: {target.monthlyVolume}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full font-mono ${getDifficultyColor(target.avgDifficulty)}`}>
                          KD: {target.avgDifficulty}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTarget(target.id);
                      }}
                      className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                      title="Delete target market"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Target Market Details View */}
      <div className="lg:col-span-2 space-y-6">
        {selectedTarget ? (
          <>
            {/* Header Metrics */}
            <div className="bg-white/5 border border-white/10 rounded-3xl p-8 relative overflow-hidden shadow-xl">
              <div className="absolute right-0 top-0 translate-x-12 -translate-y-12 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl pointer-events-none"></div>
              
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-white/10 pb-6">
                <div>
                  <span className="text-xs font-bold text-blue-400 font-mono tracking-wider uppercase block">TARGET MARKET PROFILE</span>
                  <h1 className="text-3xl font-black tracking-tight text-white mt-1">{selectedTarget.niche}</h1>
                  <p className="text-slate-400 text-sm mt-0.5">{selectedTarget.city}</p>
                </div>
                <div className="flex items-center gap-2 bg-[#111] px-4 py-2 rounded-2xl border border-white/10">
                  <span className="text-xs text-slate-400 font-medium">Rank Status:</span>
                  <span className="text-xs font-bold text-blue-400 font-mono uppercase bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                    {selectedTarget.status.replace('_', ' ')}
                  </span>
                </div>
              </div>

              {/* Grid Metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-6">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Est. Local Volume</span>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-white">{selectedTarget.monthlyVolume}</span>
                    <span className="text-xs text-slate-500 font-semibold font-mono">/mo</span>
                  </div>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">SERP Difficulty</span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-2xl font-black text-white">{selectedTarget.avgDifficulty}</span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${getDifficultyColor(selectedTarget.avgDifficulty)}`}>
                      {getDifficultyLabel(selectedTarget.avgDifficulty)}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">GMB Opportunity</span>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-white">{selectedTarget.gmbScore}</span>
                    <span className="text-xs text-slate-500 font-semibold font-mono">/100</span>
                  </div>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Market Viability</span>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-lg font-bold text-emerald-400 flex items-center gap-1">
                      <TrendingUp className="w-5 h-5 text-emerald-400" />
                      {selectedTarget.avgDifficulty < 50 ? 'Strong' : 'Medium'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Keyword breakdown */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
              <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-blue-400" />
                Keyword Volume & Difficulty Index
              </h2>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-xs font-bold text-slate-400 uppercase tracking-wider">
                      <th className="pb-3 font-semibold">Keyword</th>
                      <th className="pb-3 text-right font-semibold">Search Volume</th>
                      <th className="pb-3 text-right font-semibold">Difficulty (KD)</th>
                      <th className="pb-3 text-center font-semibold">Competition</th>
                      <th className="pb-3 text-right font-semibold">Est. CPC</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {selectedTarget.keywords.map((kw, idx) => (
                      <tr key={idx} className="hover:bg-white/[0.01]">
                        <td className="py-3.5 font-bold text-white">{kw.keyword}</td>
                        <td className="py-3.5 text-right font-mono font-medium text-slate-300">{kw.searchVolume}</td>
                        <td className="py-3.5 text-right font-mono font-bold">
                          <span className={`px-2.5 py-1 rounded-md text-xs inline-block ${getDifficultyColor(kw.difficulty)}`}>
                            {kw.difficulty}%
                          </span>
                        </td>
                        <td className="py-3.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                            kw.competition === 'Low' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                            kw.competition === 'Medium' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                          }`}>
                            {kw.competition}
                          </span>
                        </td>
                        <td className="py-3.5 text-right font-mono text-slate-300 font-medium">${kw.cpc.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Organic SEO Competitor Map */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6 shadow-xl">
              <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
                <Award className="w-5 h-5 text-blue-400" />
                SERP Dominant Competitors
              </h2>

              <div className="grid sm:grid-cols-3 gap-4">
                {selectedTarget.competitors.map((comp, idx) => (
                  <div key={idx} className="border border-white/5 p-5 rounded-2xl bg-[#111]/40 hover:bg-white/[0.02] transition duration-150">
                    <div className="flex justify-between items-start mb-3">
                      <span className="text-xs font-mono font-bold text-slate-500">POS #{comp.rank}</span>
                      <a href={`https://${comp.domain}`} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-400 transition">
                        <ArrowUpRight className="w-4 h-4" />
                      </a>
                    </div>
                    <h3 className="font-bold text-white text-sm truncate" title={comp.domain}>{comp.domain}</h3>
                    
                    <div className="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-white/5">
                      <div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase block">Traffic</span>
                        <span className="text-xs font-mono font-bold text-slate-300">{comp.estimatedTraffic}/mo</span>
                      </div>
                      <div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase block">Backlinks</span>
                        <span className="text-xs font-mono font-bold text-slate-300">{comp.backlinksCount}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="bg-white/5 border border-white/10 rounded-3xl p-12 text-center shadow-xl">
            <TrendingUp className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">No SEO Target Selected</h2>
            <p className="text-sm text-slate-400 max-w-md mx-auto">
              Please enter a niche and targeted city to generate search metrics, keyword analyses, and competitors organically via AI.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
