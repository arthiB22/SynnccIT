import os
import json
import asyncio
import asyncio.subprocess
import platform
from fastapi import FastAPI, Request, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

# Load common environment from root
env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../.env'))
load_dotenv(env_path)
import subprocess
from typing import List, Optional, Dict
from watchfiles import awatch

# ─── System Detection ────────────────────────────────────────────────────────
SYSTEM = platform.system()          # 'Windows', 'Linux', 'Darwin'
IS_WINDOWS = SYSTEM == 'Windows'

# PTY is only available on Unix/macOS
try:
    import pty, fcntl, termios, struct, select
    HAS_PTY = True
except ImportError:
    HAS_PTY = False

if IS_WINDOWS:
    SHELL = ['cmd.exe']
    SHELL_NAME = 'cmd.exe'
elif os.path.exists('/bin/zsh'):
    SHELL = ['/bin/zsh']
    SHELL_NAME = 'zsh'
else:
    SHELL = ['/bin/bash']
    SHELL_NAME = 'bash'

# Try to import google.generativeai, handle if missing
try:
    import google.generativeai as genai
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

class FileSaveRequest(BaseModel):
    path: str
    content: str

class TerminalRequest(BaseModel):
    command: str

class AgentRequest(BaseModel):
    prompt: str

app = FastAPI()

# Allow CORS for frontend dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Unified Backend Integration ---
import sys
from pathlib import Path

# Add TestingPage_Backend and AgentPage_Backend to path
testing_backend_path = Path(__file__).resolve().parent.parent / "TestingPage_Backend"
agent_backend_path = Path(__file__).resolve().parent.parent / "AgentPage_Backend"

if str(testing_backend_path) not in sys.path:
    sys.path.insert(0, str(testing_backend_path))
if str(agent_backend_path) not in sys.path:
    sys.path.insert(0, str(agent_backend_path))

# Import Routers
try:
    from routers.testcase_router import testcase_router
    from routers.simulation_router import simulation_router
    from routers.flowchart_router import flowchart_router
    from routers.ai_router import ai_router
    
    # Include testing routers
    app.include_router(testcase_router, prefix="/api/testcases", tags=["Test Cases"])
    app.include_router(simulation_router, prefix="/api/simulation", tags=["Simulation"])
    app.include_router(flowchart_router, prefix="/api/flowchart", tags=["Flowchart"])
    app.include_router(ai_router, prefix="/api/ai", tags=["AI Features"])
    
    HAS_TESTING_BACKEND = True
    logger.info("Successfully merged TestingPage routers.")
except ImportError as e:
    logger.error(f"Failed to import TestingPage routers: {e}")
    HAS_TESTING_BACKEND = False

try:
    from router import agent_router as agent_page_router
    app.include_router(agent_page_router, prefix="/api/agent-standalone", tags=["Agent Page"])
    logger.info("Successfully merged AgentPage router.")
except ImportError as e:
    logger.error(f"Failed to import AgentPage router: {e}")

# Global state
CURRENT_DIR = os.getcwd()

# Configure GenAI
model = None
if HAS_GENAI:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    model_name = os.getenv("GEMINI_MODEL") or os.getenv("GOOGLE_MODEL") or "gemini-1.5-flash"
    
    if api_key and not api_key.startswith("YOUR_"):
        try:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)
            logger.info(f"GenAI configured with model: {model_name}")
        except Exception as e:
            logger.error(f"Failed to configure GenAI: {e}")
    else:
        logger.warning("No valid Google/Gemini API Key found. AI Agent will be disabled.")


# ─── Cross-Platform Terminal WebSocket ───────────────────────────────────────

