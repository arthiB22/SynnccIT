import { useState, useEffect } from 'react';
import { Maximize2, Minimize2, ChevronLeft, ChevronRight, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileExplorer } from '@/components/developer/FileExplorer';
import { CodeEditor } from '@/components/developer/CodeEditor';
import { Terminal } from '@/components/developer/Terminal';
import { AgentSidePanel } from '@/components/developer/AgentSidePanel';
import { FileNode, OpenFile } from '@/types/api';

export default function DeveloperPage() {
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // Fetch file content from backend and open in editor
  const handleFileSelect = async (file: FileNode) => {
    if (file.type === 'folder') return;

    const existing = openFiles.find(f => f.path === file.path);
    if (existing) {
      setActiveFileId(existing.id);
    } else {
      // Fetch file content from backend API
      const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`);
      const data = await res.json();
      const newFile: OpenFile = {
        id: Date.now().toString(),
        name: file.name,
        path: file.path,
        content: data.content || '',
        language: file.language || 'typescript',
        isModified: false,
      };
      setOpenFiles([...openFiles, newFile]);
      setActiveFileId(newFile.id);
    }
    setSelectedPath(file.path);
  };

  // Save file to backend
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

  // Autosave effect (1s debounce)
  useEffect(() => {
    const activeFile = openFiles.find(f => f.id === activeFileId);
    if (!activeFile || !activeFile.isModified) return;

    const timeoutId = setTimeout(() => {
      handleFileSave(activeFile);
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [activeFileId, openFiles]);

  // Keyboard shortcut for saving
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const activeFile = openFiles.find(f => f.id === activeFileId);
        if (activeFile) {
          handleFileSave(activeFile);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFileId, openFiles]);

  // Fetch file tree
  const loadFiles = async (path: string = '.') => {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.children ? data.children : [data]);
      }
    } catch (err) {
      console.error("Failed to load files:", err);
    }
  };

  // Real-time File System Sync
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/fs`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'refresh') {
        console.log("File system change detected, refreshing...", data.changes);
        loadFiles();
      }
    };

    return () => ws.close();
  }, []);

  // Handle workspace change
  const handleChangeWorkspace = async () => {
    try {
      const selectRes = await fetch('/api/select-workspace-folder', { method: 'POST' });
      const selectData = await selectRes.json();

      const path = selectData.path;
      if (!path) return;

      setOpenFiles([]); // Close all files
      setActiveFileId(null);
      setSelectedPath(null);
      loadFiles(path);
    } catch (err) {
      console.error("Failed to change workspace:", err);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const handleFileClose = (fileId: string) => {
    const newFiles = openFiles.filter(f => f.id !== fileId);
    setOpenFiles(newFiles);
    if (activeFileId === fileId) {
      setActiveFileId(newFiles.length > 0 ? newFiles[newFiles.length - 1].id : null);
    }
  };

  const handleCloseAllFiles = () => {
    if (openFiles.some(f => f.isModified)) {
      if (!confirm("You have unsaved changes. Are you sure you want to close all?")) return;
    }
    setOpenFiles([]);
    setActiveFileId(null);
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - File Explorer (Collapsible) */}
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
          {leftPanelOpen ? (
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {/* Center - Code Editor & Terminal */}
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

          {/* Code Display Window */}
          <div className={cn('flex-1 overflow-hidden', terminalExpanded && 'hidden')}>
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

          {/* Terminal */}
          <div
            className={cn(
              'border-t border-border transition-all duration-300',
              terminalExpanded ? 'flex-1' : 'h-48'
            )}
          >
            <div className="h-full relative">
              <Terminal
                onExpand={() => setTerminalExpanded(!terminalExpanded)}
                isExpanded={terminalExpanded}
              />
            </div>
          </div>
        </div>

        {/* Right Panel Toggle */}
        <button
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          className="w-5 flex items-center justify-center bg-secondary/30 border-l border-border hover:bg-secondary/50 transition-colors"
        >
          {rightPanelOpen ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {/* Right Panel - Current Working Agent */}
        <div
          className={cn(
            'bg-card border-l border-border transition-all duration-300 overflow-hidden',
            rightPanelOpen ? 'w-72' : 'w-0'
          )}
        >
          <AgentSidePanel />
        </div>
      </div>
    </div>
  );
}
