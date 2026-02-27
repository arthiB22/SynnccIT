import { useRef, useEffect, useState } from 'react';
import { Maximize2, Minimize2, Trash2, ExternalLink, Terminal as TerminalIcon, WifiOff, Sparkles } from 'lucide-react';
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
const BACKEND_URL = IS_LOCAL ? '' : '';

export function Terminal({ className, onExpand, isExpanded }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!IS_LOCAL) return; // Don't try to connect on Vercel

    // Initialize xterm.js
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

    // Connect WebSocket — use same host so Vite proxy handles it
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onclose = () => {
      setConnected(false);
      term.write('\r\n\x1b[31m[DISCONNECTED] Terminal connection lost. Make sure the local backend is running.\x1b[0m\r\n');
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[33m[ERROR] Could not connect to backend terminal. Is the server running on port 8000?\x1b[0m\r\n');
    };

    // Handle user input
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize events
    term.onResize((size) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      ws.close();
      term.dispose();
    };
  }, []);

  // Sync fit when container size changes (e.g. expand/collapse)
  useEffect(() => {
    const timer = setTimeout(() => {
      fitAddonRef.current?.fit();
    }, 300);
    return () => clearTimeout(timer);
  }, [isExpanded]);

  const clearTerminal = () => {
    xtermRef.current?.clear();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: '\x0c' }));
    }
  };

  const openSystemTerminal = () => {
    if (IS_LOCAL) {
      fetch(`${BACKEND_URL}/api/open-terminal`, { method: 'POST' })
        .catch(() => alert('Could not reach local backend.'));
    } else {
      alert('Opening a native terminal is only available when running locally.');
    }
  };

  return (
    <div className={cn('h-full flex flex-col bg-[#0b0c10] overflow-hidden', className)}>
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-white/5 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-tighter">
            {IS_LOCAL ? 'System Shell (PTY)' : 'Terminal (Cloud Mode)'}
          </span>
          {IS_LOCAL && (
            <span className={cn(
              'text-[9px] px-1.5 py-0.5 rounded-full font-medium',
              connected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
            )}>
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {/* AI Terminal button — placeholder for future integration */}
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
            {isExpanded ? <Minimize2 className="h-3 w-3 text-slate-400" /> : <Maximize2 className="h-3 w-3 text-slate-400" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-white/10"
            onClick={openSystemTerminal}
            title={IS_LOCAL ? 'Open Native Terminal' : 'Native terminal (local only)'}
          >
            <ExternalLink className="h-3.5 w-3.5 text-slate-400 hover:text-foreground" />
          </Button>
          {IS_LOCAL && (
            <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-white/10" onClick={clearTerminal} title="Clear Terminal">
              <Trash2 className="h-3.5 w-3.5 text-slate-400 hover:text-foreground" />
            </Button>
          )}
        </div>
      </div>

      {/* Terminal Container */}
      {IS_LOCAL ? (
        <div className="flex-1 p-2 overflow-hidden relative">
          <div ref={terminalRef} className="h-full w-full" />
        </div>
      ) : (
        // Cloud / Vercel deployment — show informative message
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <WifiOff className="h-8 w-8 text-slate-600" />
          <div>
            <p className="text-sm font-medium text-slate-400 mb-1">Terminal unavailable in cloud mode</p>
            <p className="text-xs text-slate-600 max-w-xs">
              The embedded terminal requires the local Python backend (port 8000) to be running.
              Deploy the app locally or use your system terminal.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
