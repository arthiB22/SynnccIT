import { useState, useEffect, useRef } from 'react';
import {
  Play,
  Sparkles,
  FileCode,
  Zap,
  Layers,
  Palette,
  ChevronLeft,
  ChevronRight,
  Save,
  X,
  Maximize2,
  Minimize2,
  Bot,
  Loader2,
  Gauge,
  TrendingUp,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileExplorer } from '@/components/developer/FileExplorer';
import { CodeEditor } from '@/components/developer/CodeEditor';
import { FileNode, OpenFile } from '@/types/api';

const TESTING_API = '/testing-api';

const actionButtons = [
  { id: 'quick-test', label: 'Run Quick Tests', icon: Play, description: 'AI reviews code and gives crisp feedback' },
  { id: 'generate-tests', label: 'Generate Test Cases', icon: Sparkles, description: 'Create artificial data for variable testing' },
  { id: 'code-explain', label: 'Code Explanation', icon: FileCode, description: 'Highlight code to decipher it' },
  { id: 'simulate', label: 'Simulate Runs', icon: Zap, description: 'Place values and check performance' },
  { id: 'reduce-complexity', label: 'Reduce Complexity', icon: Layers, description: 'Suggestions to reduce space/time complexity' },
  { id: 'redesign', label: 'Re-Design', icon: Palette, description: 'Implement code as per user needs' },
];