@app.websocket("/ws/terminal")
async def terminal_websocket(websocket: WebSocket):
    """Bidirectional WebSocket terminal.

    • Windows  → spawns cmd.exe with asyncio subprocess + piped I/O
    • Unix/Mac → spawns bash/zsh via PTY for proper TTY support

    Message protocol (JSON):
      client → server  { type: 'input',  data: '<chars>' }
      client → server  { type: 'resize', rows: N, cols: N }
      server → client  raw text / ANSI sequences
    """
    global CURRENT_DIR
    await websocket.accept()
    logger.info(f"Terminal WS connected | system={SYSTEM} | shell={SHELL_NAME} | cwd={CURRENT_DIR}")

    # Send a welcome banner so the user knows what shell they got
    await websocket.send_text(
        f"\r\n\x1b[32m[SynnccIT Terminal]\x1b[0m "
        f"\x1b[90m{SYSTEM} · {SHELL_NAME}\x1b[0m\r\n"
    )

    if IS_WINDOWS:
        await _run_windows_terminal(websocket)
    elif HAS_PTY:
        await _run_pty_terminal(websocket)
    else:
        await _run_pipe_terminal(websocket)


async def _run_windows_terminal(websocket: WebSocket):
    """Windows terminal using asyncio subprocess with piped stdin/stdout."""
    global CURRENT_DIR
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *SHELL,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,  # merge stderr into stdout
            cwd=CURRENT_DIR,
            env=os.environ.copy(),
        )
        if proc is None:
            raise RuntimeError("Failed to spawn Windows terminal process.")
        
        logger.info(f"Windows shell spawned (PID {proc.pid})")

        async def read_stdout():
            """Forward shell output → WebSocket."""
            if proc.stdout is None: return
            while True:
                try:
                    chunk = await proc.stdout.read(4096)
                    if not chunk:
                        break
                    await websocket.send_text(chunk.decode('utf-8', errors='replace'))
                except Exception as e:
                    logger.error(f"stdout read error: {e}")
                    break

        read_task = asyncio.create_task(read_stdout())

        try:
            while True:
                raw = await websocket.receive_text()
                if proc.stdin is None: break
                try:
                    msg = json.loads(raw)
                    msg_type = msg.get("type")
                    if msg_type == "input":
                        data = msg.get("data", "")
                        # On Windows Ctrl+C comes as \x03 — send as-is
                        proc.stdin.write(data.encode('utf-8', errors='replace'))
                        await proc.stdin.drain()
                    # resize has no effect on cmd.exe but we acknowledge it silently
                except json.JSONDecodeError:
                    # Raw fallback
                    proc.stdin.write(raw.encode('utf-8', errors='replace'))
                    await proc.stdin.drain()
        except WebSocketDisconnect:
            logger.info("Windows terminal WS disconnected")
        finally:
            read_task.cancel()
    except Exception as e:
        logger.error(f"Windows terminal error: {e}")
        try:
            await websocket.send_text(f"\r\n\x1b[31m[ERROR] {e}\x1b[0m\r\n")
        except Exception:
            pass
    finally:
        if proc and proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass


async def _run_pty_terminal(websocket: WebSocket):
    """Unix PTY terminal (full TTY — handles colour, interactive programs)."""
    global CURRENT_DIR
    master_fd = None
    proc = None
    try:
        master_fd, slave_fd = pty.openpty()
        env = os.environ.copy()
        env.update({'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'})

        proc = subprocess.Popen(
            SHELL,
            stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
            cwd=CURRENT_DIR,
            env=env,
            start_new_session=True,
        )
        os.close(slave_fd)

        fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        logger.info(f"PTY shell spawned (PID {proc.pid}, fd {master_fd})")

        async def read_pty():
            while True:
                try:
                    data = os.read(master_fd, 4096)
                    if data:
                        await websocket.send_text(data.decode('utf-8', errors='replace'))
                except BlockingIOError:
                    await asyncio.sleep(0.02)
                    continue
                except OSError:
                    break
                await asyncio.sleep(0.01)

        read_task = asyncio.create_task(read_pty())
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                    if msg.get("type") == "input":
                        os.write(master_fd, msg.get("data", "").encode())
                    elif msg.get("type") == "resize":
                        s = struct.pack('HHHH',
                                        int(msg.get('rows', 24)),
                                        int(msg.get('cols', 80)), 0, 0)
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, s)
                except json.JSONDecodeError:
                    os.write(master_fd, raw.encode())
        except WebSocketDisconnect:
            logger.info("PTY terminal WS disconnected")
        finally:
            read_task.cancel()
    except Exception as e:
        logger.error(f"PTY terminal error: {e}")
        try:
            await websocket.send_text(f"\r\n\x1b[31m[ERROR] {e}\x1b[0m\r\n")
        except Exception:
            pass
    finally:
        if master_fd is not None:
            try:
                os.close(master_fd)
            except Exception:
                pass
        if proc and proc.poll() is None:
            proc.terminate()


