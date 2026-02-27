import { useRef, useEffect, useState, useCallback } from 'react';
import {
  Maximize2,
  Minimize2,
  Trash2,
  ExternalLink,
  Terminal as TerminalIcon,
  Sparkles,
  Send,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  className?: string;
  onExpand?: () => void;
  isExpanded?: boolean;
}

const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// ─── Cloud Terminal (HTTP-based, works on Vercel) ─────────────────────────────

function CloudTerminal({ isExpanded }: { isExpanded?: boolean }) {
  const [lines, setLines] = useState<{ text: string; type: 'cmd' | 'out' | 'err' | 'info' }[]>([
    { text: '☁️  Cloud Terminal — commands run on the Vercel server.', type: 'info' },
    { text: 'ℹ️  Note: Interactive programs (vim, top) are not supported.', type: 'info' },
    { text: '', type: 'info' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [cwd, setCwd] = useState('/tmp');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const runCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim()) return;
    setLines(prev => [...prev, { text: `${cwd} $ ${cmd}`, type: 'cmd' }]);
    setInput('');
    setLoading(true);

    // Handle `clear` locally
    if (cmd.trim() === 'clear') {
      setLines([]);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setLines(prev => [...prev, { text: errData.error || `HTTP ${res.status}`, type: 'err' }]);
        setLoading(false);
        return;
      }

      const data = await res.json();
      const newLines: typeof lines = [];

      if (data.output) {
        data.output.replace(/\r\n/g, '\n').split('\n').forEach((l: string) => {
          newLines.push({ text: l, type: 'out' });
        });
      }
      if (data.error) {
        data.error.replace(/\r\n/g, '\n').split('\n').forEach((l: string) => {
          if (l.trim()) newLines.push({ text: l, type: 'err' });
        });
      }
      if (!data.output && !data.error) {
        // Silent success (e.g. cd, export, etc.)
      }

      // Update cwd if server resolved a cd
      if (data.newCwd && data.newCwd !== cwd) {
        setCwd(data.newCwd);
      }

      setLines(prev => [...prev, ...newLines]);
    } catch (err: any) {
      setLines(prev => [
        ...prev,
        { text: `❌ ${err.message} — make sure the deployment is up to date.`, type: 'err' },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [cwd]);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runCommand(input);
  };

  return (
    <div className="h-full flex flex-col bg-[#0b0c10] font-mono text-xs">
      {/* Output area */}
      <div className="flex-1 overflow-auto p-3 space-y-0.5">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'leading-snug whitespace-pre-wrap break-all',
              line.type === 'cmd' && 'text-emerald-400',
              line.type === 'out' && 'text-slate-300',
              line.type === 'err' && 'text-red-400',
              line.type === 'info' && 'text-slate-500 italic',
            )}
          >
            {line.text}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-slate-500">running…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div className="border-t border-white/5 flex items-center px-3 py-2 gap-2">
        <span className="text-emerald-400 shrink-0">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={loading}
          placeholder="Enter command…"
          autoFocus
          className="flex-1 bg-transparent outline-none text-slate-200 placeholder:text-slate-600 text-xs"
        />
        <button
          onClick={() => runCommand(input)}
          disabled={loading || !input.trim()}
          className="text-slate-500 hover:text-primary disabled:opacity-30 transition-colors"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Local PTY Terminal (WebSocket, runs natively) ────────────────────────────

function LocalTerminal({ isExpanded, onExpand }: { isExpanded?: boolean; onExpand?: () => void }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0b0c10',
        foreground: '#cbd5e1',
        cursor: '#10b981',
        selectionBackground: 'rgba(16, 185, 129, 0.3)',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    if (terminalRef.current) {
      term.open(terminalRef.current);
      fitAddon.fit();
    }

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => term.write(event.data);
    ws.onclose = () => {
      setConnected(false);
      term.write('\r\n\x1b[31m[DISCONNECTED] Terminal connection lost. Make sure the local backend is running.\x1b[0m\r\n');
    };
    ws.onerror = () => {
      term.write('\r\n\x1b[33m[ERROR] Could not connect. Is the backend running on port 8000?\x1b[0m\r\n');
    };

    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    term.onResize((size: { cols: number; rows: number }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    });

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      ws.close();
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fitAddonRef.current?.fit(), 300);
    return () => clearTimeout(t);
  }, [isExpanded]);

  const clearTerminal = () => {
    xtermRef.current?.clear();
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'input', data: '\x0c' }));
  };

  const openSystemTerminal = () => {
    fetch('/api/open-terminal', { method: 'POST' })
      .catch(() => alert('Could not reach local backend.'));
  };

  return (
    <div className="h-full flex flex-col bg-[#0b0c10] overflow-hidden">
      {/* Local terminal sub-header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-white/[0.03] shrink-0">
        <span className={cn(
          'text-[9px] px-1.5 py-0.5 rounded-full font-medium',
          connected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
        )}>
          {connected ? 'LIVE' : 'CONNECTING…'}
        </span>
        <span className="flex-1" />
        <button onClick={openSystemTerminal} title="Open Native Terminal" className="text-slate-500 hover:text-slate-300 transition-colors">
          <ExternalLink className="h-3 w-3" />
        </button>
        <button onClick={clearTerminal} title="Clear" className="text-slate-500 hover:text-slate-300 transition-colors">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 p-2 overflow-hidden">
        <div ref={terminalRef} className="h-full w-full" />
      </div>
    </div>
  );
}

// ─── Unified Terminal Wrapper ─────────────────────────────────────────────────

export function Terminal({ className, onExpand, isExpanded }: TerminalProps) {
  return (
    <div className={cn('h-full flex flex-col bg-[#0b0c10] overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-white/5 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-tighter">
            {IS_LOCAL ? 'System Shell (PTY)' : 'Cloud Terminal'}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {/* AI Terminal placeholder */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-white/10 group"
            title="AI Terminal Assistant (Coming Soon)"
            onClick={() => { }}
          >
            <Sparkles className="h-3 w-3 text-primary/40 group-hover:text-primary transition-colors" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-white/10"
            onClick={onExpand}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded
              ? <Minimize2 className="h-3 w-3 text-slate-400" />
              : <Maximize2 className="h-3 w-3 text-slate-400" />}
          </Button>
        </div>
      </div>

      {/* Body — PTY locally, HTTP runner on Vercel */}
      <div className="flex-1 overflow-hidden">
        {IS_LOCAL
          ? <LocalTerminal isExpanded={isExpanded} onExpand={onExpand} />
          : <CloudTerminal isExpanded={isExpanded} />}
      </div>
    </div>
  );
}