export default function TestingPage() {
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // AI State
  const [selectedAction, setSelectedAction] = useState<string | null>(null);
  const [aiOutput, setAiOutput] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [userInput, setUserInput] = useState('');
  const [metrics, setMetrics] = useState({ efficiency: 0, scalability: 0 });
  const outputRef = useRef<HTMLDivElement>(null);

  // --- File Management (reuses DeveloperPage backend via proxy) ---
  const handleFileSelect = async (file: FileNode) => {
    if (file.type === 'folder') return;
    const existing = openFiles.find(f => f.path === file.path);
    if (existing) {
      setActiveFileId(existing.id);
    } else {
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`);
        const data = await res.json();
        const newFile: OpenFile = {
          id: Date.now().toString(),
          name: file.name,
          path: file.path,
          content: data.content || '',
          language: file.language || 'python',
          isModified: false,
        };
        setOpenFiles([...openFiles, newFile]);
        setActiveFileId(newFile.id);
      } catch (err) {
        console.error('Failed to load file:', err);
      }
    }
    setSelectedPath(file.path);
  };

  const handleFileSave = async (file: OpenFile) => {
    try {
      const res = await fetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: file.content }),
      });
      if (res.ok) {
        setOpenFiles(prev => prev.map(f =>
          f.id === file.id ? { ...f, isModified: false } : f
        ));
      }
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  };

  // Autosave (1s debounce)
  useEffect(() => {
    const activeFile = openFiles.find(f => f.id === activeFileId);
    if (!activeFile || !activeFile.isModified) return;
    const t = setTimeout(() => handleFileSave(activeFile), 1000);
    return () => clearTimeout(t);
  }, [activeFileId, openFiles]);

  // Keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const activeFile = openFiles.find(f => f.id === activeFileId);
        if (activeFile) handleFileSave(activeFile);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFileId, openFiles]);

  // Load files
  const loadFiles = async (path: string = '.') => {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.children ? data.children : [data]);
      }
    } catch (err) {
      console.error('Failed to load files:', err);
    }
  };

  const handleChangeWorkspace = async () => {
    try {
      const selectRes = await fetch('/api/select-workspace-folder', { method: 'POST' });
      const selectData = await selectRes.json();
      const path = selectData.path;
      if (!path) return;
      setOpenFiles([]);
      setActiveFileId(null);
      setSelectedPath(null);
      loadFiles(path);
    } catch (err) {
      console.error('Failed to change workspace:', err);
    }
  };

  useEffect(() => { loadFiles(); }, []);

  const handleFileClose = (fileId: string) => {
    const newFiles = openFiles.filter(f => f.id !== fileId);
    setOpenFiles(newFiles);
    if (activeFileId === fileId) {
      setActiveFileId(newFiles.length > 0 ? newFiles[newFiles.length - 1].id : null);
    }
  };

  const handleCloseAllFiles = () => {
    if (openFiles.some(f => f.isModified)) {
      if (!confirm('You have unsaved changes. Close all?')) return;
    }
    setOpenFiles([]);
    setActiveFileId(null);
  };

  // --- Get active file code ---
  const getActiveCode = () => {
    const activeFile = openFiles.find(f => f.id === activeFileId);
    return activeFile?.content || '';
  };

  const getSelectedText = () => {
    const selection = window.getSelection();
    return selection?.toString() || '';
  };

  // --- AI Action Handlers ---
  const handleAction = async (actionId: string) => {
    setSelectedAction(actionId);
    const code = getActiveCode();
    if (!code && actionId !== 'redesign') {
      setAiOutput('⚠️ No file is open. Please select a file first.');
      return;
    }

    // For simulate and redesign without user input, show prompt first time
    if (actionId === 'simulate' && !userInput.trim()) {
      setAiLoading(true);
      setAiOutput('');
      try {
        const res = await fetch(`${TESTING_API}/api/ai/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, language: 'python' }),
        });
        const data = await res.json();
        setAiOutput(data.result);
      } catch (err: any) {
        setAiOutput(`❌ Connection error: ${err.message}\n\nMake sure the Testing backend is running on port 8001.`);
      } finally {
        setAiLoading(false);
      }
      return;
    }

    if (actionId === 'redesign' && !userInput.trim()) {
      setAiOutput(`🎨 Re-Design Mode\n\nDescribe how you want the code to be restructured:\n\nExamples:\n• "Convert to object-oriented design"\n• "Split into separate functions"\n• "Add error handling and validation"\n• "Make async/concurrent"\n\nType your requirements below and click Send.`);
      return;
    }

    setAiLoading(true);
    setAiOutput('');

    try {
      const selectedText = getSelectedText();
      const body: any = {
        code,
        language: 'python',
        selected_text: selectedText || undefined,
        user_input: userInput || undefined,
      };

      // Map action IDs to API endpoints
      const endpointMap: Record<string, string> = {
        'quick-test': '/api/ai/quick-test',
        'generate-tests': '/api/ai/generate-tests',
        'code-explain': '/api/ai/code-explain',
        'simulate': '/api/ai/simulate',
        'reduce-complexity': '/api/ai/reduce-complexity',
        'redesign': '/api/ai/redesign',
      };

      const endpoint = endpointMap[actionId];
      if (!endpoint) {
        setAiOutput('❌ Unknown action.');
        setAiLoading(false);
        return;
      }

      const res = await fetch(`${TESTING_API}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      // Display main result
      let output = data.result || 'No response from AI.';

      // Append test results if available
      if (data.test_results && data.test_results.length > 0) {
        const passed = data.test_results.filter((r: any) => r.passed).length;
        const total = data.test_results.length;
        output += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        output += `📊 Execution Results: ${passed}/${total} passed\n\n`;
        data.test_results.forEach((r: any, i: number) => {
          output += `Test ${i + 1}: ${r.passed ? '✅ PASS' : '❌ FAIL'}`;
          output += ` | Input: ${r.input || '(none)'}`;
          output += ` | Output: ${r.actual}\n`;
        });
      }

      setAiOutput(output);

      // Update metrics if returned
      if (data.metrics) {
        setMetrics(m => ({
          efficiency: data.metrics.efficiency ?? m.efficiency,
          scalability: data.metrics.scalability ?? m.scalability,
        }));
      }

    } catch (err: any) {
      setAiOutput(`❌ Connection error: ${err.message}\n\nMake sure the Testing backend is running on port 8001.`);
    } finally {
      setAiLoading(false);
    }
  };


  // Scroll AI output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [aiOutput]);

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - File Explorer */}
        <div
          className={cn(
            'relative bg-card border-r border-border transition-all duration-300 overflow-hidden flex flex-col',
            leftPanelOpen ? 'w-56' : 'w-0'
          )}
        >
          <FileExplorer
            onFileSelect={handleFileSelect}
            selectedPath={selectedPath}
            files={files}
            onRefresh={loadFiles}
            onFileUpload={async (file) => {
              const formData = new FormData();
              formData.append('file', file);
              await fetch('/api/upload', { method: 'POST', body: formData });
              loadFiles();
            }}
            onWorkspaceChange={handleChangeWorkspace}
          />
        </div>

        {/* Left Panel Toggle */}
        <button
          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
          className="w-5 flex items-center justify-center bg-secondary/30 border-r border-border hover:bg-secondary/50 transition-colors"
        >
          {leftPanelOpen ? <ChevronLeft className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>

        {/* Center - Code Editor & AI Output */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Open Files Header */}
          <div className="h-8 bg-secondary/20 border-b border-border flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Open Files</span>
              {openFiles.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-red-400"
                  onClick={handleCloseAllFiles}
                  title="Close All Files"
                >
                  <X className="h-3 w-3 mr-1" />
                  Close All
                </Button>
              )}
            </div>
            {activeFileId && openFiles.find(f => f.id === activeFileId)?.isModified && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-primary animate-pulse">Syncing...</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] gap-1 px-2 hover:bg-primary/20"
                  onClick={() => {
                    const activeFile = openFiles.find(f => f.id === activeFileId);
                    if (activeFile) handleFileSave(activeFile);
                  }}
                >
                  <Save className="h-3 w-3" />
                  Save Now
                </Button>
              </div>
            )}
          </div>

          {/* Code Editor */}
          <div className={cn('flex-1 overflow-hidden', outputExpanded && 'hidden')}>
            <CodeEditor
              openFiles={openFiles}
              activeFileId={activeFileId}
              onFileClose={handleFileClose}
              onFileSelect={setActiveFileId}
              onContentChange={(fileId, newContent) => {
                setOpenFiles(prev => prev.map(f =>
                  f.id === fileId ? { ...f, content: newContent, isModified: true } : f
                ));
              }}
            />
          </div>

          {/* AI Output Panel (replacing Terminal) */}
          <div
            className={cn(
              'border-t border-border transition-all duration-300',
              outputExpanded ? 'flex-1' : 'h-48'
            )}
          >
            <div className="h-full flex flex-col bg-[#0b0c10] font-mono text-slate-300">
              {/* Output Header */}
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-white/5">
                <div className="flex items-center gap-2">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[11px] font-medium text-slate-400 uppercase tracking-tighter">
                    AI Output {selectedAction && `— ${actionButtons.find(a => a.id === selectedAction)?.label}`}
                  </span>
                  {aiLoading && <Loader2 className="h-3 w-3 text-primary animate-spin" />}
                </div>
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 hover:bg-white/10"
                    onClick={() => setOutputExpanded(!outputExpanded)}
                    title={outputExpanded ? 'Collapse' : 'Expand'}
                  >
                    {outputExpanded ? <Minimize2 className="h-3 w-3 text-slate-400" /> : <Maximize2 className="h-3 w-3 text-slate-400" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 hover:bg-white/10"
                    onClick={() => setAiOutput('')}
                    title="Clear"
                  >
                    <X className="h-3 w-3 text-slate-400" />
                  </Button>
                </div>
              </div>

              {/* Output Content */}
              <div ref={outputRef} className="flex-1 overflow-auto p-4 selection:bg-primary/30">
                {aiLoading ? (
                  <div className="flex items-center gap-2 text-primary text-[12px]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Analyzing code...</span>
                  </div>
                ) : aiOutput ? (
                  <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-300">
                    {aiOutput}
                  </div>
                ) : (
                  <div className="text-slate-600 italic text-[11px]">
                    Select an action from the right panel to analyze your code.
                  </div>
                )}
              </div>

              {/* Input area for Simulate Runs and Re-Design */}
              {(selectedAction === 'simulate' || selectedAction === 'redesign') && (
                <div className="p-3 bg-white/5 border-t border-white/5">
                  <div className="flex items-start gap-2">
                    <textarea
                      rows={2}
                      value={userInput}
                      onChange={(e) => setUserInput(e.target.value)}
                      placeholder={
                        selectedAction === 'simulate'
                          ? 'Enter input values (one per line)...'
                          : 'Describe your redesign needs...'
                      }
                      className="flex-1 bg-transparent border border-white/10 rounded p-2 outline-none text-xs text-white placeholder:text-slate-600 resize-none min-h-[2.5rem] max-h-[120px]"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleAction(selectedAction);
                        }
                      }}
                    />
                    <Button
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => handleAction(selectedAction)}
                      disabled={aiLoading}
                    >
                      <Send className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel Toggle */}
        <button
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          className="w-5 flex items-center justify-center bg-secondary/30 border-l border-border hover:bg-secondary/50 transition-colors"
        >
          {rightPanelOpen ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronLeft className="h-4 w-4 text-muted-foreground" />}
        </button>

        {/* Right Panel - AI Commands + Metrics */}
        <div
          className={cn(
            'bg-card border-l border-border transition-all duration-300 overflow-hidden flex flex-col',
            rightPanelOpen ? 'w-72' : 'w-0'
          )}
        >
          {/* AI Actions */}
          <div className="ide-panel-header">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              <span className="ide-panel-title">AI Testing Agent</span>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-3">
            <div className="space-y-1.5">
              {actionButtons.map((action) => {
                const Icon = action.icon;
                const isActive = selectedAction === action.id;
                return (
                  <button
                    key={action.id}
                    onClick={() => handleAction(action.id)}
                    disabled={aiLoading}
                    className={cn(
                      'w-full flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-all duration-200 group border',
                      isActive
                        ? 'bg-primary/15 border-primary/30 text-foreground'
                        : 'bg-transparent border-transparent hover:bg-secondary/50 hover:border-border text-muted-foreground hover:text-foreground',
                      aiLoading && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <div className={cn(
                      'mt-0.5 p-1.5 rounded-md transition-colors',
                      isActive ? 'bg-primary/20 text-primary' : 'bg-secondary/50 text-muted-foreground group-hover:text-foreground'
                    )}>
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-semibold leading-tight">{action.label}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{action.description}</div>
                    </div>
                    {isActive && aiLoading && (
                      <Loader2 className="h-3 w-3 text-primary animate-spin mt-1 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Performance Metrics (at bottom of agent area) */}
          <div className="p-3 border-t border-border space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Performance</span>
            </div>

            {/* Efficiency Score */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Gauge className="h-3 w-3 text-emerald-400" />
                  <span className="text-[10px] font-medium text-muted-foreground">Efficiency</span>
                </div>
                <span className={cn(
                  'text-[11px] font-bold tabular-nums',
                  metrics.efficiency >= 70 ? 'text-emerald-400' : metrics.efficiency >= 40 ? 'text-amber-400' : 'text-rose-400'
                )}>
                  {metrics.efficiency}%
                </span>
              </div>
              <div className="h-1.5 bg-secondary/50 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-700 ease-out',
                    metrics.efficiency >= 70 ? 'bg-emerald-500' : metrics.efficiency >= 40 ? 'bg-amber-500' : 'bg-rose-500'
                  )}
                  style={{ width: `${metrics.efficiency}%` }}
                />
              </div>
            </div>

            {/* Scalability Score */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="h-3 w-3 text-blue-400" />
                  <span className="text-[10px] font-medium text-muted-foreground">Scalability</span>
                </div>
                <span className={cn(
                  'text-[11px] font-bold tabular-nums',
                  metrics.scalability >= 70 ? 'text-blue-400' : metrics.scalability >= 40 ? 'text-amber-400' : 'text-rose-400'
                )}>
                  {metrics.scalability}%
                </span>
              </div>
              <div className="h-1.5 bg-secondary/50 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-700 ease-out',
                    metrics.scalability >= 70 ? 'bg-blue-500' : metrics.scalability >= 40 ? 'bg-amber-500' : 'bg-rose-500'
                  )}
                  style={{ width: `${metrics.scalability}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