async def _run_pipe_terminal(websocket: WebSocket):
    """Fallback pipe-based terminal for Unix systems without PTY."""
    global CURRENT_DIR
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *SHELL,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=CURRENT_DIR,
        )

        async def read_stdout():
            if proc.stdout is None: return
            while True:
                chunk = await proc.stdout.read(4096)
                if not chunk:
                    break
                await websocket.send_text(chunk.decode('utf-8', errors='replace'))

        read_task = asyncio.create_task(read_stdout())
        try:
            while True:
                raw = await websocket.receive_text()
                if proc.stdin is None: break
                try:
                    msg = json.loads(raw)
                    if msg.get("type") == "input":
                        proc.stdin.write(msg.get("data", "").encode())
                        await proc.stdin.drain()
                except json.JSONDecodeError:
                    proc.stdin.write(raw.encode())
                    await proc.stdin.drain()
        except WebSocketDisconnect:
            logger.info("Pipe terminal WS disconnected")
        finally:
            read_task.cancel()
    except Exception as e:
        logger.error(f"Pipe terminal error: {e}")
    finally:
        if proc and proc.returncode is None:
            proc.kill()

# --- WebSocket File System Events ---

@app.websocket("/ws/fs")
async def fs_websocket(websocket: WebSocket):
    global CURRENT_DIR
    await websocket.accept()
    
    try:
        async for changes in awatch(CURRENT_DIR):
            # Send a simple 'refresh' signal or more detailed info
            await websocket.send_json({"type": "refresh", "changes": list(changes)})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"FS Watcher error: {e}")

# --- REST Endpoints ---

@app.get("/api/files")
def list_files(path: Optional[str] = None):
    global CURRENT_DIR
    
    # If a new path is provided, update the global CURRENT_DIR
    if path and path != ".":
        target = os.path.abspath(path)
        if os.path.exists(target) and os.path.isdir(target):
            CURRENT_DIR = target
    
    base = CURRENT_DIR
    if not os.path.exists(base):
        return JSONResponse(status_code=404, content={"error": f"Path not found: {base}"})
    
    def build_tree(p):
        try:
            entries = os.listdir(p)
        except PermissionError:
            return None
            
        children = []
        for f in entries:
            # Skip hidden files
            if f.startswith('.') and f not in ['.env', '.gitignore']:
                continue
            
            full_path = os.path.join(p, f)
            if os.path.isdir(full_path):
                # Don't recurse too deep for the initial load if you want speed
                # but for this app we'll do it. Maybe limit to node_modules/git?
                if f in ['node_modules', '.git', '__pycache__', '.venv']:
                    children.append({
                        "id": full_path,
                        "name": f,
                        "type": "folder",
                        "path": full_path,
                        "children": [] # Lazy loading if needed, but here we just mark as opaque
                    })
                    continue
                    
                child_data = build_tree(full_path)
                if child_data:
                    children.append(child_data)
                else:
                    children.append({
                        "id": full_path,
                        "name": f,
                        "type": "folder",
                        "path": full_path,
                        "children": []
                    })
            else:
                children.append({
                    "id": full_path,
                    "name": f,
                    "type": "file",
                    "path": full_path
                })
        
        return {
            "id": p,
            "name": os.path.basename(p) if os.path.basename(p) else p,
            "type": "folder",
            "path": p,
            "children": sorted(children, key=lambda x: (x['type'] != 'folder', x['name'].lower()))
        }

    if os.path.isdir(base):
        result = build_tree(base)
        return result if result else JSONResponse(status_code=400, content={"error": "Cannot read directory"})
    else:
        return JSONResponse(status_code=400, content={"error": "Not a directory"})

