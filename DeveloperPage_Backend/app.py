from fastapi import FastAPI, Request, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os
import subprocess
import pty
import fcntl
import termios
import struct
import select
import asyncio
import signal
from typing import List, Optional, Dict
from watchfiles import awatch

# Try to import google.generativeai, handle if missing
try:
    import google.generativeai as genai
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

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

from dotenv import load_dotenv
load_dotenv()

# Global state
CURRENT_DIR = os.getcwd()
TERM_PROCESS = None
MASTER_FD = None
terminal_lock = asyncio.Lock()

# Configure GenAI if available
if HAS_GENAI:
# ... (rest of the code)

# ... (other code)

@app.websocket("/ws/terminal")
async def terminal_websocket(websocket: WebSocket):
    global CURRENT_DIR, MASTER_FD, TERM_PROCESS
    await websocket.accept()
    logger.info(f"Terminal WebSocket connected. CWD: {CURRENT_DIR}")
    
    async def ensure_terminal():
        global MASTER_FD, TERM_PROCESS
        async with terminal_lock:
            if MASTER_FD is None or TERM_PROCESS is None or TERM_PROCESS.poll() is not None:
                logger.info("Initializing new PTY terminal shell...")
                try:
                    master_fd, slave_fd = pty.openpty()
                    import platform
                    shell = "/bin/zsh" if platform.system() == "Darwin" else "/bin/bash"
                    
                    # Set environment to encourage clean output
                    env = os.environ.copy()
                    env['TERM'] = 'xterm-mono'
                    env['COLORTERM'] = ''
                    env['LANG'] = 'en_US.UTF-8'
                    env['PROMPT_EOL_MARK'] = '' # Disable Zsh partial line marker
                    
                    TERM_PROCESS = subprocess.Popen(
                        [shell],
                        stdin=slave_fd,
                        stdout=slave_fd,
                        stderr=slave_fd,
                        cwd=CURRENT_DIR,
                        env=env,
                        start_new_session=True
                    )
                    os.close(slave_fd)
                    
                    # Set non-blocking
                    fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
                    fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
                    MASTER_FD = master_fd
                    logger.info(f"PTY initialized with FD: {MASTER_FD}")
                except Exception as e:
                    logger.error(f"Failed to initialize PTY: {e}")
                    return False
            return True

    await ensure_terminal()

    async def read_from_pty():
        while True:
            try:
                # We need to read even if MASTER_FD is None (it shouldn't be for long)
                # But let's localise it
                fd = MASTER_FD
                if fd is not None:
                    try:
                        data = os.read(fd, 4096)
                        if data:
                            await websocket.send_text(data.decode('utf-8', errors='replace'))
                    except BlockingIOError:
                        await asyncio.sleep(0.02)
                        continue
                else:
                    await asyncio.sleep(0.1)
            except Exception as e:
                logger.error(f"Error reading from PTY: {e}")
                break
            await asyncio.sleep(0.01)

    read_task = asyncio.create_task(read_from_pty())
    
    try:
        while True:
            msg = await websocket.receive_text()
            if msg:
                if MASTER_FD is None:
                    await ensure_terminal()
                
                fd = MASTER_FD
                if fd is not None:
                    try:
                        os.write(fd, msg.encode())
                    except Exception as e:
                        logger.error(f"Error writing to PTY: {e}")
            await asyncio.sleep(0.01)
    except WebSocketDisconnect:
        logger.info("Terminal WebSocket disconnected")
    except Exception as e:
        logger.error(f"Terminal WebSocket error: {e}")
    finally:
        read_task.cancel()

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

@app.post("/api/open-folder")
def open_folder(req: Dict[str, str]):
    path = req.get("path")
    if not path:
        path = CURRENT_DIR
    elif not os.path.isabs(path):
        path = os.path.join(CURRENT_DIR, path)
        
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Path not found"})
    
    try:
        import platform
        system = platform.system()
        if system == "Darwin":  # macOS
            subprocess.run(["open", path])
        elif system == "Windows":
            os.startfile(path)
        else:  # Linux
            subprocess.run(["xdg-open", path])
        return {"success": True}
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
    try:
        import platform
        if platform.system() == "Darwin":  # macOS
            cmd = 'osascript -e "POSIX path of (choose folder with prompt \\"Select Workspace Folder\\")"'
            result = subprocess.check_output(cmd, shell=True, text=True).strip()
            if result:
                global CURRENT_DIR
                CURRENT_DIR = result
                # Kill old terminal process to spawn new one in new dir
                global TERM_PROCESS, MASTER_FD
                if TERM_PROCESS:
                    TERM_PROCESS.terminate()
                    TERM_PROCESS = None
                    MASTER_FD = None
                return {"path": result}
        return {"error": "Native selector only available on macOS"}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/open-terminal")
def open_terminal():
    global CURRENT_DIR
    try:
        import platform
        system = platform.system()
        if system == "Darwin":  # macOS
            subprocess.run(["open", "-a", "Terminal", CURRENT_DIR])
        elif system == "Windows":
            subprocess.run(["start", "cmd"], shell=True, cwd=CURRENT_DIR)
        else:  # Linux
            subprocess.run(["x-terminal-emulator"], cwd=CURRENT_DIR)
        return {"success": True}
    except Exception as e:
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

