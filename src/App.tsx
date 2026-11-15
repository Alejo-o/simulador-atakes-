import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  FileBarChart2,
  FlaskConical,
  GitCompare,
  Globe,
  History,
  Menu,
  Moon,
  Server,
  ShieldAlert,
  Sun,
  X,
} from 'lucide-react';
import {
  umbralApi,
  useUmbralSocket,
  type ExperimentSummary,
  type TargetItem,
  type WsStreamMessage,
} from './api/client';
import { PermanentProvenanceLegend } from './components/ProvenanceMark';
import { ES } from './i18n/es';
import { AuditPage } from './pages/AuditPage';
import { ComparisonPage } from './pages/ComparisonPage';
import { DashboardPage } from './pages/DashboardPage';
import { HistoryPage } from './pages/HistoryPage';
import { ReportsPage } from './pages/ReportsPage';
import { TargetsPage } from './pages/TargetsPage';
import { WebPredictorPage } from './pages/WebPredictorPage';
import { WizardPage } from './pages/WizardPage';

type NavTab =
  | 'dashboard'
  | 'web'
  | 'targets'
  | 'wizard'
  | 'comparison'
  | 'history'
  | 'reports'
  | 'audit';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [wizardTargetId, setWizardTargetId] = useState<string | null>(null);
  const [liveWindows, setLiveWindows] = useState<
    Array<{
      lambdaObs: number;
      wMean: number;
      wP50: number;
      wP95: number;
      wP99: number;
      provenance: 'MEASURED' | 'SIMULATED' | 'PREDICTED';
    }>
  >([]);

  const refreshAll = useCallback(async () => {
    const [tList, eList] = await Promise.all([umbralApi.getTargets(), umbralApi.getExperiments()]);
    setTargets(tList);
    setExperiments(eList);
    setSelectedExperimentId((prev) => prev ?? eList[0]?.id ?? null);
  }, []);

  useEffect(() => {
    refreshAll().catch(() => {});
  }, [refreshAll]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const handleWsMessage = useCallback(
    (msg: WsStreamMessage) => {
      if (msg.event === 'simulation_window') {
        const w = (msg.payload as { window?: Record<string, unknown> }).window;
        if (w) {
          setLiveWindows((prev) => [
            ...prev.slice(-49),
            {
              lambdaObs: Number(w.lambdaObs),
              wMean: Number(w.wMean),
              wP50: Number(w.wP50),
              wP95: Number(w.wP95),
              wP99: Number(w.wP99),
              provenance: 'SIMULATED',
            },
          ]);
        }
      } else if (msg.event === 'probe_step') {
        const st = (msg.payload as { step?: Record<string, unknown> }).step;
        if (st) {
          setLiveWindows((prev) => [
            ...prev.slice(-49),
            {
              lambdaObs: Number(st.rps),
              wMean: Number(st.wMean),
              wP50: Number(st.wP50),
              wP95: Number(st.wP95),
              wP99: Number(st.wP99),
              provenance: 'MEASURED',
            },
          ]);
        }
      } else if (msg.event === 'experiment_completed') {
        refreshAll().catch(() => {});
      }
    },
    [refreshAll],
  );

  const { connected: wsConnected } = useUmbralSocket(handleWsMessage);

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: ES.nav.dashboard, icon: <Activity className="w-4 h-4" /> },
    { id: 'web', label: ES.nav.web, icon: <Globe className="w-4 h-4" /> },
    { id: 'targets', label: ES.nav.targets, icon: <Server className="w-4 h-4" /> },
    { id: 'wizard', label: ES.nav.wizard, icon: <FlaskConical className="w-4 h-4" /> },
    { id: 'comparison', label: ES.nav.comparison, icon: <GitCompare className="w-4 h-4" /> },
    { id: 'history', label: ES.nav.history, icon: <History className="w-4 h-4" /> },
    { id: 'reports', label: ES.nav.reports, icon: <FileBarChart2 className="w-4 h-4" /> },
    { id: 'audit', label: ES.nav.audit, icon: <ShieldAlert className="w-4 h-4" /> },
  ];

  const handleNavigate = (tab: NavTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-50 dark:bg-[#07090E] text-slate-900 dark:text-slate-100">
      {/* Sidebar Desktop */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shrink-0">
        <div className="h-14 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            {ES.appName}
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="Navegación principal">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 space-y-2">
          <div className="flex items-center justify-between">
            <span>Canal en vivo</span>
            <span className="font-mono text-[11px] text-slate-700 dark:text-slate-300">
              {wsConnected ? '● Conectado' : '○ Reconectando'}
            </span>
          </div>
          <div className="text-[11px] leading-snug">
            Tope sondeo: ≤5 req/s · ≤60 s · Concurrencia ≤2
          </div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar (3 zones: title/menu | provenance legend | actions) */}
        <header className="h-14 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Abrir menú de navegación"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="lg:hidden p-2 rounded-md border border-slate-300 dark:border-slate-700"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <span className="lg:hidden font-display font-bold text-base whitespace-nowrap">
              {ES.appName}
            </span>
            <span className="hidden lg:inline text-sm font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
              {navItems.find((n) => n.id === activeTab)?.label}
            </span>
          </div>

          <div className="hidden xl:block">
            <PermanentProvenanceLegend />
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label={darkMode ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
              className="p-2 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('wizard')}
              className="px-3.5 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              Nuevo experimento
            </button>
          </div>
        </header>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <nav
            className="lg:hidden border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3 grid grid-cols-2 gap-1.5"
            aria-label="Navegación móvil"
          >
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-md ${
                  activeTab === item.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        )}

        {/* Permanent Legal Notice + Compact Provenance Legend on smaller screens */}
        <div className="px-4 sm:px-6 py-2 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-300">
          <p className="leading-snug">{ES.legalNotice}</p>
          <div className="xl:hidden">
            <PermanentProvenanceLegend />
          </div>
        </div>

        {/* Page Content */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {activeTab === 'dashboard' && (
            <DashboardPage
              experiments={experiments}
              selectedExperimentId={selectedExperimentId}
              onSelectExperiment={(id) => {
                setLiveWindows([]);
                setSelectedExperimentId(id);
              }}
              onNavigateWizard={() => handleNavigate('wizard')}
              onNavigateWeb={() => handleNavigate('web')}
              onNavigateComparison={() => handleNavigate('comparison')}
              onNavigateReports={() => handleNavigate('reports')}
              liveWindows={liveWindows}
            />
          )}

          {activeTab === 'web' && (
            <WebPredictorPage
              targets={targets}
              initialTargetId={wizardTargetId}
              liveProbeSteps={liveWindows}
              onTargetsUpdated={refreshAll}
              onExperimentCreated={async (expId) => {
                setLiveWindows([]);
                await refreshAll();
                setSelectedExperimentId(expId);
                handleNavigate('dashboard');
              }}
            />
          )}

          {activeTab === 'targets' && (
            <TargetsPage
              targets={targets}
              onRefresh={refreshAll}
              onEvaluateSite={(tid) => {
                setWizardTargetId(tid);
                handleNavigate('web');
              }}
            />
          )}

          {activeTab === 'wizard' && (
            <WizardPage
              targets={targets}
              initialTargetId={wizardTargetId}
              onExperimentCreated={async (expId) => {
                setLiveWindows([]);
                await refreshAll();
                setSelectedExperimentId(expId);
                handleNavigate('dashboard');
              }}
            />
          )}

          {activeTab === 'comparison' && <ComparisonPage />}

          {activeTab === 'history' && (
            <HistoryPage
              experiments={experiments}
              onSelectForDashboard={(id) => {
                setLiveWindows([]);
                setSelectedExperimentId(id);
                handleNavigate('dashboard');
              }}
              onSelectForReport={(id) => {
                setSelectedExperimentId(id);
                handleNavigate('reports');
              }}
              onRefresh={refreshAll}
            />
          )}

          {activeTab === 'reports' && (
            <ReportsPage
              experiments={experiments}
              selectedExperimentId={selectedExperimentId}
              onSelectExperiment={setSelectedExperimentId}
            />
          )}

          {activeTab === 'audit' && <AuditPage />}
        </main>
      </div>
    </div>
  );
}
