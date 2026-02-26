import { useRef, useEffect } from 'react';
import { Maximize2, Minimize2, Trash2, Monitor, ExternalLink, Terminal as TerminalIcon } from 'lucide-react';
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

export function Terminal({ className, onExpand, isExpanded }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Initialize xterm.js
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0b0c10',
        foreground: '#cbd5e1', // slate-300
        cursor: '#10b981',     // emerald-500
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

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[31m[DISCONNECTED] Terminal connection lost.\x1b[0m\r\n');
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

    const handleResize = () => {
      fitAddon.fit();
    };
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
    }, 300); // Wait for transition
    return () => clearTimeout(timer);
  }, [isExpanded]);

  const clearTerminal = () => {
    xtermRef.current?.clear();
    // Also send a clear command to the shell if needed, 
    // but typically .clear() is enough for the UI.
    // We could send '\f' (form feed) to the shell:
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: '\x0c' })); // Ctrl+L (Clear)
    }
  };

  const openSystemTerminal = () => {
    fetch('/api/open-terminal', { method: 'POST' });
  };

  return (
    <div className={cn('h-full flex flex-col bg-[#0b0c10] overflow-hidden', className)}>
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-white/5 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-tighter">System Shell (PTY)</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-white/10"
            onClick={onExpand}
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? <Minimize2 className="h-3 w-3 text-slate-400" /> : <Maximize2 className="h-3 w-3 text-slate-400" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-white/10"
            onClick={openSystemTerminal}
            title="Open Native Terminal from Finder"
          >
            <ExternalLink className="h-3 w-3 text-slate-400" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-white/10" onClick={clearTerminal}>
            <Trash2 className="h-3 w-3 text-slate-400" />
          </Button>
        </div>
      </div>

      {/* Terminal Container */}
      <div className="flex-1 p-2 overflow-hidden relative">
        <div ref={terminalRef} className="h-full w-full" />
      </div>
    </div>
  );
}
