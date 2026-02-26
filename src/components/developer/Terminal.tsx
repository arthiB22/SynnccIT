import { useState, useRef, useEffect } from 'react';
import { Maximize2, Minimize2, Trash2, Monitor, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TerminalOutput } from '@/types/api';

interface TerminalProps {
  className?: string;
  onExpand?: () => void;
  isExpanded?: boolean;
}

const stripAnsi = (str: string) => {
  // Catch standard CSI codes, including [?2004h etc.
  return str.replace(/[\u001b\u009b][[()#;?]*[0-9;?]*[a-zA-Z]/g, '');
};

export function Terminal({ className, onExpand, isExpanded }: TerminalProps) {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<TerminalOutput[]>([]);
  const [lastPrompt, setLastPrompt] = useState('❯');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const rawData = event.data;
      // Normalize carriage returns and ensure newlines are clean
      const normalizedData = rawData.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const cleanData = stripAnsi(normalizedData);

      if (!cleanData) return;

      // Extract prompt
      const lines = cleanData.split('\n');
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine.match(/[%$#❯]$/)) {
        setLastPrompt(lastLine || '❯');
      }

      setHistory(prev => {
        const last = prev[prev.length - 1];
        if (last && last.type === 'output') {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + cleanData }
          ];
        }
        return [...prev, {
          id: Math.random().toString(36).substr(2, 9),
          type: 'output',
          content: cleanData,
          timestamp: new Date().toISOString()
        }];
      });
    };

    ws.onclose = (event) => {
      if (!event.wasClean) {
        setHistory(prev => [...prev, {
          id: 'ws-close',
          type: 'error',
          content: '\r\n[DISCONNECTED] Terminal connection lost.\r\n',
          timestamp: new Date().toISOString()
        }]);
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  // Handle auto-expanding textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [command]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim() || !wsRef.current) return;

    const cmd = command + '\n';
    wsRef.current.send(cmd);
    setCommand('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const clearTerminal = () => {
    setHistory([]);
  };

  const openSystemTerminal = () => {
    fetch('/api/open-terminal', { method: 'POST' });
  };

  return (
    <div className={cn('h-full flex flex-col bg-[#0b0c10] font-mono text-slate-300', className)}>
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-white/5">
        <div className="flex items-center gap-2">
          <Monitor className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-tighter">System Shell</span>
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
            title="Open Native Terminal"
          >
            <ExternalLink className="h-3 w-3 text-slate-400" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-white/10" onClick={clearTerminal}>
            <Trash2 className="h-3 w-3 text-slate-400" />
          </Button>
        </div>
      </div>

      {/* Terminal Output */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-0.5 selection:bg-primary/30">
        {history.length === 0 ? (
          <div className="text-slate-600 italic text-[11px]">
            {lastPrompt}
          </div>
        ) : (
          history.map((line) => (
            <div
              key={line.id}
              className={cn(
                'whitespace-pre-wrap break-words text-[12px] leading-relaxed',
                line.type === 'error' ? 'text-rose-400' : 'text-slate-300'
              )}
            >
              {line.content}
            </div>
          ))
        )}
      </div>

      {/* Command Input Area */}
      <div className="p-3 bg-white/5 border-t border-white/5">
        <div className="flex items-start gap-2">
          <span className="text-emerald-500 font-bold text-xs mt-0.5 shrink-0 whitespace-nowrap">{lastPrompt}</span>
          <textarea
            ref={textareaRef}
            rows={1}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type command..."
            className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder:text-slate-600 resize-none py-0.5 min-h-[1.5rem] max-h-[200px]"
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