@app.get("/api/file")
def read_file(path: str):
    if not os.path.exists(path):
        # Try relative to CURRENT_DIR
        path = os.path.join(CURRENT_DIR, path)
        if not os.path.exists(path):
            return JSONResponse(status_code=404, content={"error": "File not found"})
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"path": path, "content": content}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/file")
def save_file(req: FileSaveRequest):
    path = req.path
    if not os.path.isabs(path):
        path = os.path.join(CURRENT_DIR, path)
    
    try:
        # Create directories if they don't exist
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(req.content)
        return {"success": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/terminal")
def run_terminal(req: TerminalRequest):
    """Fallback for non-ws terminal or specific scripts"""
    global CURRENT_DIR
    command = req.command.strip()
    
    # Handle cd command specifically for the tracked dir
    if command.startswith("cd "):
        target_dir = command[3:].strip()
        new_dir = os.path.abspath(os.path.join(CURRENT_DIR, target_dir))
        if os.path.exists(new_dir) and os.path.isdir(new_dir):
            CURRENT_DIR = new_dir
            return {
                "stdout": "",
                "stderr": "",
                "returncode": 0,
                "cwd": CURRENT_DIR
            }
        else:
            return {
                "stdout": "",
                "stderr": f"cd: no such file or directory: {target_dir}\n",
                "returncode": 1,
                "cwd": CURRENT_DIR
            }

    try:
        result = subprocess.run(
            req.command, 
            shell=True, 
            capture_output=True, 
            text=True,
            cwd=CURRENT_DIR
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "cwd": CURRENT_DIR
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), path: Optional[str] = Form(None)):
    global CURRENT_DIR
    target_dir = path if path else CURRENT_DIR
    if not os.path.isabs(target_dir):
        target_dir = os.path.join(CURRENT_DIR, target_dir)
    
    if not os.path.exists(target_dir):
        os.makedirs(target_dir, exist_ok=True)
        
    file_path = os.path.join(target_dir, file.filename)
    try:
        with open(file_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        return {"success": True, "path": file_path}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/select-workspace-folder")
def select_workspace_folder():
    """Opens a native OS folder selection dialog."""
    try:
        import platform
        system = platform.system()
        path = None
        
        logger.info(f"Triggering folder selection for system: {system}")
        
        if system == "Darwin":  # macOS
            cmd = 'osascript -e "POSIX path of (choose folder with prompt \\"Select Workspace Folder\\")"'
            try:
                result = subprocess.check_output(cmd, shell=True, text=True).strip()
                if result:
                    path = result
            except subprocess.CalledProcessError:
                logger.warning("User cancelled the folder selection dialog.")
                return {"error": "Folder selection cancelled"}
                
        elif system == "Windows":
            # Use PowerShell to open a folder picker
            ps_script = """
            Add-Type -AssemblyName System.Windows.Forms;
            $f = New-Object System.Windows.Forms.FolderBrowserDialog;
            $f.Description = 'Select Workspace Folder';
            if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }
            """
            try:
                result = subprocess.check_output(["powershell", "-NoProfile", "-Command", ps_script], text=True).strip()
                if result:
                    path = result
            except Exception as e:
                logger.error(f"PowerShell folder picker failed: {e}")
                
        else:  # Linux (GTK/KDE)
            try:
                # Try zenity (GTK)
                path = subprocess.check_output(["zenity", "--file-selection", "--directory", "--title=Select Workspace Folder"], text=True).strip()
            except:
                try:
                    # Try kdialog (KDE)
                    path = subprocess.check_output(["kdialog", "--getexistingdirectory"], text=True).strip()
                except:
                    logger.error("No folder selection tool found on Linux (Zenity or Kdialog required)")
        
        if path:
            global CURRENT_DIR
            CURRENT_DIR = os.path.abspath(path)
            logger.info(f"Workspace root changed to: {CURRENT_DIR}")
            # Each WebSocket terminal spawns its own subprocess, so the new
            # CURRENT_DIR will be picked up automatically on the next connection.
            return {"path": CURRENT_DIR, "success": True}
        
        return {"error": "Folder selection cancelled or failed"}
    except Exception as e:
        logger.error(f"Workspace selection error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/open-folder")
def open_folder(req: Dict[str, str]):
    """Opens a directory in the native file explorer."""
    path = req.get("path")
    if not path or path == ".":
        path = CURRENT_DIR
    elif not os.path.isabs(path):
        path = os.path.join(CURRENT_DIR, path)
        
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Path not found"})
    
    try:
        import platform
        system = platform.system()
        logger.info(f"Opening folder: {path} on {system}")
        if system == "Darwin":  # macOS
            subprocess.run(["open", path])
        elif system == "Windows":
            os.startfile(path)
        else:  # Linux
            subprocess.run(["xdg-open", path])
        return {"success": True}
    except Exception as e:
        logger.error(f"Open folder error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/open-terminal")
def open_terminal():
    """Opens a native OS terminal in the current directory."""
    global CURRENT_DIR
    try:
        import platform
        system = platform.system()
        logger.info(f"Opening terminal in: {CURRENT_DIR} on {system}")
        
        if system == "Darwin":  # macOS
            # Use AppleScript to open Terminal and CD to the directory, ensuring it works even if already open
            script = f'tell application "Terminal" to do script "cd \'{CURRENT_DIR}\' && clear"'
            subprocess.run(["osascript", "-e", script])
            # Also bring Terminal to front
            subprocess.run(["osascript", "-e", 'tell application "Terminal" to activate'])
        elif system == "Windows":
            subprocess.run(["start", "cmd", "/K", f"cd /d {CURRENT_DIR}"], shell=True)
        else:  # Linux
            # Try common terminals
            terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm", "termite", "alacritty"]
            opened = False
            for term in terminals:
                try:
                    subprocess.Popen([term], cwd=CURRENT_DIR, start_new_session=True)
                    opened = True
                    break
                except FileNotFoundError:
                    continue
            if not opened:
                return JSONResponse(status_code=500, content={"error": "No terminal emulator found"})
        return {"success": True}
    except Exception as e:
        logger.error(f"Open terminal error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/agent")
def run_agent(req: AgentRequest):
    if not HAS_GENAI:
        return JSONResponse(status_code=503, content={"error": "Google Generative AI library not installed"})
    if not model:
        return JSONResponse(status_code=503, content={"error": "Gemini API Key not configured"})

    try:
        context = "You are a terminal expert. Translate natural language to shell commands."
        prompt = f"""
        {context}
        User Intent: {req.prompt}
        OS: {os.name}
        
        Return the result in this exact format:
        COMMAND: [single line command]
        EXPLANATION: [briefly explain what it does]
        SAFE: [YES/NO] (NO if it deletes files or changes system settings)
        """
        
        response = model.generate_content(prompt)
        lines = response.text.strip().split('\n')
        
        result = {}
        for line in lines:
            if line.startswith("COMMAND:"): result['cmd'] = line.replace("COMMAND:", "").strip()
            if line.startswith("EXPLANATION:"): result['desc'] = line.replace("EXPLANATION:", "").strip()
            if line.startswith("SAFE:"): result['safe'] = line.replace("SAFE:", "").strip()
            
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

